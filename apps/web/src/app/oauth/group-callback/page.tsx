import { browserSessionConfig } from "../../browser-session-config";
import { GroupOAuthCallbackClient } from "./group-oauth-callback-client";

export const dynamic = "force-dynamic";

export default function GroupOAuthCallbackPage() {
  return <GroupOAuthCallbackClient config={browserSessionConfig()} />;
}
