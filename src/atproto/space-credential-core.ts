import type * as GetDelegationToken from "@/lexicons/api/types/com/atproto/space/getDelegationToken";
import { readUpstreamJson } from "@/lib/bounded-json";
import { isDid, parseSpaceUri } from "@/protocol/keys";
import { createSpaceSigHeaders, type SpaceKey } from "./space-signature";
import { AtprotoClient } from "./xrpc";

/** The PDS default lifetime of a space credential; the protocol ceiling is one hour. */
export const SPACE_CREDENTIAL_LIFETIME_MS = 10 * 60 * 1000;
/** A cached credential is replaced once less than this remains of its lifetime. */
export const SPACE_CREDENTIAL_RENEW_BEFORE_MS = SPACE_CREDENTIAL_LIFETIME_MS / 6;
const GET_SPACE_CREDENTIAL = "/xrpc/com.atproto.space.getSpaceCredential";

export type SpaceCredentialDeps = {
  memberClient: AtprotoClient;
  resolvePds(did: string): Promise<string>;
  fetchEndpoint(request: Request): Promise<Response>;
  generateKey(): Promise<SpaceKey>;
  now?: () => number;
};

export class SpaceCredentialError extends Error {
  constructor(message: string, readonly status: 401 | 403 | 404 | 410, readonly code?: string) {
    super(message);
    this.name = "SpaceCredentialError";
  }
}

export class SpaceCredential {
  readonly expiresAt: number;

  constructor(
    readonly space: string,
    readonly token: string,
    readonly key: SpaceKey,
    private readonly fetchEndpoint: (request: Request) => Promise<Response>,
    expiresAt = Date.now() + SPACE_CREDENTIAL_LIFETIME_MS,
  ) {
    this.expiresAt = expiresAt;
  }

  client(service: string | URL): AtprotoClient {
    const authorization = `Atproto-Space ${this.token}`;
    const key = this.key;
    const authorityDid = parseSpaceUri(this.space)?.authorityDid;
    if (!authorityDid) throw new Error("Invalid permissioned space URI.");
    const fetchEndpoint = this.fetchEndpoint;
    const base = service instanceof URL ? service : new URL(service);
    return new AtprotoClient(async (path, init) => {
      const request = new Request(new URL(path, base), { ...init, redirect: "error" });
      const audience = requestedRepo(request) ?? authorityDid;
      for (const [name, value] of Object.entries(await createSpaceSigHeaders(key, { authorization, audience }))) {
        request.headers.set(name, value);
      }
      return fetchEndpoint(request);
    });
  }
}

/** A request for one repo is addressed to that repo's host; a space-wide request, to the space authority. */
function requestedRepo(request: Request): string | undefined {
  const repo = request.method === "GET" ? new URL(request.url).searchParams.get("repo") : null;
  return isDid(repo) ? repo : undefined;
}

export async function mintSpaceCredentialWith(deps: SpaceCredentialDeps, space: string): Promise<SpaceCredential> {
  const parsed = parseSpaceUri(space);
  if (!parsed) throw new Error("Invalid permissioned space URI.");
  const delegation = await deps.memberClient.query<GetDelegationToken.OutputSchema>(
    "com.atproto.space.getDelegationToken",
    { space },
  );
  const authorityPds = await deps.resolvePds(parsed.authorityDid);
  const key = await deps.generateKey();
  const token = await exchangeSpaceCredential({
    authorityPds,
    delegationToken: delegation.token,
    space,
    key,
    fetchEndpoint: deps.fetchEndpoint,
  });
  return new SpaceCredential(space, token, key, deps.fetchEndpoint, (deps.now ?? Date.now)() + SPACE_CREDENTIAL_LIFETIME_MS);
}

export async function exchangeSpaceCredential(input: {
  authorityPds: string;
  delegationToken: string;
  space: string;
  key: SpaceKey;
  fetchEndpoint: (request: Request) => Promise<Response>;
}): Promise<string> {
  const endpoint = new URL(GET_SPACE_CREDENTIAL, input.authorityPds);
  const request = new Request(endpoint, {
    method: "POST",
    redirect: "error",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      ...await createSpaceSigHeaders(input.key, { authorization: `Bearer ${input.delegationToken}` }),
    },
    body: JSON.stringify({ space: input.space }),
  });
  const response = await input.fetchEndpoint(request);
  const body = await readUpstreamJson<{ credential?: unknown; message?: unknown; error?: unknown }>(response, 64 * 1024);
  if (!response.ok || typeof body?.credential !== "string" || body.credential.length === 0) {
    const message = typeof body?.message === "string" ? body.message : `Space credential exchange failed (${response.status}).`;
    const code = typeof body?.error === "string" ? body.error : undefined;
    // The pinned PDS reports every credential-exchange denial as HTTP 400 with a
    // protocol-specific error code (UserNotAuthorized, SpaceNotFound,
    // SpaceDeleted). Normalize each to its own status so callers can tell "denied"
    // apart from "the half doesn't exist yet" and "the half was deleted" (M4
    // per-participant read status), while a bare 401/403 still maps to denial.
    if (response.status === 401 || response.status === 403 || (response.status === 400 && (code === "UserNotAuthorized" || code === "SpaceNotFound" || code === "SpaceDeleted"))) {
      const status = code === "SpaceNotFound" ? 404 : code === "SpaceDeleted" ? 410 : response.status === 401 ? 401 : 403;
      throw new SpaceCredentialError(message, status, code);
    }
    throw new Error(message);
  }
  return body.credential;
}
