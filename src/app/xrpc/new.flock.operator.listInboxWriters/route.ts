import { type NextRequest } from "next/server";
import { listInboxWriters } from "@/operator/operations";
import { withOperatorActor } from "@/operator/http";
import { OPERATOR_METHOD } from "@/protocol/nsids";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  const workspace = request.nextUrl.searchParams.get("workspace") ?? "";
  return withOperatorActor(request, OPERATOR_METHOD.listInboxWriters, workspace, listInboxWriters);
}
