import { NextResponse } from "next/server";
import { getConfig } from "@/lib/config";

export const runtime = "nodejs";

export async function GET() {
  const config = getConfig();
  const hash = config.operatorServiceRef.indexOf("#");
  const id = config.operatorServiceRef.slice(0, hash);
  const fragment = config.operatorServiceRef.slice(hash + 1);
  return NextResponse.json({
    "@context": ["https://www.w3.org/ns/did/v1", "https://w3id.org/security/suites/jws-2020/v1"],
    id,
    service: [{
      id: `${id}#${fragment}`,
      type: "AtprotoFlockOperator",
      serviceEndpoint: config.appUrl.origin,
    }],
  }, { headers: { "cache-control": "public, max-age=300" } });
}
