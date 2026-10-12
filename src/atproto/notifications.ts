import type * as RegisterNotify from "@/lexicons/api/types/com/atproto/space/registerNotify";
import { resolvePds } from "@/atproto/identity";
import type { SpaceCredential } from "@/atproto/space-credential";
import { getConfig } from "@/lib/config";
import { getRawDb } from "@/lib/db";
import { parseSpaceUri } from "@/protocol/keys";

const RENEW_BEFORE_MS = 60 * 60 * 1000;

export async function registerSpaceNotifications(credential: SpaceCredential, space: string): Promise<boolean> {
  const serviceRef = getConfig().operatorServiceRef;
  const authorityDid = parseSpaceAuthority(space);
  const now = Date.now();
  const prior = getRawDb().prepare("SELECT expires_at FROM notification_registration WHERE service_ref=? AND space_uri=?")
    .get(serviceRef, space) as { expires_at: number } | undefined;
  if (prior && prior.expires_at > now + RENEW_BEFORE_MS) return true;
  try {
    const pds = await resolvePds(authorityDid);
    const result = await credential.client(pds).procedure<RegisterNotify.InputSchema, RegisterNotify.OutputSchema>(
      "com.atproto.space.registerNotify", { space, service: serviceRef },
    );
    const expiresAt = Date.parse(result.expiresAt);
    if (!Number.isFinite(expiresAt)) return false;
    getRawDb().prepare(`INSERT INTO notification_registration (service_ref,space_uri,expires_at) VALUES (?,?,?)
      ON CONFLICT(service_ref,space_uri) DO UPDATE SET expires_at=excluded.expires_at`).run(serviceRef, space, expiresAt);
    return true;
  } catch {
    return false;
  }
}

export function parseSpaceAuthority(space: string): string {
  const parsed = parseSpaceUri(space);
  if (!parsed) throw new Error("Invalid permissioned space URI.");
  return parsed.authorityDid;
}
