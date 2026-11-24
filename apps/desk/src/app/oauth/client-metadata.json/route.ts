import { NextResponse } from "next/server";
import { getDeskConfig } from "@flock/deployment/config";
import { deskMemberScopes } from "@flock/protocol/scopes";
import { buildDeskClientMetadata } from "@flock/shell/client-metadata";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const { appUrl } = getDeskConfig();
  const metadata = buildDeskClientMetadata({
    appUrl: appUrl.origin,
    scope: deskMemberScopes().join(" "),
  });
  return NextResponse.json(metadata, { headers: { "cache-control": "public, max-age=300" } });
}
