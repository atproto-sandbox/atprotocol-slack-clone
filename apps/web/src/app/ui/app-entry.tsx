"use client";

import dynamic from "next/dynamic";
import type { AccountGateProps } from "./account-gate";

// The gate restores the browser session through @atproto/oauth-client-browser and IndexedDB; ssr:false keeps that module graph
// out of the server bundle.
const AccountGate = dynamic(() => import("./account-gate").then((mod) => mod.AccountGate), { ssr: false });

export function AppEntry(props: AccountGateProps) {
  return <AccountGate {...props} />;
}
