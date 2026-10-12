export type DmClientMetadata = {
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

/**
 * Pure OAuth client metadata for the browser-held DM session (M3). Isomorphic:
 * it must not depend on `@/lib/config` or any other server-only module, since
 * the browser session (src/dm/browser-session.ts) builds the same client_id
 * from config handed down as props, not from the server's own env access.
 */
export function buildDmClientMetadata(options: { appUrl: string; scope: string }): DmClientMetadata {
  const appUrl = new URL(options.appUrl);
  const loopback = isLoopbackHostname(appUrl.hostname) && appUrl.protocol === "http:";
  const redirectOrigin = loopback ? `http://127.0.0.1${appUrl.port ? `:${appUrl.port}` : ""}` : appUrl.origin;
  const redirectUri = `${redirectOrigin}/dm/callback`;
  const clientId = loopback
    ? `http://localhost?${new URLSearchParams({ redirect_uri: redirectUri, scope: options.scope }).toString()}`
    : `${appUrl.origin}/oauth/dm-client-metadata.json`;
  return {
    client_id: clientId,
    client_name: "Spaces DMs",
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

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return normalized === "localhost" || normalized === "::1" || /^127(?:\.\d{1,3}){3}$/.test(normalized);
}
