"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { ClientUnavailableError, signedInDid, type BrowserSessionConfig } from "../../browser/session";
import { messageOf } from "./client-api";
import { LoginForm } from "./login-form";
import { WorkspaceManager } from "./workspace-manager";

export type AccountGateProps = { config: BrowserSessionConfig };

type Account = { did: string } | { signIn: string } | { retry: string };

/**
 * The app for the account signed in in this browser, or the sign-in form when nobody is, or when the session could not be
 * restored (it ended, and the library forgot it). Only a page that could not load its sign-in client asks to try again.
 */
export function AccountGate({ config }: AccountGateProps) {
  const [account, setAccount] = useState<Account>();

  useEffect(() => {
    signedInDid(config).then(
      (did) => setAccount(did ? { did } : { signIn: "" }),
      (caught: unknown) => setAccount(caught instanceof ClientUnavailableError ? { retry: messageOf(caught) } : { signIn: `Your session ended (${messageOf(caught)}). Sign in again.` }),
    );
  }, [config]);

  if (!account) {
    return <main className="welcome-page"><section className="welcome-panel"><p className="status-note" role="status">Opening your spaces…</p></section></main>;
  }
  if ("did" in account) return <WorkspaceManager did={account.did} dmConfig={config} />;
  if ("signIn" in account) return <LoginForm config={config} ended={account.signIn} />;
  return (
    <main className="welcome-page session-error-page">
      <section className="welcome-panel">
        <Link className="brand" href="/" aria-label="Spaces home"><span className="brand-mark"><i /><i /><i /></span><span>spaces</span></Link>
        <div className="welcome-copy" role="alert">
          <div className="eyebrow"><span className="eyebrow-line" /> TEMPORARY CONNECTION ISSUE</div>
          <h1>Your session<br /><em>couldn’t load.</em></h1>
          <p className="welcome-description">{account.retry} Try again in a moment.</p>
          <button className="primary-button" type="button" onClick={() => window.location.reload()}>Try again<span aria-hidden="true">↗</span></button>
        </div>
        <footer className="welcome-footer"><span>BUILT ON AT PROTOCOL</span><span>Private by design <i>·</i> Open by nature</span></footer>
      </section>
    </main>
  );
}
