"use client";

import dynamic from "next/dynamic";
import type { OAuthCallbackViewProps } from "@/app/ui/oauth-callback-view";

// The view dynamically imports @atproto/oauth-client-browser and touches IndexedDB; ssr:false keeps that module graph out of
// the server bundle.
const OAuthCallbackView = dynamic(() => import("@/app/ui/oauth-callback-view").then((mod) => mod.OAuthCallbackView), { ssr: false });

export function OAuthCallbackClient(props: OAuthCallbackViewProps) {
  return <OAuthCallbackView {...props} />;
}
