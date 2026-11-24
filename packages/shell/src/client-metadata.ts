export type DeskClientMetadata = {
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

/** Where Flock Desk serves its OAuth browser client metadata (its client_id outside loopback development). */
export const DESK_CLIENT_METADATA_PATH = "/oauth/client-metadata.json";

/**
 * Pure isomorphic OAuth client metadata builder for Flock Desk's personal-PDS browser session.
 * Zero dependency on `@flock/web` or `@flock/deployment`.
 */
export function buildDeskClientMetadata(options: { appUrl: string; scope: string }): DeskClientMetadata {
  const appUrl = new URL(options.appUrl);
  const loopback = isLoopbackHostname(appUrl.hostname) && appUrl.protocol === "http:";
  const redirectOrigin = loopback ? `http://127.0.0.1${appUrl.port ? `:${appUrl.port}` : ""}` : appUrl.origin;
  const redirectUri = `${redirectOrigin}/oauth/callback`;
  const clientId = loopback
    ? `http://localhost?${new URLSearchParams({ redirect_uri: redirectUri, scope: options.scope }).toString()}`
    : `${appUrl.origin}${DESK_CLIENT_METADATA_PATH}`;
  return {
    client_id: clientId,
    client_name: "Flock Desk",
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
