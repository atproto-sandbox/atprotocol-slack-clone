"use client";

import { useEffect } from "react";
import type { BrowserSessionConfig } from "../../browser/session";
import { useBrowserSession, type BrowserSessionState } from "../../browser/use-browser-session";

export type DmSessionBridgeProps = {
  did: string;
  dmConfig: BrowserSessionConfig;
  onSession: (session: BrowserSessionState) => void;
};

/**
 * The only module that statically imports `@/browser/use-browser-session` (and, through
 * it, dynamically loads `@atproto/oauth-client-browser`). `dm-context.tsx` renders this component through
 * `next/dynamic(..., { ssr: false })` so that reachability never enters any
 * server bundle: `DmProvider` itself must render its non-DM children
 * (`Sidebar`, the workspace stage) normally during SSR, which a dynamic
 * component with `ssr:false` cannot do for content passed to it as
 * `children`, so the session hook is isolated here instead and its result is
 * reported up to `DmProvider` through `onSession`.
 */
export function DmSessionBridge({ did, dmConfig, onSession }: DmSessionBridgeProps) {
  const { status, client, store, engine, snapshots, live, error, connect, signOut } = useBrowserSession(did, dmConfig);
  useEffect(() => {
    onSession({ status, client, store, engine, snapshots, live, error, connect, signOut });
  }, [status, client, store, engine, snapshots, live, error, connect, signOut, onSession]);
  return null;
}
