import { NextResponse } from "next/server";
import { DM_BROWSER_SCOPES } from "@/auth/permission-sets";
import { buildDmClientMetadata } from "@/dm/client-metadata";
import { getConfig } from "@/lib/config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const { appUrl } = getConfig();
  const metadata = buildDmClientMetadata({ appUrl: appUrl.origin, scope: DM_BROWSER_SCOPES.join(" ") });
  return NextResponse.json(metadata, { headers: { "cache-control": "public, max-age=300" } });
}
