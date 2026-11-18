"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { signedInDid, type BrowserSessionConfig } from "../../browser/session";
import { consumeReturnTo, RETURN_TO_KEY } from "./routes";

export type OAuthCallbackViewProps = { config: BrowserSessionConfig };

/** Completes a sign-in the account's host sent back, then opens the app; a sign-in that did not complete says so. */
export function OAuthCallbackView({ config }: OAuthCallbackViewProps) {
  const router = useRouter();
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    signedInDid(config)
      .then((did) => {
        if (cancelled) return;
        if (did) {
          const target = consumeReturnTo(sessionStorage);
          router.replace(target);
        } else {
          sessionStorage.removeItem(RETURN_TO_KEY);
          setError("You were not signed in: the sign-in did not complete. Try again from the sign-in page.");
        }
      })
      .catch((caught: unknown) => {
        if (cancelled) return;
        sessionStorage.removeItem(RETURN_TO_KEY);
        setError(caught instanceof Error ? caught.message : "Could not finish signing in.");
      });
    return () => { cancelled = true; };
  }, [config, router]);

  return (
    <main className="welcome-page">
      <section className="welcome-panel">
        {error ? <><p className="form-error" role="alert">{error}</p><Link className="text-button" href="/">Back to sign in →</Link></> : <p className="status-note" role="status">Signing in…</p>}
      </section>
    </main>
  );
}
