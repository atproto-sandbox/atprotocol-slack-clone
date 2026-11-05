import { isDid } from "@/protocol/keys";
import type { DmClient, DmHalfStatus, DmRequestMode, DmSkippedSenders } from "./dm-client";

/** The workspace surface DM UI needs; `@/workspaces/*` stays server-only for `src/dm/**`. */
export type UiWorkspace = { uri: string; name: string; members: ReadonlyArray<{ did: string; active: boolean }> };

export type ParticipantInput = { dids: string[]; invalid: string[] };

/** Parses a comma/whitespace-separated DID list, keeping first-seen order. */
export function parseParticipantInput(value: string): ParticipantInput {
  const dids: string[] = [];
  const invalid: string[] = [];
  for (const token of value.split(/[,\s]+/)) {
    if (token.length === 0) continue;
    if (!isDid(token)) {
      invalid.push(token);
      continue;
    }
    if (!dids.includes(token)) dids.push(token);
  }
  return { dids, invalid };
}

/**
 * The sidebar default filter: a conversation shows under an active workspace
 * when every participant except the viewer is one of that workspace's members.
 * `memberDids` of `null` (no active workspace) shows everything.
 */
export function conversationVisible(input: {
  participants: readonly string[];
  viewerDid: string;
  memberDids: readonly string[] | null;
  showAll: boolean;
}): boolean {
  if (input.showAll || input.memberDids === null) return true;
  return input.participants.every((did) => did === input.viewerDid || input.memberDids!.includes(did));
}

/** Members of any of the viewer's workspaces, without the viewer, sorted and deduplicated. */
export function coMemberDids(workspaces: readonly UiWorkspace[], viewerDid: string): string[] {
  const members = new Set<string>();
  for (const workspace of workspaces) {
    for (const member of workspace.members) {
      if (member.did !== viewerDid) members.add(member.did);
    }
  }
  return [...members].sort();
}

export function sharesAnyWorkspace(did: string, workspaces: readonly UiWorkspace[]): boolean {
  return workspaces.some((workspace) => workspace.members.some((member) => member.did === did));
}

/** Display label for a participant: its handle once resolved, else a shortened DID. */
export function participantLabel(did: string, labels: Readonly<Record<string, string>>): string {
  return labels[did] ?? `${did.slice(0, 17)}…`;
}

export function conversationLabel(input: { participants: readonly string[]; viewerDid: string; labels: Readonly<Record<string, string>> }): string {
  const others = input.participants.filter((did) => did !== input.viewerDid);
  const shown = others.slice(0, 3).map((did) => participantLabel(did, input.labels));
  return others.length > 3 ? `${shown.join(", ")} +${others.length - 3}` : shown.join(", ");
}

/**
 * The settings panel's allowlist edit (M4 review carry-over): with an empty
 * allowlist the PDS cannot tell "Only people I allow" apart from "Nobody", so
 * `allow` parks the first entry dormant. Every edit therefore re-asserts the
 * mode the user selected, so the stored state matches what they chose.
 */
export async function applyAllowlistEdit(client: DmClient, input: { mode: DmRequestMode; add?: readonly string[]; remove?: readonly string[] }): Promise<void> {
  if (input.add && input.add.length > 0) await client.allow(input.add);
  if (input.remove && input.remove.length > 0) await client.disallow(input.remove);
  await client.setRequestMode(input.mode);
}

export function describeSkippedSenders(skipped: DmSkippedSenders): string {
  const senders = (count: number) => `${count} ${count === 1 ? "sender" : "senders"}`;
  const reasons: string[] = [];
  if (skipped.oversizedWriters.length > 0) reasons.push(`${senders(skipped.oversizedWriters.length)} sent too many requests`);
  if (skipped.failedWriters.length > 0) reasons.push(`${senders(skipped.failedWriters.length)} could not be reached`);
  if (skipped.writerSetTruncated) reasons.push("more senders exist than could be scanned");
  return reasons.length > 0 ? `Some senders were skipped: ${reasons.join("; ")}.` : "";
}

/**
 * What an open conversation keeps when its newest page is read again. The new read is the truth for its own
 * window, so an edited, deleted or un-reacted entry drops out; copies from a half that can no longer be read
 * (left, deleted, revoked) stay, because copies already fetched are not recalled.
 */
export function retainAfterRefresh<T extends { ownerDid: string }>(
  current: readonly T[],
  halves: Readonly<Record<string, DmHalfStatus>>,
  inWindow: (entry: T) => boolean,
): T[] {
  return current.filter((entry) => !inWindow(entry) || halves[entry.ownerDid] !== "ok");
}

/**
 * One background cycle of the DM view: refresh, re-send pending requests, register for notifications, repair the public
 * declaration. After the refresh each step runs on its own, so a failure in one (a notification service that is down) never keeps
 * the others from running, and every failure is reported. The declaration is marked checked only once it succeeded.
 */
export async function runDmCycle(input: {
  refresh: () => Promise<{ exists: boolean } | null>;
  client: Pick<DmClient, "renotifyPending" | "watch" | "ensureDeclaration">;
  inboxUri: string;
  serviceRef: string;
  declarationChecked: { current: boolean };
  report: (error: unknown) => void;
}): Promise<void> {
  let inbox: { exists: boolean } | null;
  try {
    inbox = await input.refresh();
  } catch (error) {
    input.report(error);
    return;
  }
  const step = async (run: () => Promise<unknown>): Promise<void> => {
    try {
      await run();
    } catch (error) {
      input.report(error);
    }
  };
  await step(() => input.client.renotifyPending());
  if (!inbox?.exists) return;
  await step(() => input.client.watch([input.inboxUri], input.serviceRef));
  if (!input.declarationChecked.current) {
    await step(async () => {
      await input.client.ensureDeclaration();
      input.declarationChecked.current = true;
    });
  }
}

const HALF_CHIPS: Record<DmHalfStatus, string | null> = {
  ok: null,
  missing: "hasn't replied or removed your access",
  deleted: "left",
  revoked: "revoked your access",
};

/**
 * The note shown beside a participant for the state of their half. A half whose state is not known yet (the first page has not
 * loaded) shows nothing: calling it missing would tell the viewer, for a moment, that their own half does not exist.
 */
export function halfChip(status: DmHalfStatus | undefined): string | null {
  return status === undefined ? null : HALF_CHIPS[status];
}
