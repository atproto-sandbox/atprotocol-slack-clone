import { type NextRequest } from "next/server";
import { withOperatorActor } from "@/operator/http";
import { listStalledWork } from "@/operator/stalled";
import { OPERATOR_METHOD } from "@/protocol/nsids";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  const workspace = request.nextUrl.searchParams.get("workspace") ?? "";
  return withOperatorActor(request, OPERATOR_METHOD.listStalledOperations, workspace, async (actor) => {
    const { operations, registrations, truncated } = listStalledWork(actor.workspace.authorityDid, actor.workspace.uri);
    // The lexicon has no null: an operation without an error leaves the field out.
    return { operations: operations.map(({ error, ...operation }) => (error === null ? operation : { ...operation, error })), registrations, truncated };
  });
}
