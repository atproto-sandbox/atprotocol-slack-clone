"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { getGroupBrowserOAuthClient, GroupOAuthDeniedError } from "../../browser/group-session";
import { signedInDid, type BrowserSessionConfig } from "../../browser/session";
import { validateReturnTo } from "./routes";

export type GroupOAuthCallbackViewProps = { config: BrowserSessionConfig };

/**
 * Completes a Group-DID OAuth callback (`/oauth/group-callback`), handling both query and fragment responses,
 * `error=access_denied`, and automatic step-up action-token claims (`delete_account` / `plc_operation`).
 */
export function GroupOAuthCallbackView({ config }: GroupOAuthCallbackViewProps) {
  const router = useRouter();
  const [error, setError] = useState("");
  const [returnHref, setReturnHref] = useState("/");

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const viewerDid = await signedInDid(config);
        if (cancelled) return;
        if (!viewerDid) {
          setError("Sign in with your personal account before completing group authorization.");
          return;
        }

        const rawQuery = window.location.search.startsWith("?")
          ? window.location.search.slice(1)
          : window.location.search;
        const rawHash = window.location.hash.startsWith("#")
          ? window.location.hash.slice(1)
          : window.location.hash;
        const params = new URLSearchParams(rawQuery || rawHash);

        const groupOAuth = getGroupBrowserOAuthClient(viewerDid, config);
        const completed = await groupOAuth.completeCallback(params);
        if (cancelled) return;

        const validatedTarget = completed.appState?.returnTo
          ? validateReturnTo(completed.appState.returnTo)
          : null;
        const nextUrl = validatedTarget ?? "/";
        setReturnHref(nextUrl);
        router.replace(nextUrl);
      } catch (caught) {
        if (cancelled) return;
        if (caught instanceof GroupOAuthDeniedError) {
          setError(caught.message);
        } else {
          setError(caught instanceof Error ? caught.message : "Could not complete group authorization.");
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [config, router]);

  return (
    <main className="welcome-page">
      <section className="welcome-panel">
        {error ? (
          <>
            <p className="form-error" role="alert">
              {error}
            </p>
            <Link className="text-button" href={returnHref}>
              Back to workspace →
            </Link>
          </>
        ) : (
          <p className="status-note" role="status">
            Completing group authorization…
          </p>
        )}
      </section>
    </main>
  );
}
