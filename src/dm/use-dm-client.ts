import { useCallback, useEffect, useRef, useState } from "react";
import type { DpopKey } from "@/atproto/dpop";
import { DmClient } from "./dm-client";
import type { DmConfig } from "./browser-session";
import { resolvePds } from "./browser-identity";
import { createBrowserDmStore, type BrowserDmStore } from "./browser-store";

export type DmClientStatus = "disconnected" | "connecting" | "ready" | "error";

export type DmClientState = {
  status: DmClientStatus;
  client: DmClient | null;
  store: BrowserDmStore | null;
  error: string;
  connect: () => void;
  disconnect: () => Promise<void>;
};

/**
 * Restores the M3 browser-held DM session for the signed-in DID and builds the
 * M4 `DmClient` on top of it. The OAuth client and WebCrypto key modules load
 * through dynamic imports so their module graph never runs outside the
 * browser; DPoP keys are non-extractable `WebcryptoKey`s.
 */
export function useDmClient(did: string, dmConfig: DmConfig): DmClientState {
  const { appUrl, plcUrl, scope, serviceRef, loopback } = dmConfig;
  const [status, setStatus] = useState<DmClientStatus>("connecting");
  const [client, setClient] = useState<DmClient | null>(null);
  const [store, setStore] = useState<BrowserDmStore | null>(null);
  const [error, setError] = useState("");
  const epoch = useRef(0);

  useEffect(() => {
    const run = ++epoch.current;
    void (async () => {
      try {
        const sessionConfig = { appUrl, plcUrl, scope, serviceRef, loopback };
        const { restoreDmSession, dmXrpcClient } = await import("./browser-session");
        if (epoch.current !== run) return;
        setStatus("connecting");
        setError("");
        const session = await restoreDmSession(did, sessionConfig);
        if (epoch.current !== run) return;
        if (!session) {
          setStatus("disconnected");
          return;
        }
        const browserStore = createBrowserDmStore(did);
        const engine = new DmClient({
          did,
          memberClient: dmXrpcClient(session),
          resolvePds: (target) => resolvePds(target, { plcUrl, loopback }),
          fetchEndpoint: (request) => fetch(request, { redirect: "error" }),
          generateKey: generateDpopKey,
          store: browserStore,
        });
        if (epoch.current !== run) return;
        setClient(engine);
        setStore(browserStore);
        setStatus("ready");
      } catch (caught) {
        if (epoch.current !== run) return;
        setError(caught instanceof Error ? caught.message : "Could not restore the direct-message session.");
        setStatus("error");
      }
    })();
    return () => {
      epoch.current += 1;
    };
  }, [did, appUrl, plcUrl, scope, serviceRef, loopback]);

  const connect = useCallback(() => {
    setStatus("connecting");
    setError("");
    void (async () => {
      try {
        const { connectDms } = await import("./browser-session");
        await connectDms(did, { appUrl, plcUrl, scope, serviceRef, loopback });
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : "Could not connect direct messages.");
        setStatus("error");
      }
    })();
  }, [did, appUrl, plcUrl, scope, serviceRef, loopback]);

  const disconnect = useCallback(async () => {
    setError("");
    try {
      const { disconnectDms } = await import("./browser-session");
      await disconnectDms({ appUrl, plcUrl, scope, serviceRef, loopback });
    } finally {
      epoch.current += 1;
      setClient(null);
      setStore(null);
      setStatus("disconnected");
    }
  }, [appUrl, plcUrl, scope, serviceRef, loopback]);

  return { status, client, store, error, connect, disconnect };
}

async function generateDpopKey(): Promise<DpopKey> {
  const { WebcryptoKey } = await import("@atproto/jwk-webcrypto");
  return WebcryptoKey.generate(["ES256"]);
}
