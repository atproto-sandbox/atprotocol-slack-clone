import { IndexedDbStore } from "@flock/client/indexeddb-store";
import { forgetBrowserDmStore } from "@flock/client/dm/browser-store";
import { within } from "../lib/within";

/** What a sign-out achieved: the session revoked at its host, and what the account kept in this browser deleted. */
export type SignOutResult = { revoked: boolean; erased: boolean };

/** How long a store's deletion is waited for: a connection that does not let go (another tab) must not hold anything up. */
export const ERASE_WITHIN_MS = 5_000;

/**
 * Signs the account out of this browser: its DM state forgotten, its store deleted, and its session revoked at its host
 * (`revoke`: `signOut` in ./session). The revoke and the deletion are each tried whatever happens to the other, and the result
 * says which held. Never rejects.
 */
export async function signOutAccount(did: string, revoke: () => Promise<void>): Promise<SignOutResult> {
  const erasing = Promise.all([
    Promise.resolve().then(() => forgetBrowserDmStore(did)),
    within(IndexedDbStore.deleteAccount(did), ERASE_WITHIN_MS),
  ]);
  const [revoked, erased] = await Promise.allSettled([Promise.resolve().then(revoke), erasing]);
  return { revoked: revoked.status === "fulfilled", erased: erased.status === "fulfilled" };
}
