"use client";

import { FormEvent, useEffect, useState } from "react";
import Link from "next/link";
import { signIn, type BrowserSessionConfig } from "../../browser/session";
import { captureInviteLink, clearAccountScopedState, INVITE_LINK_KEY, messageOf, SIGN_OUT_KEPT, SIGN_OUT_PARAM, SIGN_OUT_UNREVOKED } from "./client-api";

/** Signs in with the browser's one OAuth client: the account's host asks for consent and sends the browser back. */
export function LoginForm({ config, ended = "" }: { config: BrowserSessionConfig; ended?: string }) {
  const [handle, setHandle] = useState("");
  const [error, setError] = useState(ended);
  const [busy, setBusy] = useState(false);
  const [invited, setInvited] = useState(false);
  const [signOutUnheld, setSignOutUnheld] = useState<string[]>([]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      clearAccountScopedState(sessionStorage, [INVITE_LINK_KEY]);
      const search = window.location.search;
      if (captureInviteLink(search, sessionStorage)) setInvited(true);
      setSignOutUnheld((new URLSearchParams(search).get(SIGN_OUT_PARAM) ?? "").split(",").filter(Boolean));
      if (search) window.history.replaceState(null, "", window.location.pathname);
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setBusy(true);
    try {
      await signIn(handle.trim().replace(/^@/, ""), config);
    } catch (caught) {
      setError(messageOf(caught));
      setBusy(false);
    }
  }

  return (
    <main className="welcome-page">
      <div className="welcome-art" aria-hidden="true">
        <div className="art-glow art-glow-one" />
        <div className="art-glow art-glow-two" />
        <div className="art-grid" />
        <div className="floating-card card-one"><span className="mini-dot dot-green" /> team-ops <b>12</b></div>
        <div className="floating-card card-two"><span className="mini-avatar avatar-lilac">M</span><span>“Ship it, then celebrate.”</span><span className="tiny-reaction">✨ 4</span></div>
        <div className="floating-card card-three"><span className="mini-avatar avatar-peach">J</span><span className="typing-dots">● ● ●</span></div>
      </div>
      <section className="welcome-panel">
        <Link className="brand" href="/" aria-label="Spaces home"><span className="brand-mark"><i /><i /><i /></span><span>spaces</span></Link>
        <div className="welcome-copy">
          <div className="eyebrow"><span className="eyebrow-line" /> WORK, IN YOUR OWN SPACE</div>
          <h1>Good work happens<br /><em>together.</em></h1>
          <p className="welcome-description">A calmer place for your team’s conversations. Your workspace, your data, your people.</p>
          {invited && <p className="status-note" role="status">You&rsquo;ve been invited to a workspace. Sign in with your account to join it.</p>}
          {signOutUnheld.includes(SIGN_OUT_UNREVOKED) && <p className="status-note" role="status">You are signed out of this browser. Your account&rsquo;s host could not be reached to end the session there, so it ends when it expires.</p>}
          {signOutUnheld.includes(SIGN_OUT_KEPT) && <p className="status-note" role="status">What this browser held for your account could not all be deleted now (another tab of this app may hold it open). Close the app&rsquo;s other tabs and sign in and out again, or it goes when another account signs in here.</p>}
          <form className="signin-form" onSubmit={submit}>
            <label htmlFor="handle">Your AT Protocol handle</label>
            <div className="handle-input"><span>@</span><input id="handle" autoComplete="username" placeholder="you.bsky.social" value={handle} onChange={(event) => setHandle(event.target.value)} required /></div>
            {error && <p className="form-error" role="alert">{error}</p>}
            <button className="primary-button" type="submit" disabled={busy}>{busy ? "Connecting…" : "Continue with atproto"}<span aria-hidden="true">↗</span></button>
            <p className="privacy-note"><span className="lock-icon">⌑</span> Sign in securely with your identity provider. Spaces never sees your password.</p>
          </form>
        </div>
        <footer className="welcome-footer"><span>BUILT ON AT PROTOCOL</span><span>Private by design <i>·</i> Open by nature</span></footer>
      </section>
    </main>
  );
}
