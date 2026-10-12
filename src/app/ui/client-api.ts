import { AUTHORIZATION_REQUIRED } from "@/lib/api-codes";

export type Message = { uri: string; rkey: string; repo: string; value: { text?: string; createdAt?: string; parent?: string }; reactions?: Array<{ emoji: string; count: number; active: boolean }> };
export type Reaction = { repo: string; value: { subject?: string; emoji?: string } };
export type InboxRequest = { uri: string; repoDid: string; channelSkey: string; channelName: string; requestId: string; createdAt: string };
export type ChannelSelection = { workspace: string; skey: string; name: string; visibility: string };
export type PendingOperation = { workspace: string; operationId: string; request: Record<string, unknown> };
export type StalledOperation = { actor: string; operationId: string; state: string; error: string | null; updatedAt: string };
export type RunOperation = (request: Record<string, unknown>, workspace?: string, operationId?: string) => Promise<void>;
export type Grant = (action: string, workspaceUri?: string, skey?: string) => Promise<void>;

export const TRANSITIONING_STATUS = "This channel is transitioning. Sync and posting are paused until its access changes finish.";

export async function api<T = unknown>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { ...init, headers: { ...(init?.body ? { "content-type": "application/json" } : {}), ...init?.headers }, cache: "no-store" });
  const body = await response.json().catch(() => null) as (T & { error?: string; code?: string }) | null;
  if (!response.ok) {
    throw new ApiError(response.status, body && typeof body.error === "string" ? body.error : `Request failed (${response.status}).`, body && typeof body.code === "string" ? body.code : undefined);
  }
  return body as T;
}

export class ApiError extends Error { constructor(readonly status: number, message: string, readonly code?: string) { super(message); } }
export function httpStatus(error: unknown): number | undefined { return error instanceof ApiError ? error.status : undefined; }
export function isAuthorizationRequired(error: unknown): boolean { return error instanceof ApiError && error.status === 403 && error.code === AUTHORIZATION_REQUIRED; }
export function isAccessFailure(error: unknown): boolean { return [401, 403, 409].includes(httpStatus(error) ?? 0); }
export function messageOf(error: unknown): string { return error instanceof Error ? error.message : "Request failed."; }

export function parseWorkspaceUri(uri: string): { authorityDid: string; skey: string } | null {
  const match = /^at:\/\/(did:[a-z0-9]{1,64}:[A-Za-z0-9._:%-]{1,512})\/space\/org\.slack\.workspace\/([A-Za-z0-9._~:-]{1,128})$/.exec(uri.trim());
  return match ? { authorityDid: match[1], skey: match[2] } : null;
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

/** A link an admin can send: opening it signs the recipient in and offers to join the workspace. */
export function inviteLinkFor(origin: string, workspaceUri: string): string {
  return `${origin}/?invite=${encodeURIComponent(workspaceUri)}`;
}

/** The workspace an invite link names, or null when the query string has none or it is malformed. */
export function workspaceFromInviteSearch(search: string): string | null {
  const value = new URLSearchParams(search).get("invite");
  return value && parseWorkspaceUri(value) ? value.trim() : null;
}

/** Remembers an invite link across the sign-in redirects, and returns the workspace it names. */
export function captureInviteLink(search: string, storage: Pick<Storage, "setItem">): string | null {
  const workspace = workspaceFromInviteSearch(search);
  if (workspace) storage.setItem(INVITE_LINK_KEY, workspace);
  return workspace;
}

export const WORKSPACE_OPERATION_KEY = "spaces.pendingWorkspaceOperation";

/** The operation ID for creating `name`: the stored one only if it was issued for this exact name, so fixing a typo never conflicts with it. */
export function workspaceOperationIdFor(name: string, stored: string | null, mint: () => string = makeTid): string {
  const previous = parseStoredOperation(stored);
  return previous && previous.name === name ? previous.operationId : mint();
}

function parseStoredOperation(stored: string | null): { name: string; operationId: string } | null {
  if (!stored) return null;
  try {
    const value: unknown = JSON.parse(stored);
    if (value && typeof value === "object" && "name" in value && "operationId" in value && typeof value.name === "string" && typeof value.operationId === "string") {
      return { name: value.name, operationId: value.operationId };
    }
  } catch {
    return null;
  }
  return null;
}

export function makeShortId(): string { return makeTid().slice(-5); }
export function toSlug(value: string): string { return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 50) || "channel"; }
