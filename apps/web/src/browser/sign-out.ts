import { IndexedDbStore } from "@flock/client/indexeddb-store";
import { forgetBrowserDmStore } from "@flock/client/dm/browser-store";
import { within } from "../lib/within";
import { deleteGroupOAuthDatabase, revokeAndEraseGroupOAuthSessions } from "./group-session";
import type { BrowserSessionConfig } from "./session";

/** What a sign-out achieved: the session revoked at its host, and what the account kept in this browser deleted. */
export type SignOutResult = { revoked: boolean; erased: boolean };

/** How long a store's deletion is waited for: a connection that does not let go (another tab) must not hold anything up. */
export const ERASE_WITHIN_MS = 5_000;

/**
 * Signs the account out of this browser: its DM state forgotten, its sync store and Group OAuth database deleted, and its
 * personal and Group-DID sessions revoked at their hosts (`revoke`: `signOut` in ./session). The revoke and the deletion are
 * each tried whatever happens to the other, and the result says which held. Never rejects.
 */
export async function signOutAccount(
  did: string,
  revoke: () => Promise<void>,
  options?: { config?: Pick<BrowserSessionConfig, "appUrl" | "plcUrl" | "loopback" | "groupHostUrl">; idbFactory?: IDBFactory },
): Promise<SignOutResult> {
  const idb = options?.idbFactory ?? (typeof indexedDB !== "undefined" ? indexedDB : undefined);
  const groupCleanup = options?.config
    ? within(revokeAndEraseGroupOAuthSessions(did, { config: options.config, idbFactory: idb }), ERASE_WITHIN_MS).catch(
        () => ({ revokedAll: false, erased: false }),
      )
    : within(deleteGroupOAuthDatabase(did, idb), ERASE_WITHIN_MS).then(
        () => ({ revokedAll: true, erased: true }),
        () => ({ revokedAll: true, erased: false }),
      );

  const erasing = Promise.all([
    Promise.resolve().then(() => forgetBrowserDmStore(did)),
    within(IndexedDbStore.deleteAccount(did, idb), ERASE_WITHIN_MS),
    groupCleanup,
  ]);
  const [revoked, erased] = await Promise.allSettled([Promise.resolve().then(revoke), erasing]);
  const groupResult = erased.status === "fulfilled" ? erased.value[2] : { revokedAll: false, erased: false };
  return {
    revoked: revoked.status === "fulfilled" && groupResult.revokedAll,
    erased: erased.status === "fulfilled" && groupResult.erased,
  };
}
