import { isDid, parseWorkspaceUri as parseWorkspaceSpaceUri, SELF_SKEY, workspaceUri } from "@flock/protocol/keys";
import { SpaceCredentialError } from "@flock/protocol/atproto/space-credential-core";
import { XrpcError } from "@flock/protocol/atproto/xrpc";
import { ChannelUnavailableError } from "@flock/client/errors";
import { OperatorRemoteError } from "@flock/client/operator-client";

export type Message = {
  uri: string;
  rkey: string;
  repo: string;
  cid?: string;
  hidden?: boolean;
  labels?: string[];
  value: { text?: string; createdAt?: string; parent?: string; blocks?: unknown };
  reactions?: Array<{ emoji: string; count: number; active: boolean }>;
};
export type PermalinkResolution =
  | { uri: string; status: "loading" }
  | { uri: string; status: "resolved"; message: Message | null }
  | { uri: string; status: "not_found" }
  | { uri: string; status: "error"; message: string };
export type ScopedReplyDraft = { routeKey: string; uri: string };

/**
 * Resolves the active composer reply target for `routeKey`, discarding any optimistic local reply draft created on a
 * different route or channel so browser history transitions restore the destination URL's exact `?thread=` state.
 */
export function resolveScopedReplyTo(routeKey: string, routeThread: string, draft: ScopedReplyDraft | null): string {
  if (draft && draft.routeKey === routeKey) return draft.uri;
  return routeThread;
}
export type Reaction = { repo: string; value: { subject?: string; emoji?: string } };
export type InboxRequest = { uri: string; repoDid: string; channelSkey: string; channelName: string; requestId: string; createdAt: string };
export type ChannelSelection = { workspace: string; skey: string; name: string; visibility: string };
export type PendingOperation = { workspace: string; operationId: string; request: Record<string, unknown> };
/** Submits an operator operation and says whether it completed; a refusal, a pending or failed run, or a pause is shown, not thrown. */
export type RunOperation = (request: Record<string, unknown>, workspace?: string, operationId?: string) => Promise<boolean>;

export const TRANSITIONING_STATUS = "This channel is transitioning. Sync and posting are paused until its access changes finish.";

/** The HTTP status a failure stands for, whether a host, the operator or the engine answered: a channel paused or archived is 409. */
export function httpStatus(error: unknown): number | undefined {
  if (error instanceof SpaceCredentialError || error instanceof XrpcError || error instanceof OperatorRemoteError) return error.status;
  if (error instanceof ChannelUnavailableError) return 409;
  return undefined;
}
/** The operator answered that the workspace authority must approve the operator's grant first, or again. */
export function needsAuthorityApproval(error: unknown): boolean {
  return error instanceof OperatorRemoteError && (error.code === "AuthorizationRequired" || error.code === "AuthoritySessionUnavailable");
}
export function isAccessFailure(error: unknown): boolean { return [401, 403, 409].includes(httpStatus(error) ?? 0); }
export function messageOf(error: unknown): string { return error instanceof Error ? error.message : "Request failed."; }

/** The protocol layer's `parseWorkspaceUri` for a link a person pasted: surrounding whitespace is ignored. */
export function parsePastedWorkspaceUri(uri: string): { authorityDid: string; skey: string } | null {
  return parseWorkspaceSpaceUri(uri.trim());
}

/** Parses either a bare Group DID (`did:plc:...` / `did:web:...`) or a canonical workspace space URI. */
export function parsePastedGroupOrWorkspace(raw: string): { groupDid: string; workspaceUri: string } | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (isDid(trimmed)) {
    return { groupDid: trimmed, workspaceUri: workspaceUri(trimmed, SELF_SKEY) };
  }
  const parsed = parseWorkspaceSpaceUri(trimmed);
  return parsed ? { groupDid: parsed.authorityDid, workspaceUri: trimmed } : null;
}

export function withReactions(messages: Array<Omit<Message, "reactions">>, reactions: Reaction[], viewerDid: string): Message[] {
  const grouped = new Map<string, Map<string, { count: number; active: boolean }>>();
  for (const reaction of reactions) {
    if (typeof reaction.value.subject !== "string" || typeof reaction.value.emoji !== "string") continue;
    const emojis = grouped.get(reaction.value.subject) ?? new Map<string, { count: number; active: boolean }>();
    const current = emojis.get(reaction.value.emoji) ?? { count: 0, active: false };
    current.count += 1;
    if (reaction.repo === viewerDid) current.active = true;
    emojis.set(reaction.value.emoji, current);
    grouped.set(reaction.value.subject, emojis);
  }
  return messages.map((message) => ({
    ...message,
    reactions: [...(grouped.get(message.uri) ?? new Map()).entries()].map(([emoji, value]) => ({ emoji, ...value })),
  }));
}

/** Top-level messages keep their incoming order; each reply follows its parent, oldest first. A reply whose parent is not loaded stays in place. */
export function threadMessages(messages: readonly Message[]): Array<{ message: Message; isReply: boolean }> {
  const loaded = new Set(messages.map(({ uri }) => uri));
  const isThreaded = (message: Message): boolean => message.value.parent !== undefined && loaded.has(message.value.parent);
  const repliesByParent = new Map<string, Message[]>();
  for (const message of messages.filter(isThreaded)) {
    const parent = message.value.parent!;
    repliesByParent.set(parent, [message, ...(repliesByParent.get(parent) ?? [])]);
  }
  return messages.filter((message) => !isThreaded(message)).flatMap((message) => [
    { message, isReply: false },
    ...(repliesByParent.get(message.uri) ?? []).map((reply) => ({ message: reply, isReply: true })),
  ]);
}

export function mergeMessages(current: Message[], incoming: Message[], append: boolean): Message[] {
  const combined = append ? [...current, ...incoming] : incoming;
  const unique = new Map(combined.map((message) => [message.uri, message]));
  return [...unique.values()].sort((a, b) => b.rkey.localeCompare(a.rkey));
}

export function splitDids(value: string): string[] { return value.split(/[\s,]+/).filter(Boolean); }

export function makeTid(): string {
  const random = new Uint16Array(1);
  crypto.getRandomValues(random);
  let value = (BigInt(Date.now()) * 1000n << 10n) | BigInt(random[0] & 1023);
  const alphabet = "234567abcdefghijklmnopqrstuvwxyz";
  let result = "";
  for (let index = 0; index < 13; index += 1) { result = alphabet[Number(value & 31n)] + result; value >>= 5n; }
  return result;
}
/** Everything this app keeps in sessionStorage belongs to the signed-in account (pending invites, operations, names). */
export function clearAccountScopedState(storage: Pick<Storage, "length" | "key" | "removeItem">, keep: readonly string[] = []): void {
  const keys: string[] = [];
  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index);
    if (key?.startsWith("spaces.") && !keep.includes(key)) keys.push(key);
  }
  for (const key of keys) storage.removeItem(key);
}

export const INVITE_LINK_KEY = "spaces.inviteLink";
export { RETURN_TO_KEY } from "../../lib/return-to";

/** Set on the sign-in page after a sign-out that did not fully hold: `?signout=` the parts that did not, comma-separated. */
export const SIGN_OUT_PARAM = "signout";
/** The account's host could not be told: its session ends when it expires. */
export const SIGN_OUT_UNREVOKED = "unrevoked";
/** What the account kept in this browser could not all be deleted (another tab held its store). */
export const SIGN_OUT_KEPT = "kept";

/** A link an admin can send: opening it signs the recipient in and offers to join the workspace. */
export function inviteLinkFor(origin: string, workspaceUri: string): string {
  return `${origin}/?invite=${encodeURIComponent(workspaceUri)}`;
}

/** The workspace an invite link names, or null when the query string has none or it is malformed. */
export function workspaceFromInviteSearch(search: string): string | null {
  const value = new URLSearchParams(search).get("invite");
  return value && parsePastedWorkspaceUri(value) ? value.trim() : null;
}

/** Remembers an invite link across the sign-in redirects, and returns the workspace it names. */
export function captureInviteLink(search: string, storage: Pick<Storage, "setItem">): string | null {
  const workspace = workspaceFromInviteSearch(search);
  if (workspace) storage.setItem(INVITE_LINK_KEY, workspace);
  return workspace;
}

export const WORKSPACE_OPERATION_KEY = "spaces.pendingWorkspaceOperation";
export const PENDING_OPERATOR_OPERATION_KEY = "spaces.pendingOperatorOperation";

function isPendingOperationShape(value: unknown): value is PendingOperation {
  return (
    Boolean(value) &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    typeof (value as { workspace?: unknown }).workspace === "string" &&
    typeof (value as { operationId?: unknown }).operationId === "string" &&
    Boolean((value as { request?: unknown }).request) &&
    typeof (value as { request?: unknown }).request === "object" &&
    !Array.isArray((value as { request?: unknown }).request)
  );
}

/**
 * Reads persisted pending Operator mutations (`spaces.pendingOperatorOperation`), supporting both
 * the ordered multi-operation array format and legacy single-object entries.
 */
export function readPendingOperatorOperations(
  storage: Pick<Storage, "getItem" | "removeItem">,
): PendingOperation[] {
  const raw = storage.getItem(PENDING_OPERATOR_OPERATION_KEY);
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      const valid = parsed.filter(isPendingOperationShape);
      if (valid.length === 0) storage.removeItem(PENDING_OPERATOR_OPERATION_KEY);
      return valid;
    }
    if (isPendingOperationShape(parsed)) {
      return [parsed];
    }
    storage.removeItem(PENDING_OPERATOR_OPERATION_KEY);
    return [];
  } catch {
    storage.removeItem(PENDING_OPERATOR_OPERATION_KEY);
    return [];
  }
}

/**
 * Non-destructively records or promotes `entry` to the top of the pending Operator operation stack
 * without erasing any earlier uncompleted operation's retry payload.
 */
export function upsertPendingOperatorOperation(
  storage: Pick<Storage, "getItem" | "setItem" | "removeItem">,
  entry: PendingOperation,
): PendingOperation[] {
  const existing = readPendingOperatorOperations(storage).filter(
    (item) => item.operationId !== entry.operationId,
  );
  const next = [...existing, entry];
  storage.setItem(PENDING_OPERATOR_OPERATION_KEY, JSON.stringify(next));
  return next;
}

/**
 * Compare-and-swap removal of a terminal Operator operation by `operationId`, leaving all other
 * pending operations intact in storage.
 */
export function clearPendingOperatorOperation(
  storage: Pick<Storage, "getItem" | "setItem" | "removeItem">,
  operationId: string,
): PendingOperation[] {
  const next = readPendingOperatorOperations(storage).filter(
    (item) => item.operationId !== operationId,
  );
  if (next.length === 0) {
    storage.removeItem(PENDING_OPERATOR_OPERATION_KEY);
  } else {
    storage.setItem(PENDING_OPERATOR_OPERATION_KEY, JSON.stringify(next));
  }
  return next;
}

/** A workspace being created: its name, join policy, public metadata discovery toggle, and optional account override. */
export type WorkspaceCreationInput = {
  name: string;
  account?: string;
  joinPolicy?: "open" | "approval" | "invite";
  publicMeta?: boolean;
};

/**
 * The creation the form describes, as the operator keys it: trimmed name, normalized joinPolicy, and publicMeta.
 */
export function workspaceCreationFrom(form: WorkspaceCreationInput, did: string): WorkspaceCreationInput {
  const account = (form.account ?? "").trim();
  const joinPolicy =
    form.joinPolicy === "open" || form.joinPolicy === "approval" || form.joinPolicy === "invite"
      ? form.joinPolicy
      : undefined;
  return {
    name: form.name.trim(),
    account: account === did ? "" : account,
    ...(joinPolicy !== undefined ? { joinPolicy } : {}),
    ...(typeof form.publicMeta === "boolean" ? { publicMeta: form.publicMeta } : {}),
  };
}

/**
 * The operation ID for creating this workspace: the stored one only if it was issued for this exact creation intent, so
 * fixing a typo or changing joinPolicy/publicMeta never conflicts with an earlier key.
 */
export function workspaceOperationIdFor(creation: WorkspaceCreationInput, stored: string | null, mint: () => string = makeTid): string {
  const previous = parseStoredOperation(stored);
  const matches =
    previous !== null &&
    previous.name === creation.name &&
    (previous.account ?? "") === (creation.account ?? "") &&
    (previous.joinPolicy ?? "invite") === (creation.joinPolicy ?? "invite") &&
    (previous.publicMeta ?? true) === (creation.publicMeta ?? true);
  return matches ? previous.operationId : mint();
}

function parseStoredOperation(stored: string | null): (WorkspaceCreationInput & { operationId: string }) | null {
  if (!stored) return null;
  try {
    const value: unknown = JSON.parse(stored);
    if (value && typeof value === "object" && "name" in value && "account" in value && "operationId" in value
      && typeof value.name === "string" && typeof value.account === "string" && typeof value.operationId === "string") {
      const obj = value as Record<string, unknown>;
      const joinPolicy =
        obj.joinPolicy === "open" || obj.joinPolicy === "approval" || obj.joinPolicy === "invite"
          ? obj.joinPolicy
          : undefined;
      return {
        name: value.name,
        account: value.account,
        operationId: value.operationId,
        ...(joinPolicy !== undefined ? { joinPolicy } : {}),
        ...(typeof obj.publicMeta === "boolean" ? { publicMeta: obj.publicMeta } : {}),
      };
    }
  } catch {
    return null;
  }
  return null;
}

export function makeShortId(): string { return makeTid().slice(-5); }
export function toSlug(value: string): string { return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 50) || "channel"; }
