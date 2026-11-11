import { NextResponse } from "next/server";
import { memberGrantScopes } from "@/protocol/scopes";
import { buildBrowserClientMetadata } from "@/browser/client-metadata";
import { getConfig } from "@/lib/config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const { appUrl, operatorServiceRef } = getConfig();
  const metadata = buildBrowserClientMetadata({ appUrl: appUrl.origin, scope: memberGrantScopes(operatorServiceRef).join(" ") });
  return NextResponse.json(metadata, { headers: { "cache-control": "public, max-age=300" } });
}
