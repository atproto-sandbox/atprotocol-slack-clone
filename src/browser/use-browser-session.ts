import { useCallback, useEffect, useRef, useState } from "react";
import { generateSpaceKey } from "@/atproto/space-key";
import { createEngine, type Engine } from "@/client/engine";
import { IndexedDbStore } from "@/client/indexeddb-store";
import type { ClientTransport } from "@/client/transport";
import { LiveSpaces, Snapshots } from "@/client/views";
import { DmClient } from "@/dm/dm-client";
import { createBrowserDmStore, type BrowserDmStore } from "@/dm/browser-store";
import { resolveKemKey, resolvePds } from "./identity";
import type { BrowserSessionConfig } from "./session";

export type BrowserSessionStatus = "disconnected" | "connecting" | "ready" | "error";

/** What the signed-in account's browser session gives the UI: its DM client, its engine, and the engine's live views. */
export type BrowserSessionState = {
  status: BrowserSessionStatus;
  client: DmClient | null;
  store: BrowserDmStore | null;
  engine: Engine | null;
  snapshots: Snapshots | null;
  live: LiveSpaces | null;
  error: string;
  connect: () => void;
  disconnect: () => Promise<void>;
};

type Built = { client: DmClient; store: BrowserDmStore; engine: Engine; snapshots: Snapshots; live: LiveSpaces; syncStore: IndexedDbStore };

/**
 * Restores the browser-held session for the signed-in DID (one grant: the member set, the operator methods and the DM set)
 * and builds on it the `DmClient` and the engine, over this account's IndexedDB store (D10), with the operator at the app's
 * own origin until it runs as its own service (R7). The OAuth client loads through a dynamic import so its module graph never
 * runs outside the browser; space signing keys are non-extractable WebCrypto P-256 keys.
 */
export function useBrowserSession(did: string, config: BrowserSessionConfig): BrowserSessionState {
  const { appUrl, plcUrl, scope, serviceRef, loopback } = config;
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
        const { restoreSession, sessionXrpcClient } = await import("./session");
        if (epoch.current !== run) return;
        setStatus("connecting");
        setError("");
        const session = await restoreSession(did, { appUrl, plcUrl, scope, serviceRef, loopback });
        if (epoch.current !== run) return;
        if (!session) {
          setStatus("disconnected");
          return;
        }
        const identity = { plcUrl, loopback };
        const transport: ClientTransport = {
          did,
          memberClient: sessionXrpcClient(session),
          resolvePds: (target) => resolvePds(target, identity),
          resolveKemKey: (target, forceRefresh) => resolveKemKey(target, identity, forceRefresh),
          fetchEndpoint: (request) => fetch(request, { redirect: "error" }),
          generateKey: generateSpaceKey,
        };
        // A store another account left behind (a crash before its sign-out) goes before this account's opens.
        await IndexedDbStore.deleteOtherAccounts(did);
        const syncStore = await IndexedDbStore.open(did, indexedDB, () => {
          if (epoch.current !== run) return;
          // What was built on the closed store goes, so nothing keeps reading it.
          epoch.current += 1;
          made?.live.stop();
          if (builtRef.current === made) builtRef.current = null;
          setBuilt(null);
          setError("Another account started in this browser in another tab. Connect this browser again to continue here.");
          setStatus("error");
        });
        const engine = createEngine(transport, { store: syncStore, operator: { serviceRef, endpoint: appUrl } });
        const snapshots = new Snapshots();
        const live = new LiveSpaces(snapshots, { operator: engine.operator!, credentials: engine.credentials });
        const store = createBrowserDmStore(did);
        made = { client: new DmClient({ ...transport, store }), store, engine, snapshots, live, syncStore };
        if (epoch.current !== run) {
          syncStore.close();
          return;
        }
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
      made?.live.stop();
      made?.syncStore.close();
      if (builtRef.current === made) builtRef.current = null;
    };
  }, [did, appUrl, plcUrl, scope, serviceRef, loopback]);

  const connect = useCallback(() => {
    setStatus("connecting");
    setError("");
    void (async () => {
      try {
        const { connectSession } = await import("./session");
        await connectSession(did, { appUrl, plcUrl, scope, serviceRef, loopback });
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : "Could not connect.");
        setStatus("error");
      }
    })();
  }, [did, appUrl, plcUrl, scope, serviceRef, loopback]);

  const disconnect = useCallback(async () => {
    setError("");
    try {
      const { disconnectSession } = await import("./session");
      await disconnectSession({ appUrl, plcUrl, scope, serviceRef, loopback });
    } finally {
      epoch.current += 1;
      const current = builtRef.current;
      builtRef.current = null;
      current?.live.stop();
      current?.syncStore.close();
      setBuilt(null);
      setStatus("disconnected");
    }
  }, [appUrl, plcUrl, scope, serviceRef, loopback]);

  return {
    status, error, connect, disconnect,
    client: built?.client ?? null, store: built?.store ?? null,
    engine: built?.engine ?? null, snapshots: built?.snapshots ?? null, live: built?.live ?? null,
  };
}
