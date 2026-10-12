"use client";

import dynamic from "next/dynamic";
import type { DmCallbackViewProps } from "@/app/ui/dm-callback-view";

// The view touches IndexedDB/WebCrypto and dynamically imports
// @atproto/oauth-client-browser; ssr:false keeps that whole module graph out
// of the server bundle (see src/app/ui/dm-callback-view.tsx).
const DmCallbackView = dynamic(() => import("@/app/ui/dm-callback-view").then((mod) => mod.DmCallbackView), { ssr: false });

export function DmCallbackClient(props: DmCallbackViewProps) {
  return <DmCallbackView {...props} />;
}
