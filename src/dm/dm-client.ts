import type { DpopKey } from "@/atproto/dpop";
import { listBoundedMembers, listBoundedRecords, listBoundedRepos, listBoundedSpaces, assertBoundedRecordPage } from "@/atproto/record-pages";
import { mintSpaceCredentialWith, SpaceCredential, SpaceCredentialError } from "@/atproto/space-credential-core";
import type { AtprotoClient } from "@/atproto/xrpc";
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
import { validateDmHeaderMatchesRequest, validateSpaceRecord } from "@/protocol/records";
import { advanceRenotifyState, isRenotifyDue, type DmRenotifyState } from "./backoff";
import { mergeDmHalves, type DmHalfPage } from "./merge";
import { isSenderAllowedUnderMode, modeForInboxPolicy, writePolicyForMode, type DmRequestMode } from "./request-policy";

export type { DmRequestMode } from "./request-policy";

const FANOUT = 8;
const DEFAULT_PAGE = 100;
const MAX_PARTICIPANTS = 100;
const MAX_ALLOWLIST = 1_000;
const MAX_INBOX_SCAN = 10_000;
const MAX_REQUESTS_PER_WRITER = 1_000;
const MAX_OWN_CONVERSATIONS = 10_000;
const MAX_REACTIONS_PER_HALF = 20_000;
const MAX_MERGE_ROUNDS = 10_000;
const CREDENTIAL_RENEW_BEFORE_MS = 60_000;

export type DmStore = {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
};

export type DmDeps = {
  did: string;
  memberClient: AtprotoClient;
  resolvePds(did: string): Promise<string>;
  fetchEndpoint(request: Request): Promise<Response>;
  generateKey(): Promise<DpopKey>;
  store: DmStore;
  now?: () => number;
  limits?: { maxInboxScan?: number; maxRequestsPerWriter?: number };
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
 * The DM engine (M4). Isomorphic: it depends only on injected transports
 * (`memberClient`, `resolvePds`, `fetchEndpoint`, `generateKey`, `store`), so
 * the same class runs in the browser (M5) and in Node tests/acceptance against
 * a fake or real PDS. Every write is validated locally with
 * `validateSpaceRecord` before being sent; every read record is validated
 * after being fetched, and invalid or wrong-repo records are dropped.
 */
export class DmClient {
  private readonly credentials = new Map<string, Promise<SpaceCredential>>();

  constructor(private readonly deps: DmDeps) {}

  // --- Inbox and request policy (§3.6) ---

  async getInbox(): Promise<DmInboxState> {
    const detail = await this.inboxDetail();
    return { exists: detail.exists, mode: detail.mode, allowlist: detail.allowlist };
  }

  async enableDms(mode: DmRequestMode, allowlist: readonly string[] = []): Promise<void> {
    try {
      await this.deps.memberClient.procedure("com.atproto.simplespace.createSpace", {
        type: "org.slack.dm.inbox", skey: DM_INBOX_SKEY,
        readPolicy: { $type: "com.atproto.simplespace.defs#memberListPolicy" },
        writePolicy: { $type: policyType(writePolicyForMode(mode)) },
        appAccess: { $type: "com.atproto.simplespace.defs#open" },
      });
    } catch (error) {
      if (!isAlreadyExists(error)) throw error;
      await this.setRequestMode(mode);
    }
    // The seed list's active/dormant state comes from `mode` directly, not
    // from re-deriving the current mode through `allow`: a brand-new (or
    // just-reset) inbox has no members yet, which is indistinguishable from
    // "nobody" until someone is added, and would otherwise seed everyone as
    // dormant even when `mode` is "allowlist".
    if (allowlist.length > 0) await this.putAllowlistMembers(allowlist, mode !== "nobody");
  }

  /**
   * Switches the write policy and reconciles membership so the allowlist
   * survives the switch: "nobody" deactivates every currently-allowed member
   * to a dormant (`write: false`) entry instead of removing them, and
   * "allowlist" reactivates every dormant entry. "everyone" only flips the
   * write policy to public; member entries are left as they are, since they
   * become the allowlist again the moment the owner switches back.
   */
  async setRequestMode(mode: DmRequestMode): Promise<void> {
    const space = dmInboxUri(this.deps.did);
    await this.deps.memberClient.procedure("com.atproto.simplespace.updateSpace", {
      space, writePolicy: { $type: policyType(writePolicyForMode(mode)) },
    });
    if (mode === "everyone") return;
    const members = await listBoundedMembers(this.deps.memberClient, { space, maxMembers: MAX_ALLOWLIST });
    if (members.truncated) throw new Error("DM inbox allowlist exceeds the bounded scan limit.");
    const toFlip = mode === "nobody"
      ? members.members.filter((member) => member.write)
      : members.members.filter((member) => !member.write);
    const write = mode === "allowlist";
    await mapLimited(toFlip, FANOUT, (member) =>
      this.deps.memberClient.procedure("com.atproto.simplespace.putMember", { space, did: member.did, read: false, write }));
  }

  /** Adds `dids` to the allowlist. In "nobody" mode they're added dormant, so accepting a request there does not silently switch the mode. */
  async allow(dids: readonly string[]): Promise<void> {
    const detail = await this.inboxDetail();
    await this.putAllowlistMembers(dids, detail.mode !== "nobody");
  }

  private async putAllowlistMembers(dids: readonly string[], write: boolean): Promise<void> {
    const space = dmInboxUri(this.deps.did);
    await mapLimited(canonicalizeDids(dids), FANOUT, (did) =>
      this.deps.memberClient.procedure("com.atproto.simplespace.putMember", { space, did, read: false, write }));
  }

  async disallow(dids: readonly string[]): Promise<void> {
    const space = dmInboxUri(this.deps.did);
    await mapLimited(canonicalizeDids(dids), FANOUT, (did) =>
      this.deps.memberClient.procedure("com.atproto.simplespace.removeMember", { space, did }));
  }

  // --- Discovery ---

  async listRequests(): Promise<DmRequest[]> {
    return (await this.scanRequests()).requests;
  }

  /**
   * One hostile sender must not take the whole inbox down: a sender with too many
   * records, or whose host cannot be read, is skipped and reported instead. The
   * PDS never evicts tracked writers, so the scan bounds are the only defense here.
   */
  async scanRequests(): Promise<DmRequestScan> {
    const inboxSpace = dmInboxUri(this.deps.did);
    const inbox = await this.inboxDetail();
    const skipped: DmSkippedSenders = { oversizedWriters: [], failedWriters: [], writerSetTruncated: false };
    if (!inbox.exists) return { requests: [], skipped };
    const maxInboxScan = this.deps.limits?.maxInboxScan ?? MAX_INBOX_SCAN;
    const maxRequestsPerWriter = this.deps.limits?.maxRequestsPerWriter ?? MAX_REQUESTS_PER_WRITER;
    const credential = await this.credentialFor(inboxSpace);
    const repoClient = credential.client(await this.deps.resolvePds(this.deps.did));
    const writerScan = await listBoundedRepos(repoClient, { space: inboxSpace, maxRepos: maxInboxScan });
    skipped.writerSetTruncated = writerScan.truncated;
    const ownHalves = await this.ownConversationKeys();

    const perWriter = await mapLimited(writerScan.repos, FANOUT, async (repo): Promise<DmRequest[]> => {
      // M0 §6 (f): tightening or emptying the policy does not evict writers the
      // PDS already tracked, so every candidate must be filtered client-side.
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
          space: inboxSpace, repo: repo.did, collection: "org.slack.dm.request", maxRecords: maxRequestsPerWriter,
        });
      } catch (error) {
        skipped.failedWriters.push({ did: repo.did, reason: error instanceof Error ? error.message.slice(0, 200) : "Unreadable sender." });
        return [];
      }
      if (page.truncated) {
        skipped.oversizedWriters.push(repo.did);
        return [];
      }
      const requests: DmRequest[] = [];
      for (const record of page.records) {
        const uri = spaceRecordUri(inboxSpace, repo.did, "org.slack.dm.request", record.rkey);
        const hidden = await this.deps.store.get(hiddenRequestKey(uri));
        if (hidden) continue;
        const validation = validateSpaceRecord("org.slack.dm.request", record.value, {
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
    const halves = await listBoundedSpaces(this.deps.memberClient, { type: "org.slack.dm.conversation", maxSpaces: MAX_OWN_CONVERSATIONS });
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
      this.deps.memberClient.procedure("com.atproto.simplespace.putMember", { space: half, did, read: true, write: false }));
    const createdAt = new Date(this.now()).toISOString();
    await this.putValidated(half, "org.slack.dm.header", "self", { convKey, participants, createdAt });

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
      this.deps.memberClient.procedure("com.atproto.simplespace.putMember", { space: half, did, read: true, write: false }));
    const createdAt = new Date(this.now()).toISOString();
    await this.putValidated(half, "org.slack.dm.header", "self", { convKey: request.convKey, participants: request.participants, createdAt });

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
    await this.putValidated(half, "org.slack.dm.message", rkey, record);
    return { uri: spaceRecordUri(half, this.deps.did, "org.slack.dm.message", rkey), ownerDid: this.deps.did, rkey, text, createdAt, parent };
  }

  async edit(uri: string, text: string): Promise<void> {
    const target = requireOwnMessage(uri, this.deps.did);
    const half = dmConversationUri(target.ownerDid, target.convKey);
    const existing = await this.getOwnRecord(half, "org.slack.dm.message", target.rkey);
    const createdAt = typeof existing?.createdAt === "string" ? existing.createdAt : new Date(this.now()).toISOString();
    const parent = typeof existing?.parent === "string" ? existing.parent : undefined;
    const record: Record<string, unknown> = parent ? { text, createdAt, parent } : { text, createdAt };
    await this.putValidated(half, "org.slack.dm.message", target.rkey, record);
  }

  async delete(uri: string): Promise<void> {
    const target = requireOwnMessage(uri, this.deps.did);
    const half = dmConversationUri(target.ownerDid, target.convKey);
    await this.deps.memberClient.procedure("com.atproto.space.deleteRecord", {
      space: half, repo: this.deps.did, collection: "org.slack.dm.message", rkey: target.rkey,
    });
  }

  async react(subject: string, emoji: string): Promise<void> {
    const target = parseDmMessageUri(subject);
    if (!target) throw new Error("Invalid DM message subject.");
    const half = dmConversationUri(this.deps.did, target.convKey);
    const rkey = reactionRecordKey(subject, emoji, this.deps.did);
    const createdAt = new Date(this.now()).toISOString();
    await this.putValidated(half, "org.slack.dm.reaction", rkey, { subject, emoji, createdAt });
  }

  async unreact(subject: string, emoji: string): Promise<void> {
    const target = parseDmMessageUri(subject);
    if (!target) throw new Error("Invalid DM message subject.");
    const half = dmConversationUri(this.deps.did, target.convKey);
    const rkey = reactionRecordKey(subject, emoji, this.deps.did);
    await this.deps.memberClient.procedure("com.atproto.space.deleteRecord", {
      space: half, repo: this.deps.did, collection: "org.slack.dm.reaction", rkey,
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
    const credentials = new Map<string, SpaceCredential>();
    const pages = new Map<string, DmHalfPage>();

    await mapLimited(canonical, FANOUT, async (ownerDid) => {
      const half = dmConversationUri(ownerDid, convKey);
      let credential: SpaceCredential;
      try {
        credential = await this.credentialFor(half);
      } catch (error) {
        halves[ownerDid] = classifyHalfError(error);
        return;
      }
      const client = credential.client(await this.deps.resolvePds(ownerDid));
      const header = await this.readRecord(client, half, ownerDid, "org.slack.dm.header", "self");
      const headerValidation = header && validateSpaceRecord("org.slack.dm.header", header, {
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
      credentials.set(ownerDid, credential);
      pages.set(ownerDid, { ownerDid, records: [], exhausted: false });
    });

    const cursors = new Map<string, string | undefined>();
    const seenCursors = new Map<string, Set<string>>();
    let merge = mergeDmHalves([...pages.values()], { limit, before: options.before });
    for (let round = 0; merge.needsMore.length > 0; round += 1) {
      if (round >= MAX_MERGE_ROUNDS) throw new Error("DM conversation merge exceeded the bounded round limit.");
      const perHalfLimit = Math.max(1, Math.min(100, Math.ceil(limit / merge.needsMore.length)));
      await mapLimited(merge.needsMore, FANOUT, async (ownerDid) => {
        const half = dmConversationUri(ownerDid, convKey);
        const client = credentials.get(ownerDid)!.client(await this.deps.resolvePds(ownerDid));
        const cursor = cursors.get(ownerDid);
        const usedCursors = seenCursors.get(ownerDid) ?? new Set<string>();
        seenCursors.set(ownerDid, usedCursors);
        if (cursor && usedCursors.has(cursor)) throw new Error("PDS record pagination did not advance.");
        if (cursor) usedCursors.add(cursor);
        const page = await client.query<{ cursor?: string; records: Array<{ rkey: string; value?: Record<string, unknown> }> }>(
          "com.atproto.space.listRecords", { space: half, repo: ownerDid, collection: "org.slack.dm.message", cursor, limit: perHalfLimit },
        );
        assertBoundedRecordPage(page, { collection: "org.slack.dm.message", limit: perHalfLimit, cursor, seenCursors: usedCursors });
        const existing = pages.get(ownerDid)!;
        const validRecords = page.records.flatMap((record) => {
          if (!record.value) return [];
          const validation = validateSpaceRecord("org.slack.dm.message", record.value, {
            authorityDid: ownerDid, spaceUri: half, repoDid: ownerDid, rkey: record.rkey, participants: canonical,
          });
          if (!validation.valid) return [];
          return [{ uri: spaceRecordUri(half, ownerDid, "org.slack.dm.message", record.rkey), rkey: record.rkey, ownerDid, value: record.value }];
        });
        pages.set(ownerDid, { ownerDid, records: [...existing.records, ...validRecords], exhausted: !page.cursor });
        cursors.set(ownerDid, page.cursor);
      });
      merge = mergeDmHalves([...pages.values()], { limit, before: options.before });
    }

    const messages: DmMessage[] = merge.messages.map((record) => ({
      uri: record.uri, ownerDid: record.ownerDid, rkey: record.rkey,
      text: String(record.value.text ?? ""), createdAt: String(record.value.createdAt ?? ""),
      parent: typeof record.value.parent === "string" ? record.value.parent : undefined,
    }));
    const messageUris = new Set(messages.map((message) => message.uri));
    const reactions = await this.readReactions(convKey, canonical, credentials, messageUris);
    return { messages, reactions, halves, nextBefore: merge.nextBefore };
  }

  // --- Leaving and deleting ---

  async leave(convKey: string): Promise<void> {
    const half = dmConversationUri(this.deps.did, convKey);
    const members = await listBoundedMembers(this.deps.memberClient, { space: half, maxMembers: MAX_PARTICIPANTS });
    if (members.truncated) throw new Error("DM conversation member count exceeds the bounded scan limit.");
    await mapLimited(members.members, FANOUT, (member) =>
      this.deps.memberClient.procedure("com.atproto.simplespace.removeMember", { space: half, did: member.did }));
    await this.deps.store.set(hiddenConversationKey(convKey), "1");
  }

  async deleteEverything(convKey: string): Promise<void> {
    const half = dmConversationUri(this.deps.did, convKey);
    await this.deps.memberClient.procedure("com.atproto.simplespace.deleteSpace", { space: half });
  }

  // --- Re-notify (§3.3 step 7) ---

  async renotifyPending(): Promise<void> {
    const halves = await listBoundedSpaces(this.deps.memberClient, { type: "org.slack.dm.conversation", maxSpaces: MAX_OWN_CONVERSATIONS });
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
      const credential = await this.credentialFor(space);
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
    let policy: { writePolicy: { $type?: string } };
    try {
      policy = await this.deps.memberClient.query("com.atproto.simplespace.getSpace", { space });
    } catch (error) {
      if (isSpaceNotFound(error)) return { exists: false, mode: "allowlist", allowlist: [], activeAllowlist: [] };
      throw error;
    }
    const writePolicy = policy.writePolicy?.$type === "com.atproto.simplespace.defs#publicPolicy" ? "public" : "memberList";
    const members = await listBoundedMembers(this.deps.memberClient, { space, maxMembers: MAX_ALLOWLIST });
    if (members.truncated) throw new Error("DM inbox allowlist exceeds the bounded scan limit.");
    const allowlist = members.members.map((member) => member.did).sort();
    const activeAllowlist = members.members.filter((member) => member.write).map((member) => member.did).sort();
    return { exists: true, mode: modeForInboxPolicy(writePolicy, members.members), allowlist, activeAllowlist };
  }

  private async credentialFor(space: string): Promise<SpaceCredential> {
    const pending = this.credentials.get(space);
    if (pending) {
      const credential = await pending;
      if (credential.expiresAt - this.now() > CREDENTIAL_RENEW_BEFORE_MS) return credential;
      if (this.credentials.get(space) === pending) this.credentials.delete(space);
    }
    const minted = mintSpaceCredentialWith(this.deps, space);
    this.credentials.set(space, minted);
    try {
      return await minted;
    } catch (error) {
      if (this.credentials.get(space) === minted) this.credentials.delete(space);
      throw error;
    }
  }

  private async createHalf(convKey: string): Promise<void> {
    try {
      await this.deps.memberClient.procedure("com.atproto.simplespace.createSpace", {
        type: "org.slack.dm.conversation", skey: convKey,
        readPolicy: { $type: "com.atproto.simplespace.defs#memberListPolicy" },
        writePolicy: { $type: "com.atproto.simplespace.defs#memberListPolicy" },
        appAccess: { $type: "com.atproto.simplespace.defs#open" },
      });
    } catch (error) {
      if (!isAlreadyExists(error)) throw error;
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
   * recipient enabled DMs. Minting a credential for the inbox can: `SpaceNotFound` means no inbox, while
   * `UserNotAuthorized` means it exists and this sender simply is not a member.
   */
  private async sendRequest(recipientDid: string, convKey: string, participants: readonly string[], createdAt: string): Promise<DmDelivery> {
    const inbox = dmInboxUri(recipientDid);
    const record = { $type: "org.slack.dm.request", convKey, participants, createdAt };
    const validation = validateSpaceRecord("org.slack.dm.request", record, {
      authorityDid: recipientDid, spaceUri: inbox, repoDid: this.deps.did, rkey: convKey,
    });
    if (!validation.valid) return { status: "failed", message: validation.reason };
    try {
      await this.credentialFor(inbox);
    } catch (error) {
      if (isMissingSpace(error)) return { status: "noInbox" };
      if (!(error instanceof SpaceCredentialError)) return { status: "failed", message: error instanceof Error ? error.message : String(error) };
    }
    try {
      await this.deps.memberClient.procedure("com.atproto.space.putRecord", {
        space: inbox, repo: this.deps.did, collection: "org.slack.dm.request", rkey: convKey, record,
      });
      return { status: "delivered" };
    } catch (error) {
      return { status: "failed", message: error instanceof Error ? error.message : String(error) };
    }
  }

  /** A cached credential outlives a deleted half, so a missing header is re-checked with a fresh mint to tell "left" from "not replied". */
  private async classifyHeaderlessHalf(half: string): Promise<DmHalfStatus> {
    this.credentials.delete(half);
    try {
      await this.credentialFor(half);
      return "missing";
    } catch (error) {
      return error instanceof SpaceCredentialError ? classifyHalfError(error) : "missing";
    }
  }

  private async findExistingHalf(participants: readonly string[]): Promise<string | null> {
    const halves = await listBoundedSpaces(this.deps.memberClient, { type: "org.slack.dm.conversation", maxSpaces: MAX_OWN_CONVERSATIONS });
    if (halves.truncated) throw new Error("Own DM conversation count exceeds the bounded scan limit.");
    for (const space of halves.spaces) {
      const header = await this.getValidatedOwnHeader(space.uri);
      if (header && sameParticipants(header.participants, participants)) return header.convKey;
    }
    return null;
  }

  /** Fetches the caller's own header for `space` and validates it, returning `null` for a missing or invalid record. */
  private async getValidatedOwnHeader(space: string): Promise<{ convKey: string; participants: string[]; createdAt: string } | null> {
    const header = await this.getOwnRecord(space, "org.slack.dm.header", "self");
    if (!header) return null;
    const validation = validateSpaceRecord("org.slack.dm.header", header, {
      authorityDid: this.deps.did, spaceUri: space, repoDid: this.deps.did, rkey: "self",
    });
    if (!validation.valid) return null;
    const value = header as { convKey: string; participants: string[]; createdAt: string };
    return { convKey: value.convKey, participants: value.participants, createdAt: value.createdAt };
  }

  private async ownConversationKeys(): Promise<Set<string>> {
    const halves = await listBoundedSpaces(this.deps.memberClient, { type: "org.slack.dm.conversation", maxSpaces: MAX_OWN_CONVERSATIONS });
    if (halves.truncated) throw new Error("Own DM conversation count exceeds the bounded scan limit.");
    return new Set(halves.spaces.flatMap((space) => {
      const parsed = parseDmConversationUri(space.uri);
      return parsed ? [parsed.convKey] : [];
    }));
  }

  private async getOwnRecord(space: string, collection: string, rkey: string): Promise<Record<string, unknown> | null> {
    let credential: SpaceCredential;
    try {
      credential = await this.credentialFor(space);
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

  private async readReactions(
    convKey: string,
    participants: readonly string[],
    credentials: ReadonlyMap<string, SpaceCredential>,
    messageUris: ReadonlySet<string>,
  ): Promise<DmReaction[]> {
    const perHalf = await mapLimited(participants, FANOUT, async (ownerDid): Promise<DmReaction[]> => {
      const credential = credentials.get(ownerDid);
      if (!credential) return [];
      const half = dmConversationUri(ownerDid, convKey);
      const client = credential.client(await this.deps.resolvePds(ownerDid));
      const page = await listBoundedRecords(client, { space: half, repo: ownerDid, collection: "org.slack.dm.reaction", maxRecords: MAX_REACTIONS_PER_HALF });
      if (page.truncated) throw new Error("DM reaction history exceeds the bounded scan limit.");
      const reactions: DmReaction[] = [];
      for (const record of page.records) {
        const validation = validateSpaceRecord("org.slack.dm.reaction", record.value, {
          authorityDid: ownerDid, spaceUri: half, repoDid: ownerDid, rkey: record.rkey, participants,
        });
        if (!validation.valid) continue;
        const value = record.value as { subject: string; emoji: string; createdAt: string };
        if (!messageUris.has(value.subject)) continue;
        reactions.push({ uri: spaceRecordUri(half, ownerDid, "org.slack.dm.reaction", record.rkey), ownerDid, subject: value.subject, emoji: value.emoji, createdAt: value.createdAt });
      }
      return reactions;
    });
    return perHalf.flat();
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
      await this.credentialFor(dmConversationUri(participant, convKey));
      return false; // a half exists: they replied (or left, handled by SpaceDeleted below).
    } catch (error) {
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

function policyType(policy: "public" | "memberList"): string {
  return policy === "public" ? "com.atproto.simplespace.defs#publicPolicy" : "com.atproto.simplespace.defs#memberListPolicy";
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

function isMissingSpace(error: unknown): boolean {
  return error instanceof SpaceCredentialError && (error.code === "SpaceNotFound" || error.code === "SpaceDeleted");
}

function isSpaceNotFound(error: unknown): boolean {
  return hasErrorCode(error, "SpaceNotFound");
}

function isRecordNotFound(error: unknown): boolean {
  return hasErrorCode(error, "RecordNotFound");
}

function isAlreadyExists(error: unknown): boolean {
  return hasErrorCode(error, "SpaceAlreadyExists");
}

function hasErrorCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code: unknown }).code === code;
}
