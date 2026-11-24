import { groupAdminScopes } from "@flock/protocol/scopes";

export type BrowserClientMetadata = {
  client_id: string;
  client_name: string;
  client_uri?: string;
  redirect_uris: [string];
  grant_types: ["authorization_code", "refresh_token"];
  scope: string;
  response_types: ["code"];
  token_endpoint_auth_method: "none";
  application_type: "web";
  dpop_bound_access_tokens: true;
};

/** Where the app serves the browser client's metadata (its client id outside loopback development). */
export const BROWSER_CLIENT_METADATA_PATH = "/oauth/client-metadata.json";

/** Where the app serves the per-user Group-DID OAuth browser client metadata outside loopback development. */
export const GROUP_CLIENT_METADATA_PATH = "/oauth/group-client-metadata.json";

/**
 * Pure OAuth client metadata for the browser-held member session (the member grant and the DM set, R6). Isomorphic:
 * it must not depend on `@/lib/config` or any other server-only module, since
 * the browser session (src/browser/session.ts) builds the same client_id
 * from config handed down as props, not from the server's own env access.
 */
export function buildBrowserClientMetadata(options: { appUrl: string; scope: string }): BrowserClientMetadata {
  const appUrl = new URL(options.appUrl);
  const loopback = isLoopbackHostname(appUrl.hostname) && appUrl.protocol === "http:";
  const redirectOrigin = loopback ? `http://127.0.0.1${appUrl.port ? `:${appUrl.port}` : ""}` : appUrl.origin;
  const redirectUri = `${redirectOrigin}/oauth/callback`;
  const clientId = loopback
    ? `http://localhost?${new URLSearchParams({ redirect_uri: redirectUri, scope: options.scope }).toString()}`
    : `${appUrl.origin}${BROWSER_CLIENT_METADATA_PATH}`;
  return {
    client_id: clientId,
    client_name: "Spaces",
    ...(loopback ? {} : { client_uri: appUrl.origin }),
    redirect_uris: [redirectUri],
    grant_types: ["authorization_code", "refresh_token"],
    scope: options.scope,
    response_types: ["code"],
    token_endpoint_auth_method: "none",
    application_type: "web",
    dpop_bound_access_tokens: true,
  };
}

/**
 * Pure OAuth client metadata for `GroupBrowserOAuthClient` (`proposal.md:95-99`).
 * Uses `groupAdminScopes()` (never `aud=self`) as the static client metadata ceiling so
 * authorizations can request `groupModeratorScopes()` or `groupAdminScopes()` per group.
 */
export function buildGroupBrowserClientMetadata(options: { appUrl: string; scope?: string }): BrowserClientMetadata {
  const scope = options.scope ?? groupAdminScopes().join(" ");
  const appUrl = new URL(options.appUrl);
  const loopback = isLoopbackHostname(appUrl.hostname) && appUrl.protocol === "http:";
  const redirectOrigin = loopback ? `http://127.0.0.1${appUrl.port ? `:${appUrl.port}` : ""}` : appUrl.origin;
  const redirectUri = `${redirectOrigin}/oauth/group-callback`;
  const clientId = loopback
    ? `http://localhost?${new URLSearchParams({ redirect_uri: redirectUri, scope }).toString()}`
    : `${appUrl.origin}${GROUP_CLIENT_METADATA_PATH}`;
  return {
    client_id: clientId,
    client_name: "Spaces Group Governance",
    ...(loopback ? {} : { client_uri: appUrl.origin }),
    redirect_uris: [redirectUri],
    grant_types: ["authorization_code", "refresh_token"],
    scope,
    response_types: ["code"],
    token_endpoint_auth_method: "none",
    application_type: "web",
    dpop_bound_access_tokens: true,
  };
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return normalized === "localhost" || normalized === "::1" || /^127(?:\.\d{1,3}){3}$/.test(normalized);
}
