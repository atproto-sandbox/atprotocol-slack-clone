import type { OAuthSession } from "@atproto/oauth-client-node";
import { parseWorkspaceUri } from "@/protocol/keys";

/** A workspace, named by its space URI and the parts of it. */
export type WorkspaceRef = { uri: string; authorityDid: string; skey: string };

/** Who an operator operation runs for, with the authority session it writes through. */
export type OperatorActor = { did: string; session: OAuthSession; workspace: WorkspaceRef; canRecoverOperations: boolean };

export function parseWorkspaceRef(uri: string): WorkspaceRef {
  const workspace = parseWorkspaceUri(uri);
  if (!workspace) throw new Error("Invalid workspace space URI.");
  return { uri, ...workspace };
}
