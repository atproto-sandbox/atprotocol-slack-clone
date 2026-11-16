import { isAccessLost, SpaceCredentialError } from "@flock/protocol/atproto/space-credential-core";
import { isMissingXrpcResource } from "@flock/protocol/atproto/xrpc";
import { appInboxUri, channelUri, parseSpaceRecordUri, parseWorkspaceUri } from "@flock/protocol/keys";
import { COLLECTION, REPO_COLLECTION } from "@flock/protocol/nsids";
import { isCommandName, validateAppDeclaration } from "@flock/protocol/registry";
import { appGrantScopes } from "@flock/protocol/scopes";
import type { WorkspaceSummary } from "@flock/protocol/workspace-summary";
import type { AppInboxClient, AppInboxRecord } from "./app-inbox-client";
import { findActionButton } from "./blocks";
import type { ChannelMessage, ChannelRef } from "./channel-client";
import type { Engine } from "./engine";
import { ChannelUnavailableError } from "./errors";
import { ChangeFollower, pause, REFOLLOW_DELAY_MS, RETRY_DELAY_MS, type PollResult } from "./feed";
import { KeyWindow, type WindowClock } from "./key-window";
import type { OperatorClient } from "./operator-client";
import type { ListedWriter } from "./store";
import type { ClientTransport } from "./transport";
import type { DeclaredCommand } from "./workspace-client";

export type { DeclaredCommand };

// An app's runtime: in each workspace it was installed in, the channels its install record grants it and (when it handles
// commands or clicks) its app inbox, followed through the operator's change feed, and every new message, command or click
// from a person given to the app once. It runs wherever the engine runs.

/** A message given to an app, with where it is and whether the app may answer there. */
export type AppMessage = { channel: ChannelRef; canWrite: boolean; message: ChannelMessage };

/** A slash command run by a member in `channel`, verified against fresh workspace and channel state. */
export type AppCommand = {
  channel: ChannelRef;
  canWrite: boolean;
  uri: string;
  repo: string;
  rkey: string;
  command: string;
  text: string;
  parent?: string;
  createdAt: string;
};

/** A button click on one of this app's messages in `channel`, carrying the button's own `value` from the verified message. */
export type AppAction = {
  channel: ChannelRef;
  canWrite: boolean;
  uri: string;
  repo: string;
  rkey: string;
  message: ChannelMessage;
  actionId: string;
  value?: string;
  createdAt: string;
};

/** The app can no longer read a space: it was uninstalled, its grant of a channel ended, or the space is gone. */
export class AppAccessLostError extends Error {
  constructor(readonly space: string) {
    super(`The app can no longer read ${space}: it was uninstalled, or the space is gone.`);
    this.name = "AppAccessLostError";
  }
}

export type AppRuntimeEngine = Pick<Engine, "channels" | "workspaces" | "credentials"> & {
  appInboxes?: Pick<AppInboxClient, "writers" | "readPage">;
  operator: Pick<OperatorClient, "getChanges">;
};

export type AppRuntimeInput = {
  engine: AppRuntimeEngine;
  /** The app's own DID: the grants it follows are its own install record's. */
  did: string;
  /**
   * The workspaces the app was installed in. An app is told them: it reads the workspace space and is never a writer there, so
   * its acceptance record is listed by no authority and it cannot find its workspaces the way a person does.
   */
  workspaces: readonly string[];
  /** The slash commands this app declares and accepts when `onCommand` is set. */
  commands?: readonly DeclaredCommand[];
  /** Per-author inbox rate limit (commands + actions combined) per minute per inbox; 20 by default. */
  maxRecordsPerAuthor?: number;
  onMessage?: (message: AppMessage) => Promise<void>;
  onCommand?: (command: AppCommand) => Promise<void>;
  onAction?: (action: AppAction) => Promise<void>;
  /**
   * Every failure, as it happens: a poll the operator did not answer, a space that could not be read, a handler failure, an
   * invalid or throttled inbox record that was dropped, a read cut short, and access lost (`AppAccessLostError`).
   */
  onError(error: unknown): void;
  /** How long the runtime waits before following again a space it lost (a minute by default). */
  refollowDelayMs?: number;
  /** How long it waits before following again a space it could not follow for a passing failure (five seconds by default). */
  retryDelayMs?: number;
  /** The wall clock and a monotonic one, both in milliseconds: `Date.now` and `performance.now` unless a test gives others. */
  clock?: WindowClock;
};

const DEFAULT_MAX_RECORDS_PER_AUTHOR = 20;
const THROTTLE_WINDOW_MS = 60_000;
/** The shortest a round waits when it has nothing to ask the feed about: never asking again at once. */
const MIN_IDLE_MS = 100;

/** The OAuth scope an app asks its own account for (`appGrantScopes`), as one string. */
export function appGrantScope(serviceRef: string): string {
  return appGrantScopes(serviceRef).join(" ");
}

/**
 * Publishes the app's declaration in its own repo (key `self`), the name and commands people see, unless it already says the
 * same. It is a label, never a grant.
 */
export async function publishAppDeclaration(
  transport: Pick<ClientTransport, "did" | "memberClient">,
  declaration: { name: string; description?: string; commands?: readonly DeclaredCommand[] },
): Promise<void> {
  const record = { repo: transport.did, collection: REPO_COLLECTION.appDeclaration, rkey: "self" };
  const existing = await transport.memberClient
    .query<{ value: Record<string, unknown> }>("com.atproto.repo.getRecord", record)
    .then((answer) => answer.value, (error: unknown) => {
      if (isMissingXrpcResource(error)) return null;
      throw error;
    });
  const current = existing && validateAppDeclaration(existing).valid ? existing : null;
  const normalizedCommands = declaration.commands?.map((command) => ({
    name: command.name,
    ...(command.description === undefined ? {} : { description: command.description }),
    ...(command.usage === undefined ? {} : { usage: command.usage }),
  }));
  if (
    current &&
    current.name === declaration.name &&
    current.description === declaration.description &&
    sameDeclaredCommands(current.commands, normalizedCommands)
  ) {
    return;
  }
  const nextRecord: Record<string, unknown> = {
    $type: REPO_COLLECTION.appDeclaration,
    name: declaration.name,
    ...(declaration.description === undefined ? {} : { description: declaration.description }),
    ...(normalizedCommands === undefined ? {} : { commands: normalizedCommands }),
    createdAt: typeof current?.createdAt === "string" ? current.createdAt : new Date().toISOString(),
  };
  const validation = validateAppDeclaration(nextRecord);
  if (!validation.valid) throw new Error(validation.reason);
  await transport.memberClient.procedure("com.atproto.repo.putRecord", {
    ...record,
    record: nextRecord,
  });
}

function sameDeclaredCommands(existing: unknown, desired: readonly DeclaredCommand[] | undefined): boolean {
  if (existing === undefined && desired === undefined) return true;
  if (!Array.isArray(existing) || desired === undefined || existing.length !== desired.length) return false;
  return desired.every((command, index) => {
    const item = existing[index] as Record<string, unknown>;
    return item.name === command.name && item.description === command.description && item.usage === command.usage;
  });
}

/** Runs an app until `signal` aborts: follows its granted spaces and gives it each new message, command or click from a person. */
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
type AuthorWindow = { windowStart: number; count: number; reported: boolean };

export class AppRuntime {
  private readonly follower: ChangeFollower;
  private readonly window: KeyWindow;
  /** The channels the app's install records grant it, by channel space, whether followed yet or not. */
  private readonly grants = new Map<string, Grant>();
  /** Active app-inbox spaces mapped to their workspace URI (populated only when `onCommand` or `onAction` is given). */
  private readonly inboxes = new Map<string, string>();
  /** Per-inbox, per-author rate limit windows. */
  private readonly throttles = new Map<string, Map<string, AuthorWindow>>();
  /** Every active app of each workspace, the app itself among them: no app's message is given to an app. */
  private readonly apps = new Map<string, ReadonlySet<string>>();
  /** Each workspace's people (its active roster) as last read: with `apps`, who an author is known to be. */
  private readonly people = new Map<string, ReadonlySet<string>>();
  /** When the runtime may next try to follow each space it does not follow, and how many passing failures in a row it met. */
  private readonly nextAttempt = new Map<string, number>();
  private readonly failures = new Map<string, number>();
  /** The spaces whose loss was reported, so a loss is reported once. */
  private readonly lost = new Set<string>();
  private readonly refollowDelayMs: number;
  private readonly retryDelayMs: number;
  private readonly clock: WindowClock;
  private readonly wantsMessages: boolean;
  private readonly wantsInbox: boolean;
  private readonly declaredCommands: ReadonlySet<string>;
  private readonly maxRecordsPerAuthor: number;

  constructor(private readonly input: AppRuntimeInput) {
    for (const workspace of input.workspaces) {
      if (!parseWorkspaceUri(workspace)) throw new TypeError(`Not a workspace URI: ${workspace}`);
    }
    for (const command of input.commands ?? []) {
      if (!isCommandName(command.name)) throw new TypeError(`Invalid command name: ${command.name}`);
    }
    const maxPerAuthor = input.maxRecordsPerAuthor ?? DEFAULT_MAX_RECORDS_PER_AUTHOR;
    if (!Number.isSafeInteger(maxPerAuthor) || maxPerAuthor < 1) {
      throw new RangeError("maxRecordsPerAuthor must be a positive safe integer.");
    }
    this.wantsMessages = Boolean(input.onMessage);
    this.wantsInbox = Boolean(input.onCommand || input.onAction);
    if (this.wantsInbox && !input.engine.appInboxes) {
      throw new TypeError("engine.appInboxes is required when handling commands or actions.");
    }
    input.engine.channels.setApplyOwnWrites?.(false);
    this.declaredCommands = new Set((input.commands ?? []).map((command) => command.name));
    this.maxRecordsPerAuthor = maxPerAuthor;
    this.refollowDelayMs = input.refollowDelayMs ?? REFOLLOW_DELAY_MS;
    this.retryDelayMs = input.retryDelayMs ?? RETRY_DELAY_MS;
    this.clock = input.clock ?? { now: () => Date.now(), elapsed: () => performance.now() };
    this.window = new KeyWindow(this.clock, (error) => input.onError(error));
    this.follower = new ChangeFollower({
      operator: input.engine.operator,
      credentials: input.engine.credentials,
      sync: (space) => this.sync(space),
    });
  }

  /** Every space being followed: the workspaces, any followed app inboxes, and any followed channels. */
  get following(): string[] {
    return this.follower.following;
  }

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

  /** The workspaces first, then active app inboxes and granted channels, so spaces granted in this round are followed in it. */
  private async followMissing(): Promise<void> {
    for (const workspace of this.input.workspaces) await this.followOne(workspace, () => this.readGrants(workspace));
    for (const [inbox, workspace] of [...this.inboxes]) await this.followOne(inbox, () => this.readInbox(inbox, workspace, false));
    if (this.wantsMessages) {
      for (const [space, grant] of [...this.grants]) await this.followOne(space, () => this.readChannel(space, grant, false));
    }
  }

  private missing(): string[] {
    const following = new Set(this.follower.following);
    return [
      ...this.input.workspaces,
      ...this.inboxes.keys(),
      ...(this.wantsMessages ? this.grants.keys() : []),
    ].filter((space) => !following.has(space));
  }

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

  /** A space the feed stopped following because the app lost it. A workspace takes its inbox and channels with it. */
  private forget(space: string): void {
    this.reportLost(space);
    if (this.input.workspaces.includes(space) || this.inboxes.has(space) || (this.wantsMessages && this.grants.has(space))) {
      this.nextAttempt.set(space, Date.now() + this.refollowDelayMs);
    }
    if (this.inboxes.has(space)) {
      this.window.delete(space);
      this.throttles.delete(space);
    }
    for (const [inbox, workspace] of this.inboxes) {
      if (workspace !== space) continue;
      this.inboxes.delete(inbox);
      this.window.delete(inbox);
      this.throttles.delete(inbox);
      this.nextAttempt.delete(inbox);
      this.failures.delete(inbox);
      this.follower.unfollow(inbox);
    }
    for (const [channel, grant] of this.grants) {
      if (channel !== space && grant.channel.workspace !== space) continue;
      if (channel !== space) {
        this.grants.delete(channel);
        this.nextAttempt.delete(channel);
        this.failures.delete(channel);
        this.follower.unfollow(channel);
      }
      this.window.delete(channel);
    }
  }

  private reportLost(space: string): void {
    if (this.lost.has(space)) return;
    this.lost.add(space);
    this.input.onError(new AppAccessLostError(space));
  }

  private async sync(space: string): Promise<void> {
    if (this.input.workspaces.includes(space)) return this.readGrants(space);
    const inboxWorkspace = this.inboxes.get(space);
    if (inboxWorkspace) return this.readInbox(space, inboxWorkspace, true);
    const grant = this.grants.get(space);
    if (grant && this.wantsMessages) await this.readChannel(space, grant, true);
  }

  private async readGrants(workspace: string): Promise<void> {
    const summary = await this.input.engine.workspaces.summary(workspace, { fresh: true });
    this.applySummary(workspace, summary);
  }

  private applySummary(workspace: string, summary: Pick<WorkspaceSummary, "installs" | "members"> | null): void {
    const installs = summary?.installs ?? [];
    this.apps.set(workspace, new Set(installs.map((install) => install.did)));
    this.people.set(workspace, new Set((summary?.members ?? []).map((member) => member.did)));
    const parsed = parseWorkspaceUri(workspace)!;
    const ownInstall = installs.find((install) => install.did === this.input.did);

    const inbox = appInboxUri(parsed.authorityDid, parsed.skey, this.input.did);
    if (this.wantsInbox && ownInstall) {
      this.inboxes.set(inbox, workspace);
    } else if (this.inboxes.has(inbox)) {
      this.inboxes.delete(inbox);
      this.window.delete(inbox);
      this.throttles.delete(inbox);
      this.nextAttempt.delete(inbox);
      this.failures.delete(inbox);
      this.follower.unfollow(inbox);
    }

    const granted = new Map(
      (ownInstall?.channels ?? []).map(({ skey, write }): [string, Grant] => [
        channelUri(parsed.authorityDid, skey),
        { channel: { workspace, skey }, write },
      ]),
    );
    for (const [space, grant] of this.grants) {
      if (grant.channel.workspace !== workspace || granted.has(space)) continue;
      this.grants.delete(space);
      this.window.delete(space);
      this.nextAttempt.delete(space);
      this.failures.delete(space);
      this.follower.unfollow(space);
    }
    for (const [space, grant] of granted) this.grants.set(space, grant);
  }

  private async readChannel(space: string, grant: Grant, deliver: boolean): Promise<void> {
    const onMessage = this.input.onMessage;
    if (!onMessage) return;
    await this.window.read<ChannelMessage>({
      space,
      deliver,
      labels: { items: "messages", space: "channel" },
      streams: [
        (options) =>
          this.input.engine.channels.readPage(grant.channel, options).then((page) => ({
            items: page.messages,
            ...(page.next ? { next: page.next } : {}),
            complete: page.complete,
            setAside: page.setAside,
          })),
      ],
      prepare: async (fresh) => {
        let canWrite = grant.write;
        const workspace = grant.channel.workspace;
        const known = (did: string) => this.people.get(workspace)?.has(did) === true || this.apps.get(workspace)?.has(did) === true;
        if (fresh.some((message) => !known(message.repo))) {
          await this.readGrants(workspace);
          const current = this.grants.get(space);
          if (!current) return null;
          canWrite = current.write;
        }
        const apps = this.apps.get(workspace) ?? new Set<string>();
        return async (message) => {
          if (!apps.has(message.repo)) await onMessage({ channel: grant.channel, canWrite, message });
        };
      },
    });
  }

  private async readInbox(space: string, workspace: string, deliver: boolean): Promise<void> {
    const appInboxes = this.input.engine.appInboxes!;
    let writersPromise: Promise<ListedWriter[]> | undefined;
    const getWriters = () => (writersPromise ??= appInboxes.writers(workspace, this.input.did));
    const streamOf = (collection: typeof COLLECTION.appCommand | typeof COLLECTION.appAction) =>
      async (options: { before: string }) => {
        const page = await appInboxes.readPage(workspace, this.input.did, collection, {
          before: options.before,
          writers: await getWriters(),
        });
        return {
          items: page.records,
          ...(page.next ? { next: page.next } : {}),
          complete: page.complete,
          setAside: page.setAside,
        };
      };

    await this.window.read<AppInboxRecord>({
      space,
      deliver,
      labels: { items: "records", space: "inbox" },
      streams: [streamOf(COLLECTION.appCommand), streamOf(COLLECTION.appAction)],
      prepare: async (fresh) => {
        if (fresh.length === 0) return async () => undefined;
        const summary = await this.input.engine.workspaces.summary(workspace, { fresh: true });
        this.applySummary(workspace, summary);
        if (!summary || !this.inboxes.has(space)) return null;
        const install = summary.installs.find((entry) => entry.did === this.input.did);
        if (!install) return null;

        const roster = new Set(summary.members.map((member) => member.did));
        const apps = new Set(summary.installs.map((entry) => entry.did));
        const directoryByUri = new Map(summary.channels.map((channel) => [channel.uri, channel]));
        const appGrants = new Map(install.channels.map((grant) => [grant.skey, grant.write]));
        const privateRosters = new Map<string, Promise<ReadonlySet<string>>>();
        const privateRosterOf = (ref: ChannelRef): Promise<ReadonlySet<string>> => {
          let pending = privateRosters.get(ref.skey);
          if (!pending) {
            pending = this.input.engine.channels
              .roster(ref)
              .then((members) => new Set(members))
              .catch((error: unknown) => {
                privateRosters.delete(ref.skey);
                throw error;
              });
            privateRosters.set(ref.skey, pending);
          }
          return pending;
        };

        return (record) =>
          this.deliverInboxRecord(
            space,
            workspace,
            summary.authorityDid,
            { roster, apps, directoryByUri, appGrants, privateRosterOf },
            record,
          );
      },
    });
  }

  private async deliverInboxRecord(
    space: string,
    workspace: string,
    authorityDid: string,
    context: {
      roster: ReadonlySet<string>;
      apps: ReadonlySet<string>;
      directoryByUri: ReadonlyMap<string, WorkspaceSummary["channels"][number]>;
      appGrants: ReadonlyMap<string, boolean>;
      privateRosterOf: (ref: ChannelRef) => Promise<ReadonlySet<string>>;
    },
    record: AppInboxRecord,
  ): Promise<void> {
    if (!this.admitAuthorRecord(space, record.repo)) return;
    if (!context.roster.has(record.repo) || context.apps.has(record.repo)) {
      this.dropInboxRecord(record.uri, `author ${record.repo} is not on ${workspace}'s active roster`);
      return;
    }
    if (record.collection === COLLECTION.appCommand) {
      const commandName = String(record.value.command);
      if (!this.input.onCommand || !this.declaredCommands.has(commandName)) {
        this.dropInboxRecord(record.uri, `command /${commandName} is not declared by this app`);
        return;
      }
    } else if (!this.input.onAction) {
      this.dropInboxRecord(record.uri, "the app handles no block actions");
      return;
    }

    const channelSpace = String(record.value.channel);
    const directoryEntry = context.directoryByUri.get(channelSpace);
    if (!directoryEntry) {
      this.dropInboxRecord(record.uri, `channel ${channelSpace} does not belong to ${workspace}`);
      return;
    }
    if (directoryEntry.visibility !== "public" && directoryEntry.visibility !== "private") {
      this.dropInboxRecord(record.uri, `channel ${channelSpace} is ${directoryEntry.visibility}`);
      return;
    }
    const canWrite = context.appGrants.get(directoryEntry.skey);
    if (canWrite === undefined) {
      this.dropInboxRecord(record.uri, `channel ${channelSpace} is not granted to this app`);
      return;
    }
    const ref: ChannelRef = { workspace, skey: directoryEntry.skey };

    if (directoryEntry.visibility === "private" && record.repo !== authorityDid) {
      let privateMembers: ReadonlySet<string>;
      try {
        privateMembers = await context.privateRosterOf(ref);
      } catch (error) {
        if (error instanceof ChannelUnavailableError || isAccessLost(error)) {
          this.dropInboxRecord(record.uri, `private channel ${channelSpace} is unavailable`);
          return;
        }
        throw error;
      }
      if (!privateMembers.has(record.repo)) {
        this.dropInboxRecord(record.uri, `author ${record.repo} is not on private channel ${channelSpace}'s roster`);
        return;
      }
    }

    if (record.collection === COLLECTION.appCommand) {
      let parent: string | undefined;
      if (record.value.parent !== undefined) {
        const parentUri = String(record.value.parent);
        let parentMessage: ChannelMessage | null;
        try {
          parentMessage = await this.input.engine.channels.getMessage(ref, parentUri);
        } catch (error) {
          if (error instanceof ChannelUnavailableError || isAccessLost(error)) {
            this.dropInboxRecord(record.uri, `command parent in ${channelSpace} is unavailable`);
            return;
          }
          throw error;
        }
        if (!parentMessage || parentMessage.value.parent !== undefined) {
          this.dropInboxRecord(record.uri, `command parent ${parentUri} is not a top-level message in ${channelSpace}`);
          return;
        }
        parent = parentUri;
      }
      await this.input.onCommand!({
        channel: ref,
        canWrite,
        uri: record.uri,
        repo: record.repo,
        rkey: record.rkey,
        command: String(record.value.command),
        text: String(record.value.text),
        ...(parent === undefined ? {} : { parent }),
        createdAt: String(record.value.createdAt),
      });
      return;
    }

    const messageUri = String(record.value.message);
    const target = parseSpaceRecordUri(messageUri, channelSpace, COLLECTION.message);
    if (!target || target.repo !== this.input.did) {
      this.dropInboxRecord(record.uri, `action target ${messageUri} is not this app's message in ${channelSpace}`);
      return;
    }
    let targetMessage: ChannelMessage | null;
    try {
      targetMessage = await this.input.engine.channels.getMessage(ref, messageUri);
    } catch (error) {
      if (error instanceof ChannelUnavailableError || isAccessLost(error)) {
        this.dropInboxRecord(record.uri, `action target channel ${channelSpace} is unavailable`);
        return;
      }
      throw error;
    }
    if (!targetMessage) {
      this.dropInboxRecord(record.uri, `action target ${messageUri} was not found or is invalid`);
      return;
    }
    const actionId = String(record.value.actionId);
    const matchedButton = findActionButton(targetMessage.value.blocks, actionId);
    if (!matchedButton) {
      this.dropInboxRecord(record.uri, `button ${actionId} is not present on ${messageUri}`);
      return;
    }
    await this.input.onAction!({
      channel: ref,
      canWrite,
      uri: record.uri,
      repo: record.repo,
      rkey: record.rkey,
      message: targetMessage,
      actionId,
      ...(matchedButton.value === undefined ? {} : { value: matchedButton.value }),
      createdAt: String(record.value.createdAt),
    });
  }

  private admitAuthorRecord(space: string, repo: string): boolean {
    const now = this.clock.now();
    let perAuthor = this.throttles.get(space);
    if (!perAuthor) {
      perAuthor = new Map();
      this.throttles.set(space, perAuthor);
    }
    for (const [did, entry] of perAuthor) {
      if (now - entry.windowStart >= THROTTLE_WINDOW_MS || now < entry.windowStart) perAuthor.delete(did);
    }
    let current = perAuthor.get(repo);
    if (!current) {
      current = { windowStart: now, count: 0, reported: false };
      perAuthor.set(repo, current);
    }
    current.count += 1;
    if (current.count <= this.maxRecordsPerAuthor) return true;
    if (!current.reported) {
      current.reported = true;
      this.input.onError(new Error(`${space}: ${repo} exceeded ${this.maxRecordsPerAuthor} inbox records per minute; excess records are dropped.`));
    }
    return false;
  }

  private dropInboxRecord(uri: string, reason: string): void {
    this.input.onError(new Error(`Dropped inbox record ${uri}: ${reason}.`));
  }
}

/** The authority refused this app a space: its credential was refused (access lost), not a passing failure of any other kind. */
function isSpaceRefused(error: unknown): boolean {
  return error instanceof SpaceCredentialError && isAccessLost(error);
}
