import { parseWorkspaceUri as parseWorkspaceSpaceUri } from "@flock/protocol/keys";
import { SpaceCredentialError } from "@flock/protocol/atproto/space-credential-core";
import { XrpcError } from "@flock/protocol/atproto/xrpc";
import { ChannelUnavailableError } from "@flock/client/errors";
import { OperatorRemoteError } from "@flock/client/operator-client";

export type Message = { uri: string; rkey: string; repo: string; value: { text?: string; createdAt?: string; parent?: string }; reactions?: Array<{ emoji: string; count: number; active: boolean }> };
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

/** A workspace being created: its name, and its workspace account's DID ("" for the person's own account). */
export type WorkspaceCreationInput = { name: string; account: string };

/**
 * The creation the form describes, as the operator keys it: the trimmed name, and no workspace account when the one typed
 * is the person's own, since that is a workspace they own rather than one they are a member of.
 */
export function workspaceCreationFrom(form: WorkspaceCreationInput, did: string): WorkspaceCreationInput {
  const account = form.account.trim();
  return { name: form.name.trim(), account: account === did ? "" : account };
}

/**
 * The operation ID for creating this workspace: the stored one only if it was issued for this exact name and account, so
 * fixing a typo in either never conflicts with it.
 */
export function workspaceOperationIdFor(creation: WorkspaceCreationInput, stored: string | null, mint: () => string = makeTid): string {
  const previous = parseStoredOperation(stored);
  return previous && previous.name === creation.name && previous.account === creation.account ? previous.operationId : mint();
}

function parseStoredOperation(stored: string | null): (WorkspaceCreationInput & { operationId: string }) | null {
  if (!stored) return null;
  try {
    const value: unknown = JSON.parse(stored);
    if (value && typeof value === "object" && "name" in value && "account" in value && "operationId" in value
      && typeof value.name === "string" && typeof value.account === "string" && typeof value.operationId === "string") {
      return { name: value.name, account: value.account, operationId: value.operationId };
    }
  } catch {
    return null;
  }
  return null;
}

export function makeShortId(): string { return makeTid().slice(-5); }
export function toSlug(value: string): string { return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 50) || "channel"; }
