import { browserSessionConfig } from "../../browser-session-config";
import { OAuthCallbackClient } from "./oauth-callback-client";

export const dynamic = "force-dynamic";

/** The account's host sends a sign-in back here; the browser completes it, so the server sees no token. */
export default function OAuthCallbackPage() {
  return <OAuthCallbackClient config={browserSessionConfig()} />;
}
