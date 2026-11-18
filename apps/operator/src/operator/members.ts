import type { OAuthSession } from "@atproto/oauth-client-node";
import { putSpaceMember, putSpaceMembers, removeSpaceMember, removeSpaceMembers } from "../atproto/space-ops";
import { dropMemberList } from "./member-access";

// The one way the operator changes a space's member list, so the change feed never answers from a list the operator itself
// has just changed.

export async function putListMember(session: OAuthSession, space: string, did: string, read: boolean, write: boolean): Promise<void> {
  try {
    await putSpaceMember(session, space, did, read, write);
  } finally {
    dropMemberList(space);
  }
}

export async function putListMembers(
  session: OAuthSession,
  space: string,
  members: ReadonlyArray<{ did: string; read: boolean; write: boolean }>,
): Promise<void> {
  if (members.length === 0) return;
  try {
    await putSpaceMembers(session, space, members);
  } finally {
    dropMemberList(space);
  }
}

export async function removeListMember(session: OAuthSession, space: string, did: string): Promise<void> {
  try {
    await removeSpaceMember(session, space, did);
  } finally {
    dropMemberList(space);
  }
}

export async function removeListMembers(session: OAuthSession, space: string, dids: readonly string[]): Promise<void> {
  if (dids.length === 0) return;
  try {
    await removeSpaceMembers(session, space, dids);
  } finally {
    dropMemberList(space);
  }
}
