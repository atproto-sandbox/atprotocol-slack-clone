import { useCallback, useEffect, useRef, useState } from "react";
import { createEngine, type Engine } from "@flock/client/engine";
import { sessionTransport } from "@flock/client/session-transport";
import { IndexedDbStore } from "@flock/client/indexeddb-store";
import { LiveSpaces, Snapshots } from "@flock/client/views";
import { DmClient } from "@flock/client/dm/dm-client";
import { createBrowserDmStore, type BrowserDmStore } from "@flock/client/dm/browser-store";
import { captureReturnTo, RETURN_TO_KEY } from "../lib/return-to";
import { within } from "../lib/within";
import { ERASE_WITHIN_MS, signOutAccount, type SignOutResult } from "./sign-out";
import { registerShellSession } from "./shell-lifecycle";
import type { BrowserSessionConfig } from "./session";

/** How long a space stays in the browser store without being opened: the retention the server's cache had (30 days). */
const STORE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

export type BrowserSessionStatus = "disconnected" | "connecting" | "ready" | "error";

/** What the signed-in account's browser session gives the UI: its DM client, its engine, and the engine's live views. */
export type BrowserSessionState = {
  status: BrowserSessionStatus;
  client: DmClient | null;
  store: BrowserDmStore | null;
  engine: Engine | null;
  snapshots: Snapshots | null;
  live: LiveSpaces | null;
  needsNotifyScopeUpgrade: boolean;
  error: string;
  connect: () => void;
  signOut: () => Promise<SignOutResult>;
};

type Built = {
  client: DmClient;
  store: BrowserDmStore;
  engine: Engine;
  snapshots: Snapshots;
  live: LiveSpaces;
  syncStore: IndexedDbStore;
  releaseLifecycle: () => void;
  needsNotifyScopeUpgrade: boolean;
};

/**
 * Restores the browser-held session for the signed-in DID (one grant: the member set, the operator methods and the DM set)
 * and builds on it the `DmClient` and the engine, over this account's IndexedDB store (D10), with the operator at the app's
 * own origin until it runs as its own service (R7). The OAuth client loads through a dynamic import so its module graph never
 * runs outside the browser; space signing keys are non-extractable WebCrypto P-256 keys.
 */
export function useBrowserSession(did: string, config: BrowserSessionConfig): BrowserSessionState {
  const { appUrl, plcUrl, scope, serviceRef, operatorUrl, loopback } = config;
  const [status, setStatus] = useState<BrowserSessionStatus>("connecting");
  const [built, setBuilt] = useState<Built | null>(null);
  const [error, setError] = useState("");
  const epoch = useRef(0);
  /** What the current restore built, for the cleanup that stops it. */
  const builtRef = useRef<Built | null>(null);

  useEffect(() => {
    const run = ++epoch.current;
    let made: Built | null = null;
    void (async () => {
      try {
        const { restoreSession } = await import("./session");
        if (epoch.current !== run) return;
        setStatus("connecting");
        setError("");
        const session = await restoreSession({ appUrl, plcUrl, scope, serviceRef, operatorUrl, loopback });
        if (epoch.current !== run) return;
        if (!session) {
          setStatus("disconnected");
          return;
        }
        const transport = sessionTransport(session, { plcUrl, loopback }, (request) => fetch(request, { redirect: "error" }));
        // A store another account left behind (a crash before its sign-out, or one another tab held at its sign-out) goes before
        // this account's opens. One a tab still holds open is not waited for: a later start deletes it.
        await within(IndexedDbStore.deleteOtherAccounts(did), ERASE_WITHIN_MS).catch(() => undefined);
        const syncStore = await IndexedDbStore.open(did, indexedDB, () => {
          if (epoch.current !== run) return;
          // What was built on the closed store goes, so nothing keeps reading it.
          epoch.current += 1;
          made?.client.close();
          made?.live.stop();
          made?.releaseLifecycle();
          if (builtRef.current === made) builtRef.current = null;
          setBuilt(null);
          setError("Another tab of this app signed out, or started another account, and closed this account's store. Reload to continue here.");
          setStatus("error");
        });
        const engine = createEngine(transport, { store: syncStore, operator: { serviceRef, endpoint: operatorUrl } });
        // Spaces not opened for the retention period go, which bounds what is kept for spaces an account no longer reads.
        await engine.lifecycle.sweep(STORE_RETENTION_MS);
        const snapshots = new Snapshots();
        const live = new LiveSpaces(snapshots, {
          operator: engine.operator!,
          credentials: engine.credentials,
          onSpaceChanged: (space) => engine.sync.markSpaceStale(space),
        });
        const store = createBrowserDmStore(did);
        if (epoch.current !== run) {
          syncStore.close();
          return;
        }
        const releaseLifecycle = registerShellSession(engine, live);
        const needsNotifyScopeUpgrade = Boolean(session.needsNotifyScopeUpgrade);
        const client = new DmClient({
          ...transport,
          store,
          ...(needsNotifyScopeUpgrade ? {} : { operator: engine.operator }),
        });
        made = { client, store, engine, snapshots, live, syncStore, releaseLifecycle, needsNotifyScopeUpgrade };
        live.start();
        builtRef.current = made;
        setBuilt(made);
        setStatus("ready");
      } catch (caught) {
        if (epoch.current !== run) return;
        setError(caught instanceof Error ? caught.message : "Could not restore the session.");
        setStatus("error");
      }
    })();
    return () => {
      epoch.current += 1;
      made?.client.close();
      made?.live.stop();
      made?.releaseLifecycle();
      made?.syncStore.close();
      if (builtRef.current === made) builtRef.current = null;
    };
  }, [did, appUrl, plcUrl, scope, serviceRef, operatorUrl, loopback]);

  const connect = useCallback(() => {
    setStatus("connecting");
    setError("");
    captureReturnTo(window.location.pathname, window.location.search, sessionStorage);
    void (async () => {
      try {
        const { signIn, signOut: revoke } = await import("./session");
        // The session lacks a scope the app asks for. It is revoked first, so if another account is chosen at the host,
        // nothing of this one is left behind. The library forgets it here even when its host cannot be told, and consent
        // replaces it, so that failure does not stop the reconnect.
        await revoke({ appUrl, plcUrl, scope, serviceRef, operatorUrl, loopback }).catch(() => undefined);
        await signIn(did, { appUrl, plcUrl, scope, serviceRef, operatorUrl, loopback });
      } catch (caught) {
        sessionStorage.removeItem(RETURN_TO_KEY);
        setError(caught instanceof Error ? caught.message : "Could not connect.");
        setStatus("error");
      }
    })();
  }, [did, appUrl, plcUrl, scope, serviceRef, operatorUrl, loopback]);

  /** Sign-out: what was built on the session stops and lets go of the store, then the account is signed out. */
  const signOut = useCallback(async () => {
    setError("");
    epoch.current += 1;
    const current = builtRef.current;
    builtRef.current = null;
    current?.client.close();
    current?.live.stop();
    current?.releaseLifecycle();
    current?.syncStore.close();
    setBuilt(null);
    setStatus("disconnected");
    return signOutAccount(did, async () => (await import("./session")).signOut({ appUrl, plcUrl, scope, serviceRef, operatorUrl, loopback }));
  }, [did, appUrl, plcUrl, scope, serviceRef, operatorUrl, loopback]);

  return {
    status, error, connect, signOut,
    client: built?.client ?? null, store: built?.store ?? null,
    engine: built?.engine ?? null, snapshots: built?.snapshots ?? null, live: built?.live ?? null,
    needsNotifyScopeUpgrade: built?.needsNotifyScopeUpgrade ?? false,
  };
}
