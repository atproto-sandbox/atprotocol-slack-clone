import type { BrowserSessionConfig } from "@/browser/session";
import { getConfig } from "@/lib/config";
import { memberGrantScopes } from "@/protocol/scopes";

/** What the browser session is built from, handed to the page and to the OAuth callback alike: the app, the PLC and one grant. */
export function browserSessionConfig(): BrowserSessionConfig {
  const { appUrl, plcDirectoryUrl, operatorServiceRef } = getConfig();
  return {
    appUrl: appUrl.origin,
    plcUrl: plcDirectoryUrl.toString(),
    scope: memberGrantScopes(operatorServiceRef).join(" "),
    serviceRef: operatorServiceRef,
    loopback: appUrl.protocol === "http:",
  };
}
