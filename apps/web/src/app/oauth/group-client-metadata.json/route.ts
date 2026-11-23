import { NextResponse } from "next/server";
import { getConfig } from "@flock/deployment/config";
import { buildGroupBrowserClientMetadata } from "../../../browser/client-metadata";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const { appUrl } = getConfig();
  const metadata = buildGroupBrowserClientMetadata({ appUrl: appUrl.origin });
  return NextResponse.json(metadata, { headers: { "cache-control": "public, max-age=300" } });
}
