import type { OAuthSession } from "@atproto/oauth-client-node";
import { putSpaceMember, removeSpaceMember } from "../atproto/space-ops";
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

export async function removeListMember(session: OAuthSession, space: string, did: string): Promise<void> {
  try {
    await removeSpaceMember(session, space, did);
  } finally {
    dropMemberList(space);
  }
}
