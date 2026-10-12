"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { restoreDmSession, type DmConfig } from "@/dm/browser-session";

export type DmCallbackViewProps = { expectedDid: string; dmConfig: DmConfig };

export function DmCallbackView({ expectedDid, dmConfig }: DmCallbackViewProps) {
  const router = useRouter();
  const [error, setError] = useState("");

  useEffect(() => {
    restoreDmSession(expectedDid, dmConfig)
      .then(() => router.replace("/"))
      .catch((caught: unknown) => setError(caught instanceof Error ? caught.message : "Could not finish connecting direct messages."));
  }, [expectedDid, dmConfig, router]);

  return (
    <main className="welcome-page">
      <section className="welcome-panel">
        {error ? <p className="form-error" role="alert">{error}</p> : <p className="status-note" role="status">Connecting direct messages…</p>}
      </section>
    </main>
  );
}
