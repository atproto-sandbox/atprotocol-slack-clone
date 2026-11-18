import { getConfig } from "@flock/deployment/config";
import { browserSessionConfig } from "./browser-session-config";
import { headers } from "next/headers";
import { AppEntry } from "./ui/app-entry";
import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

/** The app, for whoever is signed in in this browser: the server holds no member session, so the browser decides. */
export default async function HomePage() {
  const { appUrl } = getConfig();
  const requestHost = (await headers()).get("host");
  if (appUrl.protocol === "http:" && requestHost && requestHost.toLowerCase() !== appUrl.host.toLowerCase()) {
    redirect(appUrl.origin);
  }
  return <AppEntry config={browserSessionConfig()} />;
}
