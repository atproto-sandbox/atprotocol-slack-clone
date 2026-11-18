import { isAccessLost, SpaceCredentialError } from "@flock/protocol/atproto/space-credential-core";
import { isMissingXrpcResource } from "@flock/protocol/atproto/xrpc";
import { channelUri, parseWorkspaceUri, tidNow } from "@flock/protocol/keys";
import { REPO_COLLECTION } from "@flock/protocol/nsids";
import { validateAppDeclaration } from "@flock/protocol/registry";
import { appGrantScopes } from "@flock/protocol/scopes";
import type { ChannelMessage, ChannelPage, ChannelRef } from "./channel-client";
import type { Engine } from "./engine";
import { ChangeFollower, pause, REFOLLOW_DELAY_MS, RETRY_DELAY_MS, type PollResult } from "./feed";
import { encodeCursor } from "./merge";
import type { OperatorClient } from "./operator-client";
import type { ClientTransport } from "./transport";

// An app's runtime: in each workspace it was installed in, the channels its install record grants it, followed through the
// operator's change feed, and every message from a person given to the app once. It runs wherever the engine runs.

/** A message given to an app, with where it is and whether the app may answer there. */
export type AppMessage = { channel: ChannelRef; canWrite: boolean; message: ChannelMessage };

/** The app can no longer read a space: it was uninstalled, its grant of a channel ended, or the space is gone. */
export class AppAccessLostError extends Error {
  constructor(readonly space: string) {
    super(`The app can no longer read ${space}: it was uninstalled, or the space is gone.`);
    this.name = "AppAccessLostError";
  }
}

export type AppRuntimeInput = {
  engine: Pick<Engine, "channels" | "workspaces" | "credentials"> & { operator: Pick<OperatorClient, "getChanges"> };
  /** The app's own DID: the grants it follows are its own install record's. */
  did: string;
  /**
   * The workspaces the app was installed in. An app is told them: it reads the workspace space and is never a writer there, so
   * its acceptance record is listed by no authority and it cannot find its workspaces the way a person does.
   */
  workspaces: readonly string[];
  onMessage(message: AppMessage): Promise<void>;
  /**
   * Every failure, as it happens: a poll the operator did not answer, a space that could not be read, a message `onMessage`
   * failed on, a read cut short, and access lost (`AppAccessLostError`). The runtime goes on; an app stops it by aborting.
   */
  onError(error: unknown): void;
  /** How long the runtime waits before following again a space it lost (a minute by default). */
  refollowDelayMs?: number;
  /** How long it waits before following again a space it could not follow for a passing failure (five seconds by default). */
  retryDelayMs?: number;
  /** The wall clock and a monotonic one, both in milliseconds: `Date.now` and `performance.now` unless a test gives others. */
  clock?: { now(): number; elapsed(): number };
};

/** How many pages back a burst of new messages is followed before the older ones are reported, not given. */
const MAX_PAGES_BACK = 5;

/** The OAuth scope an app asks its own account for (`appGrantScopes`), as one string. */
export function appGrantScope(serviceRef: string): string {
  return appGrantScopes(serviceRef).join(" ");
}

/**
 * Publishes the app's declaration in its own repo (key `self`), the name people see, unless it already says the same. It is a
 * label, never a grant.
 */
export async function publishAppDeclaration(transport: Pick<ClientTransport, "did" | "memberClient">, declaration: { name: string; description?: string }): Promise<void> {
  const record = { repo: transport.did, collection: REPO_COLLECTION.appDeclaration, rkey: "self" };
  const existing = await transport.memberClient.query<{ value: Record<string, unknown> }>("com.atproto.repo.getRecord", record)
    .then((answer) => answer.value, (error: unknown) => { if (isMissingXrpcResource(error)) return null; throw error; });
  const current = existing && validateAppDeclaration(existing).valid ? existing : null;
  if (current && current.name === declaration.name && current.description === declaration.description) return;
  await transport.memberClient.procedure("com.atproto.repo.putRecord", {
    ...record,
    record: { $type: REPO_COLLECTION.appDeclaration, ...declaration, createdAt: typeof current?.createdAt === "string" ? current.createdAt : new Date().toISOString() },
  });
}

/** Runs an app until `signal` aborts: follows its granted channels and gives it each new message from a person. */
export async function runApp(input: AppRuntimeInput & { signal: AbortSignal }): Promise<void> {
  const runtime = new AppRuntime(input);
  while (!input.signal.aborted) {
    try {
      await runtime.poll(input.signal);
    } catch (error) {
      if (input.signal.aborted) return;
      input.onError(error);
      await pause(RETRY_DELAY_MS, input.signal);
    }
  }
}

type Grant = { channel: ChannelRef; write: boolean };

/**
 * What the app has been given of a channel, by its window: a message is new when its key (its writer's clock) is at or above
 * `lower` and not above the present plus `CLOCK_SLACK_MS`, and it is not in `taken`. `taken` holds what the app took or
 * noted, with each one's key, pruned below `lower`; `attempts` counts each message the app failed on. `heldSince` is when a
 * read without some writer began holding `lower` back.
 */
type ChannelState = {
  lower: string;
  /** The wall-clock time the lower edge was last moved to, and the monotonic time it was moved at. */
  basisMs: number;
  basisElapsed: number;
  taken: Map<string, string>;
  attempts: Map<string, { rkey: string; count: number; since: number }>;
  heldSince?: number;
  capReported?: boolean;
};

/** How many times a message the app keeps failing on is given before it is reported as given up. */
const MAX_ATTEMPTS = 3;
/** The shortest a round waits when it has nothing to ask the feed about: never asking again at once. */
const MIN_IDLE_MS = 100;
/** How far a writer's clock may stray from the app's, either way, for its message to be given when it arrives. */
const CLOCK_SLACK_MS = 5_000;
/** How long a read without some writer holds the window's lower edge for that writer's messages, before it moves on. */
const MAX_HOLD_MS = 10 * 60_000;

export class AppRuntime {
  private readonly follower: ChangeFollower;
  /** The channels the app's install records grant it, by channel space, whether followed yet or not. */
  private readonly grants = new Map<string, Grant>();
  private readonly channels = new Map<string, ChannelState>();
  /** Every active app of each workspace, the app itself among them: no app's message is given to an app. */
  private readonly apps = new Map<string, ReadonlySet<string>>();
  /** Each workspace's people (its active roster) as last read: with `apps`, who an author is known to be. */
  private readonly people = new Map<string, ReadonlySet<string>>();
  /** When the runtime may next try to follow each space it does not follow, and how many passing failures in a row it met. */
  private readonly nextAttempt = new Map<string, number>();
  private readonly failures = new Map<string, number>();
  /** The spaces whose loss was reported, so a loss is reported once. */
  private readonly lost = new Set<string>();
  /** Each channel's permanently set-aside writers already reported. */
  private readonly reportedAside = new Map<string, Set<string>>();
  private readonly refollowDelayMs: number;
  private readonly retryDelayMs: number;
  private readonly clock: { now(): number; elapsed(): number };

  constructor(private readonly input: AppRuntimeInput) {
    for (const workspace of input.workspaces) if (!parseWorkspaceUri(workspace)) throw new TypeError(`Not a workspace URI: ${workspace}`);
    this.refollowDelayMs = input.refollowDelayMs ?? REFOLLOW_DELAY_MS;
    this.retryDelayMs = input.retryDelayMs ?? RETRY_DELAY_MS;
    this.clock = input.clock ?? { now: () => Date.now(), elapsed: () => performance.now() };
    this.follower = new ChangeFollower({ operator: input.engine.operator, credentials: input.engine.credentials, sync: (space) => this.sync(space) });
  }

  /** Every space being followed: the workspaces, and the channels they grant the app. */
  get following(): string[] {
    return this.follower.following;
  }

  /**
   * One round. Each told workspace and each granted channel not yet followed is followed, each on its own: at once the first
   * time, again five seconds after a passing failure, a minute after a lost one. Then the feed is asked; with nothing to ask
   * about, the round waits until the next attempt is due.
   */
  async poll(signal?: AbortSignal): Promise<PollResult> {
    await this.followMissing();
    if (!this.follower.pollable) {
      const due = Math.min(Date.now() + this.refollowDelayMs, ...this.missing().map((space) => this.nextAttempt.get(space) ?? Date.now()));
      await pause(Math.max(MIN_IDLE_MS, due - Date.now()), signal);
      return { synced: [], unfollowed: [], failed: [] };
    }
    const result = await this.follower.poll(signal);
    for (const { error } of result.failed) this.input.onError(error);
    for (const space of result.unfollowed) this.forget(space);
    return result;
  }

  /** The workspaces first, then the channels they grant, so a channel granted in this round is followed in it. */
  private async followMissing(): Promise<void> {
    for (const workspace of this.input.workspaces) await this.followOne(workspace, () => this.readGrants(workspace));
    for (const [space, grant] of [...this.grants]) await this.followOne(space, () => this.readChannel(space, grant, false));
  }

  /** The told workspaces and granted channels not followed. */
  private missing(): string[] {
    const following = new Set(this.follower.following);
    return [...this.input.workspaces, ...this.grants.keys()].filter((space) => !following.has(space));
  }

  /** Follows one space, unless it is followed or not due. A passing failure is tried again sooner, then less often, up to once a minute. */
  private async followOne(space: string, load: () => Promise<void>): Promise<void> {
    if (this.follower.following.includes(space) || (this.nextAttempt.get(space) ?? 0) > Date.now()) return;
    try {
      await this.follower.follow([space], load);
      this.nextAttempt.delete(space);
      this.failures.delete(space);
      this.lost.delete(space);
    } catch (error) {
      if (isSpaceRefused(error)) {
        this.nextAttempt.set(space, Date.now() + this.refollowDelayMs);
        this.failures.delete(space);
        this.reportLost(space);
      } else {
        const failures = (this.failures.get(space) ?? 0) + 1;
        this.failures.set(space, failures);
        this.nextAttempt.set(space, Date.now() + Math.min(this.retryDelayMs * 2 ** Math.min(failures - 1, 16), this.refollowDelayMs));
        this.input.onError(error);
      }
    }
  }

  /** A space the feed stopped following because the app lost it. A workspace takes its channels with it; each is tried again in a minute. */
  private forget(space: string): void {
    this.reportLost(space);
    // Only what the app still means to follow is tried again: a told workspace, or a channel still granted.
    if (this.input.workspaces.includes(space) || this.grants.has(space)) this.nextAttempt.set(space, Date.now() + this.refollowDelayMs);
    for (const [channel, grant] of this.grants) {
      if (channel !== space && grant.channel.workspace !== space) continue;
      if (channel !== space) {
        this.grants.delete(channel);
        this.nextAttempt.delete(channel);
        this.failures.delete(channel);
        this.follower.unfollow(channel);
      }
      this.channels.delete(channel);
    }
  }

  private reportLost(space: string): void {
    if (this.lost.has(space)) return;
    this.lost.add(space);
    this.input.onError(new AppAccessLostError(space));
  }

  private async sync(space: string): Promise<void> {
    if (this.input.workspaces.includes(space)) return this.readGrants(space);
    const grant = this.grants.get(space);
    if (grant) await this.readChannel(space, grant, true);
  }

  /**
   * Reads the app's install record in `workspace` again: the channels it grants, with their write bits. Each newly granted
   * channel is followed in the next round, on its own, so one that cannot be read holds back no other; each whose grant ended
   * is followed no more.
   */
  private async readGrants(workspace: string): Promise<void> {
    const summary = await this.input.engine.workspaces.summary(workspace, { fresh: true });
    const installs = summary?.installs ?? [];
    this.apps.set(workspace, new Set(installs.map((install) => install.did)));
    this.people.set(workspace, new Set((summary?.members ?? []).map((member) => member.did)));
    const authorityDid = parseWorkspaceUri(workspace)!.authorityDid;
    const granted = new Map((installs.find((install) => install.did === this.input.did)?.channels ?? [])
      .map(({ skey, write }): [string, Grant] => [channelUri(authorityDid, skey), { channel: { workspace, skey }, write }]));
    for (const [space, grant] of this.grants) {
      if (grant.channel.workspace !== workspace || granted.has(space)) continue;
      this.grants.delete(space);
      this.channels.delete(space);
      this.nextAttempt.delete(space);
      this.failures.delete(space);
      this.follower.unfollow(space);
    }
    for (const [space, grant] of granted) this.grants.set(space, grant);
  }

  /**
   * Gives the app each new message from a person, oldest first. New is a window of its writer's keys, which its writer's clock
   * made, from the window's lower edge to the present plus `CLOCK_SLACK_MS`, and not already taken. The lower edge starts at
   * the moment the channel was followed less `CLOCK_SLACK_MS` (the first read only notes what the window holds), and moves on
   * after each complete read to the present less as much, by no more than the time that really passed (so a jump of the
   * app's clock cannot carry it past every message to come). So:
   * - nothing written more than `CLOCK_SLACK_MS` before the app followed the channel is answered, whatever a page holds or a
   *   deletion slides onto it;
   * - a message keyed ahead of the present is given on the first change after its time comes, and a flood of such keys
   *   neither hides the present nor fills memory, since every read starts at the window's upper edge;
   * - a burst is followed back to the lower edge, up to `MAX_PAGES_BACK` pages; the first time a read meets that bound it is
   *   reported;
   * - a read without a writer whose host may come back holds the lower edge, up to `MAX_HOLD_MS`, so that writer's messages
   *   are given when it returns; a writer set aside for good is reported once;
   * - a message the app fails on is given again on the next change, up to `MAX_ATTEMPTS` times and within `MAX_HOLD_MS`,
   *   holding the lower edge for it and holding back no other.
   * A message that becomes readable more than `CLOCK_SLACK_MS` after its key's time (a writer's clock behind, or its host slow
   * to report it) may be taken for old: the trade for answering nothing old with keys any writer chooses. R11's sync strategy,
   * which follows each writer's operations, is where an app can be given what is new by its host's order instead.
   */
  private async readChannel(space: string, grant: Grant, deliver: boolean): Promise<void> {
    const now = this.clock.now();
    const elapsed = this.clock.elapsed();
    const state: ChannelState = this.channels.get(space) ?? {
      lower: tidNow(now - CLOCK_SLACK_MS, 0), basisMs: now - CLOCK_SLACK_MS, basisElapsed: elapsed, taken: new Map(), attempts: new Map(),
    };
    const fresh: ChannelMessage[] = [];
    const passing = new Set<string>();
    const permanent: ChannelPage["setAside"] = [];
    let complete = true;
    let capped = false;
    let page = await this.input.engine.channels.readPage(grant.channel, { before: encodeCursor({ key: tidNow(now + CLOCK_SLACK_MS, 1023), uri: "~" }) });
    for (let pages = 1; ; pages += 1) {
      complete &&= page.complete;
      for (const aside of page.setAside) if (aside.permanent) permanent.push(aside); else passing.add(aside.did);
      fresh.push(...page.messages.filter((message) => message.rkey >= state.lower && !state.taken.has(message.uri)));
      if (!page.next || page.messages.some((message) => message.rkey < state.lower)) break;
      if (pages >= MAX_PAGES_BACK) {
        capped = true;
        break;
      }
      page = await this.input.engine.channels.readPage(grant.channel, { before: page.next });
    }
    complete &&= passing.size === 0;
    let canWrite = grant.write;
    if (deliver) {
      // An author known neither as a person nor as an app (one installed, or a person who joined, since the grants were last
      // read) means reading them again before any message is given: the workspace's own read may have failed in this poll, or
      // come after this channel's, and a new app's message must not be taken for a person's. A failed read fails this one,
      // which the next change tries again; a read that ended this channel's grant gives nothing.
      const workspace = grant.channel.workspace;
      const known = (did: string) => this.people.get(workspace)?.has(did) === true || this.apps.get(workspace)?.has(did) === true;
      if (fresh.some((message) => !known(message.repo))) {
        await this.readGrants(workspace);
        const current = this.grants.get(space);
        if (!current) return;
        canWrite = current.write;
      }
      this.reportRead(space, state, { complete, passing: passing.size, permanent, capped });
    }
    const apps = this.apps.get(grant.channel.workspace) ?? new Set<string>();
    for (const message of fresh.sort((left, right) => left.rkey.localeCompare(right.rkey))) {
      if (deliver && !apps.has(message.repo)) {
        try {
          await this.input.onMessage({ channel: grant.channel, canWrite, message });
        } catch (error) {
          this.input.onError(error);
          const attempt = state.attempts.get(message.uri) ?? { rkey: message.rkey, count: 0, since: elapsed };
          attempt.count += 1;
          if (attempt.count < MAX_ATTEMPTS) {
            state.attempts.set(message.uri, attempt);
            continue;
          }
          this.input.onError(new Error(`The app failed on ${message.uri} ${attempt.count} times; it is not given again.`));
        }
      }
      state.attempts.delete(message.uri);
      state.taken.set(message.uri, message.rkey);
    }
    // A message given again holds the lower edge for at most `MAX_HOLD_MS`: one deleted meanwhile is never read again.
    for (const [uri, attempt] of state.attempts) {
      if (elapsed - attempt.since <= MAX_HOLD_MS) continue;
      state.attempts.delete(uri);
      this.input.onError(new Error(`The app failed on ${uri} and it has not been read again for ${MAX_HOLD_MS / 60_000} minutes; it is not given again.`));
    }
    state.heldSince = complete ? undefined : state.heldSince ?? elapsed;
    if (state.heldSince !== undefined && elapsed - state.heldSince > MAX_HOLD_MS) {
      this.input.onError(new Error(`${space} has been read without some writer for over ${MAX_HOLD_MS / 60_000} minutes; what it wrote before now is not given to the app.`));
      state.heldSince = undefined;
    }
    if (state.heldSince === undefined) {
      const basisMs = Math.min(now - CLOCK_SLACK_MS, state.basisMs + (elapsed - state.basisElapsed));
      if (basisMs > state.basisMs) {
        state.basisMs = basisMs;
        state.basisElapsed = elapsed;
      }
      const lower = [tidNow(Math.floor(state.basisMs), 0), ...[...state.attempts.values()].map((attempt) => attempt.rkey)]
        .reduce((lowest, key) => (key < lowest ? key : lowest));
      if (lower > state.lower) state.lower = lower;
    }
    for (const [uri, rkey] of state.taken) if (rkey < state.lower) state.taken.delete(uri);
    this.channels.set(space, state);
  }

  /** Reports what a read could not give: once per read for writers it went without, once per writer set aside for good, once per run of reads that met the page bound. */
  private reportRead(space: string, state: ChannelState, read: { complete: boolean; passing: number; permanent: ChannelPage["setAside"]; capped: boolean }): void {
    if (!read.complete) {
      this.input.onError(new Error(`${space} was read without ${read.passing || "some"} writer(s); their messages come when the channel next changes.`));
    }
    const reported = this.reportedAside.get(space) ?? new Set<string>();
    this.reportedAside.set(space, reported);
    for (const aside of read.permanent.filter((entry) => !reported.has(entry.did))) {
      reported.add(aside.did);
      this.input.onError(new Error(`${space}: ${aside.did}'s messages cannot be read (${aside.reason}); they are not given to the app.`));
    }
    if (read.capped && !state.capReported) this.input.onError(new Error(`More than ${MAX_PAGES_BACK} pages of new messages in ${space}; the older ones were not given to the app.`));
    state.capReported = read.capped;
  }
}

/** The authority refused this app a space: its credential was refused (access lost), not a passing failure of any other kind. */
function isSpaceRefused(error: unknown): boolean {
  return error instanceof SpaceCredentialError && isAccessLost(error);
}
