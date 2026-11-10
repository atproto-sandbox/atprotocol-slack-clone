import { NextResponse } from "next/server";
import { authorityClientMetadata } from "@/operator/authority-grant";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json(authorityClientMetadata(), { headers: { "cache-control": "public, max-age=300" } });
}
