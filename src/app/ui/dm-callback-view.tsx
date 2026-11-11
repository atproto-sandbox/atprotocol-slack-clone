"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { restoreSession, type BrowserSessionConfig } from "@/browser/session";

export type DmCallbackViewProps = { expectedDid: string; dmConfig: BrowserSessionConfig };

export function DmCallbackView({ expectedDid, dmConfig }: DmCallbackViewProps) {
  const router = useRouter();
  const [error, setError] = useState("");

  useEffect(() => {
    restoreSession(expectedDid, dmConfig)
      .then((session) => {
        if (session) router.replace("/");
        else setError("This browser was not connected: the sign-in did not complete or did not grant every permission the app needs. Try connecting again.");
      })
      .catch((caught: unknown) => setError(caught instanceof Error ? caught.message : "Could not finish connecting this browser."));
  }, [expectedDid, dmConfig, router]);

  return (
    <main className="welcome-page">
      <section className="welcome-panel">
        {error ? <p className="form-error" role="alert">{error}</p> : <p className="status-note" role="status">Connecting this browser…</p>}
      </section>
    </main>
  );
}
