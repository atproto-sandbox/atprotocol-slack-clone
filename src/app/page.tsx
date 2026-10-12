import { getSession } from "@/auth/session";
import { DM_BROWSER_SCOPES } from "@/auth/permission-sets";
import { getConfig } from "@/lib/config";
import { headers } from "next/headers";
import Link from "next/link";
import { LoginForm } from "./ui/login-form";
import { WorkspaceManager } from "./ui/workspace-manager";
import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  const { appUrl, plcDirectoryUrl, operatorServiceRef } = getConfig();
  const dmConfig = {
    appUrl: appUrl.origin,
    plcUrl: plcDirectoryUrl.toString(),
    scope: DM_BROWSER_SCOPES.join(" "),
    serviceRef: operatorServiceRef,
    loopback: appUrl.protocol === "http:",
  };
  const requestHost = (await headers()).get("host");
  if (appUrl.protocol === "http:" && requestHost && requestHost.toLowerCase() !== appUrl.host.toLowerCase()) {
    redirect(appUrl.origin);
  }
  let session;
  try {
    session = await getSession();
  } catch {
    return (
      <main className="welcome-page session-error-page">
        <section className="welcome-panel">
          <Link className="brand" href="/" aria-label="Spaces home"><span className="brand-mark"><i /><i /><i /></span><span>spaces</span></Link>
          <div className="welcome-copy" role="alert">
            <div className="eyebrow"><span className="eyebrow-line" /> TEMPORARY CONNECTION ISSUE</div>
            <h1>Your session<br /><em>couldn’t load.</em></h1>
            <p className="welcome-description">Your sign-in is still saved. Please try again in a moment.</p>
            <Link className="primary-button" href="/">Try again<span aria-hidden="true">↗</span></Link>
          </div>
          <footer className="welcome-footer"><span>BUILT ON AT PROTOCOL</span><span>Private by design <i>·</i> Open by nature</span></footer>
        </section>
      </main>
    );
  }
  if (session) return <WorkspaceManager did={session.did} dmConfig={dmConfig} />;
  return <LoginForm />;
}
