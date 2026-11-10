import { listBoundedMembers, listBoundedRecords, listBoundedRepos, listBoundedSpaces } from "@/atproto/record-pages";
import { isCredentialRefused, SpaceCredential, SpaceCredentialError } from "@/atproto/space-credential-core";
import { AtprotoClient, isMissingXrpcResource, isSpaceAlreadyExists } from "@/atproto/xrpc";
import { CredentialCache } from "@/client/credentials";
import { withIdentityCache } from "@/client/identity";
import { MemoryStore } from "@/client/memory-store";
import { decodeCursor, encodeCursor } from "@/client/merge";
import type { SyncStore } from "@/client/store";
import { SyncCore } from "@/client/sync";
import type { ClientTransport } from "@/client/transport";
import { mapLimited } from "@/lib/map-limited";
import {
  canonicalParticipants,
  dmConversationUri,
  dmInboxUri,
  DM_INBOX_SKEY,
  isDid,
  parseDmConversationUri,
  parseDmMessageUri,
  parseSpaceUri,
  reactionRecordKey,
  spaceRecordUri,
  tidNow,
} from "@/protocol/keys";
import { validateDmDeclaration, validateDmHeaderMatchesRequest, validateSpaceRecord } from "@/protocol/registry";
import { advanceRenotifyState, isRenotifyDue, type DmRenotifyState } from "./backoff";
import { classifyRepoFailure } from "@/atproto/repo-failure";
import { memberspacePolicy, readMemberspacePolicy, withPublicWrite } from "@/atproto/space-policy";
import { isSenderAllowedUnderMode, modeForInboxPolicy, publicWriteForMode, type DmRequestMode } from "./request-policy";
import { COLLECTION, REPO_COLLECTION, SPACE_TYPE } from "@/protocol/nsids";

export type { DmRequestMode } from "./request-policy";

const FANOUT = 8;
const DEFAULT_PAGE = 100;
const MAX_PARTICIPANTS = 100;
const DM_DECLARATION_COLLECTION = REPO_COLLECTION.dmDeclaration;
const MAX_ALLOWLIST = 1_000;
const MAX_INBOX_SCAN = 10_000;
const EMPTY_SENDER_TTL_MS = 5 * 60_000;
const MAX_REQUESTS_PER_WRITER = 1_000;
const MAX_OWN_CONVERSATIONS = 10_000;

export type DmStore = {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
};

export type DmDeps = ClientTransport & {
  /** Small per-account settings: hidden requests, hidden conversations, re-notify state. */
  store: DmStore;
  /** Where conversation records are held between reads; memory by default, as DM content never goes to disk (D10). */
  syncStore?: SyncStore;
  limits?: { maxInboxScan?: number; maxRequestsPerWriter?: number; maxRecordsPerHalf?: number };
};

export type DmInboxState = { exists: boolean; mode: DmRequestMode; allowlist: string[] };

export type DmRequest = { convKey: string; participants: string[]; sender: string; createdAt: string; uri: string };

export type DmConversationSummary = { convKey: string; participants: string[] };

export type DmSkippedSenders = {
  oversizedWriters: string[];
  failedWriters: Array<{ did: string; reason: string }>;
  writerSetTruncated: boolean;
};
export type DmRequestScan = { requests: DmRequest[]; skipped: DmSkippedSenders };

export type DmDeliveryStatus = "delivered" | "noInbox" | "failed";
export type DmDelivery = { status: DmDeliveryStatus; message?: string };
export type DmStartResult = { convKey: string; participants: string[]; delivery: Record<string, DmDelivery> };

export type DmHalfStatus = "ok" | "missing" | "deleted" | "revoked";

export type DmMessage = { uri: string; ownerDid: string; rkey: string; text: string; createdAt: string; parent?: string };
export type DmReaction = { uri: string; ownerDid: string; subject: string; emoji: string; createdAt: string };

export type DmConversationPage = {
  messages: DmMessage[];
  reactions: DmReaction[];
  halves: Record<string, DmHalfStatus>;
  nextBefore?: string;
};

/**
 * The DM engine (M4). Isomorphic: it depends only on injected transports, so the same class runs in the browser (M5) and in
 * Node tests/acceptance against a fake or real PDS. It reads through the engine's credential cache and sync core: each half
 * of a conversation is one source, checked at its host on every read and listed only when its revision moved. Every write
 * is validated locally with `validateSpaceRecord` before being sent; every read record is validated after being fetched,
 * and invalid or wrong-repo records are dropped.
 */
export class DmClient {
  private readonly credentials: CredentialCache;
  private readonly sync: SyncCore;
  /** Active allowlist members the last scan found nothing to read from, and until when that answer is trusted. */
  private readonly emptySenders = new Map<string, number>();

  private readonly deps: DmDeps;

  constructor(deps: DmDeps) {
    const store = deps.syncStore ?? new MemoryStore();
    this.deps = { ...deps, ...withIdentityCache(deps, store) };
    this.credentials = new CredentialCache(this.deps);
    this.sync = new SyncCore({
      transport: this.deps, credentials: this.credentials, store,
      ...(deps.limits?.maxRecordsPerHalf ? { options: { maxRecordsPerCollection: deps.limits.maxRecordsPerHalf } } : {}),
    });
  }

  // --- Inbox and request policy (§3.6) ---

  async getInbox(): Promise<DmInboxState> {
    const detail = await this.inboxDetail();
    return { exists: detail.exists, mode: detail.mode, allowlist: detail.allowlist };
  }

  async enableDms(mode: DmRequestMode, allowlist: readonly string[] = []): Promise<void> {
    try {
      await this.deps.memberClient.procedure("com.atproto.space.createSpace", {
        spaceType: SPACE_TYPE.dmInbox, skey: DM_INBOX_SKEY,
        policy: memberspacePolicy({ publicWrite: publicWriteForMode(mode) }),
      });
    } catch (error) {
      if (!isSpaceAlreadyExists(error)) throw error;
      await this.applyRequestMode(mode);
    }
    // The seed list's active/dormant state comes from `mode` directly, not
    // from re-deriving the current mode through `allow`: a brand-new (or
    // just-reset) inbox has no members yet, which is indistinguishable from
    // "nobody" until someone is added, and would otherwise seed everyone as
    // dormant even when `mode` is "allowlist".
    if (allowlist.length > 0) await this.putAllowlistMembers(allowlist, mode !== "nobody");
    // Last, so that a failure here leaves a seeded inbox and running this again publishes it.
    await this.ensureDeclaration();
  }

  /**
   * Switches the write policy and reconciles membership so the allowlist
   * survives the switch: "nobody" deactivates every currently-allowed member
   * to a dormant (`write: false`) entry instead of removing them, and
   * "allowlist" reactivates every dormant entry. "everyone" only flips the
   * policy's `publicWrite`; member entries are left as they are, since they
   * become the allowlist again the moment the owner switches back. It also
   * repairs a missing or invalid inbox declaration (an inbox created before
   * senders needed one) without rewriting a valid one, so a settings change
   * does not become a public commit.
   */
  async setRequestMode(mode: DmRequestMode): Promise<void> {
    await this.applyRequestMode(mode);
    await this.ensureDeclaration();
  }

  private async applyRequestMode(mode: DmRequestMode): Promise<void> {
    this.emptySenders.clear();
    const space = dmInboxUri(this.deps.did);
    // updateSpace replaces the whole policy, so the current one is read and sent back with only publicWrite changed: another
    // client may have set an app allow-list or published records.
    const current = await this.deps.memberClient.query<{ policy?: unknown }>("com.atproto.space.getSpace", { space });
    await this.deps.memberClient.procedure("com.atproto.space.updateSpace", {
      space, policy: withPublicWrite(current.policy, publicWriteForMode(mode)),
    });
    if (mode === "everyone") return;
    const members = await listBoundedMembers(this.deps.memberClient, { space, maxMembers: MAX_ALLOWLIST });
    if (members.truncated) throw new Error("DM inbox allowlist exceeds the bounded scan limit.");
    const toFlip = mode === "nobody"
      ? members.members.filter((member) => member.write)
      : members.members.filter((member) => !member.write);
    const write = mode === "allowlist";
    await mapLimited(toFlip, FANOUT, (member) =>
      this.deps.memberClient.procedure("com.atproto.memberspace.putMember", { space, did: member.did, read: false, write }));
  }

  /** Adds `dids` to the allowlist. In "nobody" mode they're added dormant, so accepting a request there does not silently switch the mode. */
  async allow(dids: readonly string[]): Promise<void> {
    const detail = await this.inboxDetail();
    await this.putAllowlistMembers(dids, detail.mode !== "nobody");
  }

  private async putAllowlistMembers(dids: readonly string[], write: boolean): Promise<void> {
    this.emptySenders.clear();
    const space = dmInboxUri(this.deps.did);
    await mapLimited(canonicalizeDids(dids), FANOUT, (did) =>
      this.deps.memberClient.procedure("com.atproto.memberspace.putMember", { space, did, read: false, write }));
  }

  async disallow(dids: readonly string[]): Promise<void> {
    const space = dmInboxUri(this.deps.did);
    await mapLimited(canonicalizeDids(dids), FANOUT, (did) =>
      this.deps.memberClient.procedure("com.atproto.memberspace.removeMember", { space, did }));
  }

  // --- Discovery ---

  async listRequests(): Promise<DmRequest[]> {
    return (await this.scanRequests()).requests;
  }

  /**
   * One hostile sender must not take the whole inbox down: a sender with too many
   * records, or whose host cannot be read, is skipped and reported instead. The
   * PDS evicts a writer on `removeMember` or `putMember` with `write: false`, but not on `updateSpace`, so a tracked
   * stranger from an open period stays listed, and the scan bounds are the defense against it.
   */
  async scanRequests(): Promise<DmRequestScan> {
    const inboxSpace = dmInboxUri(this.deps.did);
    const inbox = await this.inboxDetail();
    const skipped: DmSkippedSenders = { oversizedWriters: [], failedWriters: [], writerSetTruncated: false };
    if (!inbox.exists) return { requests: [], skipped };
    const maxInboxScan = this.deps.limits?.maxInboxScan ?? MAX_INBOX_SCAN;
    const maxRequestsPerWriter = this.deps.limits?.maxRequestsPerWriter ?? MAX_REQUESTS_PER_WRITER;
    const credential = await this.credentials.get(inboxSpace);
    const repoClient = credential.client(await this.deps.resolvePds(this.deps.did));
    const writerScan = await listBoundedRepos(repoClient, { space: inboxSpace, maxRepos: maxInboxScan });
    skipped.writerSetTruncated = writerScan.truncated;
    const ownHalves = await this.ownConversationKeys();

    // The writer set is where senders are found, but it is not the only place: switching an allowlisted sender off evicts them
    // from it, and switching them back on does not list them again until they write again. Every active allowlist entry is
    // therefore a candidate too; one who never wrote simply has no repo to read.
    // A member with nothing to read can only gain something by writing, which lists them as a writer, so asking again is needed
    // only after the allowlist changed or the answer aged; otherwise every poll would cost one request per co-member.
    const writers = new Set(writerScan.repos.map((repo) => repo.did));
    const now = this.now();
    for (const [did, until] of this.emptySenders) if (until <= now || writers.has(did) || !inbox.activeAllowlist.includes(did)) this.emptySenders.delete(did);
    const candidates = [...writers, ...inbox.activeAllowlist.filter((did) => !writers.has(did) && !this.emptySenders.has(did))];
    const perWriter = await mapLimited(candidates, FANOUT, async (senderDid): Promise<DmRequest[]> => {
      const repo = { did: senderDid };
      // M0 §6 (f): updating the policy does not evict writers the PDS already
      // tracked, so every candidate must be filtered client-side.
      // A dormant ("nobody"-mode) member never counts as allowed here, only
      // an active one does.
      if (!isSenderAllowedUnderMode({ mode: inbox.mode, allowlist: inbox.activeAllowlist, senderDid: repo.did })) return [];
      // Only the reads from the sender's own host may fail softly. Our inbox
      // credential was proven by the writer listing above, so a per-sender 401
      // or 403 is that sender's failure; store and validation errors propagate.
      let page: Awaited<ReturnType<typeof listBoundedRecords>>;
      try {
        const writerClient = credential.client(await this.deps.resolvePds(repo.did));
        page = await listBoundedRecords(writerClient, {
          space: inboxSpace, repo: repo.did, collection: COLLECTION.dmRequest, maxRecords: maxRequestsPerWriter,
        });
      } catch (error) {
        if (isMissingXrpcResource(error)) { // an allowlisted sender who has not written has no repo yet
          this.emptySenders.set(senderDid, now + EMPTY_SENDER_TTL_MS);
          return [];
        }
        skipped.failedWriters.push({ did: repo.did, reason: error instanceof Error ? error.message.slice(0, 200) : "Unreadable sender." });
        return [];
      }
      if (page.truncated) {
        skipped.oversizedWriters.push(repo.did);
        return [];
      }
      if (page.records.length === 0) this.emptySenders.set(senderDid, now + EMPTY_SENDER_TTL_MS);
      const requests: DmRequest[] = [];
      for (const record of page.records) {
        const uri = spaceRecordUri(inboxSpace, repo.did, COLLECTION.dmRequest, record.rkey);
        const hidden = await this.deps.store.get(hiddenRequestKey(uri));
        if (hidden) continue;
        const validation = validateSpaceRecord(COLLECTION.dmRequest, record.value, {
          authorityDid: this.deps.did, spaceUri: inboxSpace, repoDid: repo.did, rkey: record.rkey,
        });
        if (!validation.valid) continue;
        const value = record.value as { convKey: string; participants: string[]; createdAt: string };
        if (ownHalves.has(value.convKey)) continue;
        requests.push({ convKey: value.convKey, participants: value.participants, sender: repo.did, createdAt: value.createdAt, uri });
      }
      return requests;
    });
    return { requests: perWriter.flat(), skipped };
  }

  async listConversations(): Promise<DmConversationSummary[]> {
    const halves = await listBoundedSpaces(this.deps.memberClient, { spaceType: SPACE_TYPE.dmConversation, maxSpaces: MAX_OWN_CONVERSATIONS });
    if (halves.truncated) throw new Error("Own DM conversation count exceeds the bounded scan limit.");
    const own = await mapLimited(halves.spaces, FANOUT, async (space): Promise<DmConversationSummary | null> => {
      const parsed = parseDmConversationUri(space.uri);
      if (!parsed) return null;
      const header = await this.getValidatedOwnHeader(space.uri);
      if (!header) return null;
      return { convKey: parsed.convKey, participants: header.participants };
    });
    return own.filter((summary): summary is DmConversationSummary => summary !== null);
  }

  // --- Starting and accepting ---

  async startConversation(dids: readonly string[]): Promise<DmStartResult> {
    const participants = canonicalParticipants([...dids, this.deps.did]);
    if (participants.length > MAX_PARTICIPANTS) throw new RangeError(`DM conversations are capped at ${MAX_PARTICIPANTS} participants.`);
    const existing = await this.findExistingHalf(participants);
    if (existing) return { convKey: existing, participants, delivery: {} };

    const convKey = tidNow(this.now());
    const half = dmConversationUri(this.deps.did, convKey);
    await this.createHalf(convKey);
    const others = participants.filter((did) => did !== this.deps.did);
    await mapLimited(others, FANOUT, (did) =>
      this.deps.memberClient.procedure("com.atproto.memberspace.putMember", { space: half, did, read: true, write: false }));
    const createdAt = new Date(this.now()).toISOString();
    await this.putValidated(half, COLLECTION.dmHeader, "self", { convKey, participants, createdAt });

    const delivery: Record<string, DmDelivery> = {};
    await mapLimited(others, FANOUT, async (recipient) => {
      delivery[recipient] = await this.sendRequest(recipient, convKey, participants, createdAt);
    });
    return { convKey, participants, delivery };
  }

  async accept(request: DmRequest): Promise<void> {
    const half = dmConversationUri(this.deps.did, request.convKey);
    await this.createHalf(request.convKey);
    const others = request.participants.filter((did) => did !== this.deps.did);
    await mapLimited(others, FANOUT, (did) =>
      this.deps.memberClient.procedure("com.atproto.memberspace.putMember", { space: half, did, read: true, write: false }));
    const createdAt = new Date(this.now()).toISOString();
    await this.putValidated(half, COLLECTION.dmHeader, "self", { convKey: request.convKey, participants: request.participants, createdAt });

    // §3.6: replying always allows the sender, regardless of the inbox's
    // current mode, so a later switch to "allowlist" does not lock out
    // someone whose request was already accepted.
    await this.allow([request.sender]);
  }

  async hideRequest(uri: string): Promise<void> {
    await this.deps.store.set(hiddenRequestKey(uri), "1");
  }

  // --- Messages and reactions ---

  async send(convKey: string, text: string, parent?: string): Promise<DmMessage> {
    const half = dmConversationUri(this.deps.did, convKey);
    const rkey = tidNow(this.now());
    const createdAt = new Date(this.now()).toISOString();
    const record: Record<string, unknown> = parent ? { text, createdAt, parent } : { text, createdAt };
    await this.putValidated(half, COLLECTION.dmMessage, rkey, record);
    return { uri: spaceRecordUri(half, this.deps.did, COLLECTION.dmMessage, rkey), ownerDid: this.deps.did, rkey, text, createdAt, parent };
  }

  async edit(uri: string, text: string): Promise<void> {
    const target = requireOwnMessage(uri, this.deps.did);
    const half = dmConversationUri(target.ownerDid, target.convKey);
    const existing = await this.getOwnRecord(half, COLLECTION.dmMessage, target.rkey);
    const createdAt = typeof existing?.createdAt === "string" ? existing.createdAt : new Date(this.now()).toISOString();
    // Records are open: fields another app added to the message are written back with the new text.
    await this.putValidated(half, COLLECTION.dmMessage, target.rkey, { ...existing, text, createdAt });
  }

  async delete(uri: string): Promise<void> {
    const target = requireOwnMessage(uri, this.deps.did);
    const half = dmConversationUri(target.ownerDid, target.convKey);
    await this.deps.memberClient.procedure("com.atproto.space.deleteRecord", {
      space: half, repo: this.deps.did, collection: COLLECTION.dmMessage, rkey: target.rkey,
    });
  }

  async react(subject: string, emoji: string): Promise<void> {
    const target = parseDmMessageUri(subject);
    if (!target) throw new Error("Invalid DM message subject.");
    const half = dmConversationUri(this.deps.did, target.convKey);
    const rkey = reactionRecordKey(subject, emoji, this.deps.did);
    const createdAt = new Date(this.now()).toISOString();
    await this.putValidated(half, COLLECTION.dmReaction, rkey, { subject, emoji, createdAt });
  }

  async unreact(subject: string, emoji: string): Promise<void> {
    const target = parseDmMessageUri(subject);
    if (!target) throw new Error("Invalid DM message subject.");
    const half = dmConversationUri(this.deps.did, target.convKey);
    const rkey = reactionRecordKey(subject, emoji, this.deps.did);
    await this.deps.memberClient.procedure("com.atproto.space.deleteRecord", {
      space: half, repo: this.deps.did, collection: COLLECTION.dmReaction, rkey,
    });
  }

  // --- Reading ---

  async readConversation(
    convKey: string,
    participants: readonly string[],
    options: { limit?: number; before?: string } = {},
  ): Promise<DmConversationPage> {
    const limit = options.limit ?? DEFAULT_PAGE;
    if (!Number.isSafeInteger(limit) || limit < 1) throw new RangeError("DM read limit must be a positive safe integer.");
    const canonical = canonicalParticipants(participants);

    const halves: Record<string, DmHalfStatus> = {};
    const readable = new Set<string>();

    await mapLimited(canonical, FANOUT, async (ownerDid) => {
      const half = dmConversationUri(ownerDid, convKey);
      let credential: SpaceCredential;
      try {
        credential = await this.credentials.get(half);
      } catch (error) {
        halves[ownerDid] = classifyHalfError(error);
        return;
      }
      let header: Record<string, unknown> | null;
      try {
        header = await this.readRecord(credential.client(await this.deps.resolvePds(ownerDid)), half, ownerDid, COLLECTION.dmHeader, "self");
      } catch (error) {
        // Another participant whose repo cannot be read (deactivated, taken down, unauthenticated, or on a host that is down) is an
        // unreadable half, not a reason to hide the other halves. A failure reading the caller's own half is the caller's own
        // problem (offline, their host down), not a participant's, and fails the read.
        if (isCredentialRefused(error)) this.credentials.drop(half);
        if (ownerDid === this.deps.did || !classifyRepoFailure(error)) throw error;
        halves[ownerDid] = "missing";
        return;
      }
      const headerValidation = header && validateSpaceRecord(COLLECTION.dmHeader, header, {
        authorityDid: ownerDid, spaceUri: half, repoDid: ownerDid, rkey: "self",
      });
      if (!header) {
        halves[ownerDid] = await this.classifyHeaderlessHalf(half);
        return;
      }
      if (!headerValidation?.valid || !validateDmHeaderMatchesRequest(header, { convKey, participants: canonical })) {
        halves[ownerDid] = "missing";
        return;
      }
      halves[ownerDid] = "ok";
      readable.add(ownerDid);
    });

    const sources = canonical.filter((ownerDid) => readable.has(ownerDid)).map((ownerDid) => ({ space: dmConversationUri(ownerDid, convKey), repo: ownerDid }));
    if (sources.length === 0) return { messages: [], reactions: [], halves };
    // Every read checks each half at its host, as DM halves have no writer-set hint; a half that stops being readable mid-read
    // shows nothing, like one that was unreadable at the header, and the caller's own half failing fails the read.
    const result = await this.sync.read({
      sources,
      window: COLLECTION.dmMessage,
      alongside: [COLLECTION.dmReaction],
      limit,
      before: decodeCursor(options.before),
      truthIntervalMs: 0,
      showSetAside: false,
      required: [this.deps.did],
      select: async (candidates, count) => candidates.filter((record) => validateSpaceRecord(COLLECTION.dmMessage, record.value, {
        authorityDid: record.repo, spaceUri: record.space, repoDid: record.repo, rkey: record.rkey, participants: canonical,
      }).valid).slice(0, count),
    });
    // A half set aside shows nothing; one whose reactions alone could not be read keeps its messages. Either is flagged.
    for (const aside of [...result.setAside, ...result.partial]) halves[aside.did] = "missing";
    if (result.cut.includes(COLLECTION.dmReaction)) throw new Error("DM reaction history exceeds the bounded scan limit.");
    if (result.cut.includes(COLLECTION.dmMessage)) throw new Error(`DM message history in one half exceeds the ${this.sync.options.maxRecordsPerCollection}-record read limit.`);
    const messages: DmMessage[] = result.items.map((record) => ({
      uri: record.uri, ownerDid: record.repo, rkey: record.rkey,
      text: String(record.value.text ?? ""), createdAt: String(record.value.createdAt ?? ""),
      parent: typeof record.value.parent === "string" ? record.value.parent : undefined,
    }));
    const messageUris = new Set(messages.map((message) => message.uri));
    const reactions: DmReaction[] = [];
    for (const source of sources) {
      if (halves[source.repo] !== "ok") continue;
      for (const record of await this.sync.store.records(source.space, COLLECTION.dmReaction, source.repo)) {
        const value = record.value as { subject?: unknown; emoji?: unknown; createdAt?: unknown };
        if (typeof value.subject !== "string" || !messageUris.has(value.subject)) continue;
        if (!validateSpaceRecord(COLLECTION.dmReaction, record.value, {
          authorityDid: source.repo, spaceUri: source.space, repoDid: source.repo, rkey: record.rkey, participants: canonical,
        }).valid) continue;
        reactions.push({ uri: record.uri, ownerDid: source.repo, subject: value.subject, emoji: String(value.emoji), createdAt: String(value.createdAt) });
      }
    }
    return { messages, reactions, halves, ...(result.next ? { nextBefore: encodeCursor(result.next) } : {}) };
  }

  // --- Leaving and deleting ---

  async leave(convKey: string): Promise<void> {
    const half = dmConversationUri(this.deps.did, convKey);
    const members = await listBoundedMembers(this.deps.memberClient, { space: half, maxMembers: MAX_PARTICIPANTS });
    if (members.truncated) throw new Error("DM conversation member count exceeds the bounded scan limit.");
    await mapLimited(members.members, FANOUT, (member) =>
      this.deps.memberClient.procedure("com.atproto.memberspace.removeMember", { space: half, did: member.did }));
    await this.deps.store.set(hiddenConversationKey(convKey), "1");
  }

  async deleteEverything(convKey: string): Promise<void> {
    const half = dmConversationUri(this.deps.did, convKey);
    await this.deps.memberClient.procedure("com.atproto.space.deleteSpace", { space: half });
  }

  // --- Re-notify (§3.3 step 7) ---

  async renotifyPending(): Promise<void> {
    const halves = await listBoundedSpaces(this.deps.memberClient, { spaceType: SPACE_TYPE.dmConversation, maxSpaces: MAX_OWN_CONVERSATIONS });
    if (halves.truncated) throw new Error("Own DM conversation count exceeds the bounded scan limit.");
    await mapLimited(halves.spaces, FANOUT, async (space) => {
      const header = await this.getValidatedOwnHeader(space.uri);
      if (!header) return;
      const others = header.participants.filter((did) => did !== this.deps.did);
      await mapLimited(others, FANOUT, (participant) => this.renotifyOne(header.convKey, participant, header.participants, header.createdAt));
    });
  }

  // --- Notifications ---

  async watch(spaces: readonly string[], serviceRef: string): Promise<Record<string, string>> {
    const entries = await mapLimited(spaces, FANOUT, async (space): Promise<readonly [string, string]> => {
      const parsed = parseSpaceUri(space);
      if (!parsed) throw new Error("Invalid DM space URI.");
      const credential = await this.credentials.get(space);
      const client = credential.client(await this.deps.resolvePds(parsed.authorityDid));
      const result = await client.procedure<{ space: string; service: string }, { expiresAt: string }>(
        "com.atproto.space.registerNotify", { space, service: serviceRef },
      );
      return [space, result.expiresAt];
    });
    return Object.fromEntries(entries);
  }

  // --- Internals ---

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now();
  }

  /**
   * `allowlist` is every member entry (active or dormant), the durable "who
   * did I allow" list; `activeAllowlist` is the write:true subset that
   * actually governs tracking under the current mode. See `setRequestMode`
   * and `allow` for how membership is kept dormant instead of removed.
   */
  private async inboxDetail(): Promise<{ exists: boolean; mode: DmRequestMode; allowlist: string[]; activeAllowlist: string[] }> {
    const space = dmInboxUri(this.deps.did);
    let reported: { policy?: unknown };
    try {
      reported = await this.deps.memberClient.query("com.atproto.space.getSpace", { space });
    } catch (error) {
      if (isSpaceNotFound(error)) return { exists: false, mode: "allowlist", allowlist: [], activeAllowlist: [] };
      throw error;
    }
    const settings = readMemberspacePolicy(reported.policy);
    if (!settings) throw new Error("The DM inbox is governed by an unexpected space policy.");
    const members = await listBoundedMembers(this.deps.memberClient, { space, maxMembers: MAX_ALLOWLIST });
    if (members.truncated) throw new Error("DM inbox allowlist exceeds the bounded scan limit.");
    const allowlist = members.members.map((member) => member.did).sort();
    const activeAllowlist = members.members.filter((member) => member.write).map((member) => member.did).sort();
    return { exists: true, mode: modeForInboxPolicy(settings.publicWrite, members.members), allowlist, activeAllowlist };
  }

  private async createHalf(convKey: string): Promise<void> {
    try {
      await this.deps.memberClient.procedure("com.atproto.space.createSpace", {
        spaceType: SPACE_TYPE.dmConversation, skey: convKey,
        policy: memberspacePolicy(),
      });
    } catch (error) {
      if (!isSpaceAlreadyExists(error)) throw error;
    }
  }

  private async putValidated(space: string, collection: string, rkey: string, record: Record<string, unknown>): Promise<void> {
    const parsed = parseSpaceUri(space);
    if (!parsed) throw new Error("Invalid DM space URI.");
    const value = { $type: collection, ...record };
    const validation = validateSpaceRecord(collection, value, {
      authorityDid: parsed.authorityDid, spaceUri: space, repoDid: this.deps.did, rkey,
    });
    if (!validation.valid) throw new Error(`Invalid ${collection} record: ${validation.reason}`);
    await this.deps.memberClient.procedure("com.atproto.space.putRecord", { space, repo: this.deps.did, collection, rkey, record: value });
  }

  /**
   * The pinned PDS accepts a `putRecord` into a space that does not exist (the record lands in the sender's own
   * repo and the authority's `SpaceNotFound` is swallowed), so `putRecord`'s outcome cannot say whether the
   * recipient enabled DMs. Asking the inbox for a credential cannot either: the authority answers a user the
   * policy does not authorize with the same `SpaceNotFound` it gives for a missing space. The recipient's public
   * declaration (`publishDeclaration`) can.
   */
  private async sendRequest(recipientDid: string, convKey: string, participants: readonly string[], createdAt: string): Promise<DmDelivery> {
    const inbox = dmInboxUri(recipientDid);
    const record = { $type: COLLECTION.dmRequest, convKey, participants, createdAt };
    const validation = validateSpaceRecord(COLLECTION.dmRequest, record, {
      authorityDid: recipientDid, spaceUri: inbox, repoDid: this.deps.did, rkey: convKey,
    });
    if (!validation.valid) return { status: "failed", message: validation.reason };
    try {
      if (!(await this.hasDeclaration(recipientDid))) return { status: "noInbox" };
    } catch (error) {
      return { status: "failed", message: error instanceof Error ? error.message : String(error) };
    }
    try {
      await this.deps.memberClient.procedure("com.atproto.space.putRecord", {
        space: inbox, repo: this.deps.did, collection: COLLECTION.dmRequest, rkey: convKey, record,
      });
      return { status: "delivered" };
    } catch (error) {
      return { status: "failed", message: error instanceof Error ? error.message : String(error) };
    }
  }

  /**
   * Publishes the declaration when the inbox exists but the account's own public repo lacks it: an inbox created before senders
   * needed one, or a publish that failed. One public read when there is nothing to repair, so the DM view runs it once per session.
   */
  async ensureDeclaration(): Promise<void> {
    if (!(await this.hasDeclaration(this.deps.did))) await this.publishDeclaration();
  }

  /** Publishes, in the account's own public repo, that it runs an inbox. Idempotent; a sender reads it before writing a request. */
  private async publishDeclaration(): Promise<void> {
    await this.deps.memberClient.procedure("com.atproto.repo.putRecord", {
      repo: this.deps.did, collection: DM_DECLARATION_COLLECTION, rkey: "self",
      record: { $type: DM_DECLARATION_COLLECTION, createdAt: new Date(this.now()).toISOString() },
    });
  }

  /** Whether `did` published an inbox declaration. A public read of their own PDS, so it needs neither a session nor a credential. */
  private async hasDeclaration(did: string): Promise<boolean> {
    const pds = await this.deps.resolvePds(did);
    const reader = new AtprotoClient((path, init) => this.deps.fetchEndpoint(new Request(new URL(path, pds), { ...init, redirect: "error" })));
    try {
      const record = await reader.query<{ uri?: unknown; value?: unknown } | null>("com.atproto.repo.getRecord", { repo: did, collection: DM_DECLARATION_COLLECTION, rkey: "self" });
      // Only the record itself counts: a 2xx with any other body, or a malformed record, is not a declaration.
      return record?.uri === `at://${did}/${DM_DECLARATION_COLLECTION}/self` && validateDmDeclaration(record.value).valid;
    } catch (error) {
      if (isRecordNotFound(error)) return false;
      throw error;
    }
  }

  /** A cached credential outlives a deleted half, so a missing header is re-checked with a fresh mint to tell "left" from "not replied". */
  private async classifyHeaderlessHalf(half: string): Promise<DmHalfStatus> {
    this.credentials.drop(half);
    try {
      await this.credentials.get(half);
      return "missing";
    } catch (error) {
      return error instanceof SpaceCredentialError ? classifyHalfError(error) : "missing";
    }
  }

  private async findExistingHalf(participants: readonly string[]): Promise<string | null> {
    const halves = await listBoundedSpaces(this.deps.memberClient, { spaceType: SPACE_TYPE.dmConversation, maxSpaces: MAX_OWN_CONVERSATIONS });
    if (halves.truncated) throw new Error("Own DM conversation count exceeds the bounded scan limit.");
    for (const space of halves.spaces) {
      const header = await this.getValidatedOwnHeader(space.uri);
      if (header && sameParticipants(header.participants, participants)) return header.convKey;
    }
    return null;
  }

  /** Fetches the caller's own header for `space` and validates it, returning `null` for a missing or invalid record. */
  private async getValidatedOwnHeader(space: string): Promise<{ convKey: string; participants: string[]; createdAt: string } | null> {
    const header = await this.getOwnRecord(space, COLLECTION.dmHeader, "self");
    if (!header) return null;
    const validation = validateSpaceRecord(COLLECTION.dmHeader, header, {
      authorityDid: this.deps.did, spaceUri: space, repoDid: this.deps.did, rkey: "self",
    });
    if (!validation.valid) return null;
    const value = header as { convKey: string; participants: string[]; createdAt: string };
    return { convKey: value.convKey, participants: value.participants, createdAt: value.createdAt };
  }

  private async ownConversationKeys(): Promise<Set<string>> {
    const halves = await listBoundedSpaces(this.deps.memberClient, { spaceType: SPACE_TYPE.dmConversation, maxSpaces: MAX_OWN_CONVERSATIONS });
    if (halves.truncated) throw new Error("Own DM conversation count exceeds the bounded scan limit.");
    return new Set(halves.spaces.flatMap((space) => {
      const parsed = parseDmConversationUri(space.uri);
      return parsed ? [parsed.convKey] : [];
    }));
  }

  private async getOwnRecord(space: string, collection: string, rkey: string): Promise<Record<string, unknown> | null> {
    let credential: SpaceCredential;
    try {
      credential = await this.credentials.get(space);
    } catch (error) {
      if (error instanceof SpaceCredentialError) return null;
      throw error;
    }
    const client = credential.client(await this.deps.resolvePds(this.deps.did));
    return this.readRecord(client, space, this.deps.did, collection, rkey);
  }

  private async readRecord(client: AtprotoClient, space: string, repo: string, collection: string, rkey: string): Promise<Record<string, unknown> | null> {
    try {
      const record = await client.query<{ value: Record<string, unknown> }>("com.atproto.space.getRecord", { space, repo, collection, rkey });
      return record.value;
    } catch (error) {
      if (isRecordNotFound(error)) return null;
      throw error;
    }
  }

  private async renotifyOne(convKey: string, participant: string, participants: readonly string[], createdAt: string): Promise<void> {
    const pending = await this.isPending(participant, convKey);
    if (!pending) return;
    const key = `renotify:${convKey}:${participant}`;
    const now = this.now();
    const raw = await this.deps.store.get(key);
    const anchor = Date.parse(createdAt);
    const state: DmRenotifyState = raw ? JSON.parse(raw) : { attempts: 0, lastAttemptAt: Number.isFinite(anchor) ? anchor : now };
    if (!isRenotifyDue(state, now)) return;
    const status = await this.sendRequest(participant, convKey, participants, createdAt);
    if (status.status !== "failed") await this.deps.store.set(key, JSON.stringify(advanceRenotifyState(state, now)));
  }

  private async isPending(participant: string, convKey: string): Promise<boolean> {
    try {
      await this.credentials.get(dmConversationUri(participant, convKey));
      return false; // a half exists: they replied.
    } catch (error) {
      // A half that was never created answers SpaceNotFound, and so does one whose owner replied and then removed this
      // account's access; both read as pending, and the re-sends that costs are bounded by the backoff schedule. A deleted
      // half (SpaceDeleted) means they left, so it is not pending.
      if (error instanceof SpaceCredentialError) return error.code === "SpaceNotFound";
      throw error;
    }
  }
}

function classifyHalfError(error: unknown): DmHalfStatus {
  if (error instanceof SpaceCredentialError) {
    if (error.code === "SpaceNotFound") return "missing";
    if (error.code === "SpaceDeleted") return "deleted";
    return "revoked";
  }
  throw error;
}

function requireOwnMessage(uri: string, did: string): { ownerDid: string; convKey: string; repo: string; rkey: string } {
  const target = parseDmMessageUri(uri);
  if (!target || target.repo !== did) throw new Error("Can only modify your own DM messages.");
  return target;
}

function canonicalizeDids(dids: readonly string[]): string[] {
  const unique = [...new Set(dids)];
  if (!unique.every(isDid)) throw new TypeError("Invalid DID in allow/disallow list.");
  return unique;
}

function sameParticipants(left: readonly unknown[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((did, index) => did === right[index]);
}

function hiddenRequestKey(uri: string): string {
  return `hidden-request:${uri}`;
}

function hiddenConversationKey(convKey: string): string {
  return `hidden-conversation:${convKey}`;
}

function isSpaceNotFound(error: unknown): boolean {
  return hasErrorCode(error, "SpaceNotFound");
}

function isRecordNotFound(error: unknown): boolean {
  return hasErrorCode(error, "RecordNotFound");
}

function hasErrorCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code: unknown }).code === code;
}
