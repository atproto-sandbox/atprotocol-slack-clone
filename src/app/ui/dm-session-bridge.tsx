"use client";

import { useEffect } from "react";
import type { DmConfig } from "@/dm/browser-session";
import { useDmClient, type DmClientState } from "@/dm/use-dm-client";

export type DmSessionBridgeProps = {
  did: string;
  dmConfig: DmConfig;
  onSession: (session: DmClientState) => void;
};

/**
 * The only module that statically imports `@/dm/use-dm-client` (and, through
 * it, dynamically loads `@atproto/oauth-client-browser` and
 * `@atproto/jwk-webcrypto`). `dm-context.tsx` renders this component through
 * `next/dynamic(..., { ssr: false })` so that reachability never enters any
 * server bundle: `DmProvider` itself must render its non-DM children
 * (`Sidebar`, the workspace stage) normally during SSR, which a dynamic
 * component with `ssr:false` cannot do for content passed to it as
 * `children`, so the session hook is isolated here instead and its result is
 * reported up to `DmProvider` through `onSession`.
 */
export function DmSessionBridge({ did, dmConfig, onSession }: DmSessionBridgeProps) {
  const { status, client, store, error, connect, disconnect } = useDmClient(did, dmConfig);
  useEffect(() => {
    onSession({ status, client, store, error, connect, disconnect });
  }, [status, client, store, error, connect, disconnect, onSession]);
  return null;
}
