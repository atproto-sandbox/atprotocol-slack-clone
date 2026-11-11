import type { OAuthSession } from "@atproto/oauth-client-node";
import { AtprotoClient } from "@flock/protocol/atproto/xrpc";
import { fetchValidatedEndpoint } from "./identity";

export function sessionClient(session: OAuthSession): AtprotoClient {
  return new AtprotoClient((path, init) => session.fetchHandler(path, init));
}

export function serviceClient(service: string | URL): AtprotoClient {
  const base = service instanceof URL ? service : new URL(service);
  return new AtprotoClient(async (path, init) => {
    const request = new Request(new URL(path, base), { ...init, redirect: "error" });
    return fetchValidatedEndpoint(request);
  });
}
