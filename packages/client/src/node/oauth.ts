import { randomUUID } from "node:crypto";
import { basename, dirname, join } from "node:path";
import { chmod, lstat, readdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { JoseKey, NodeOAuthClient, TokenInvalidError, TokenRefreshError, TokenRevokedError, type Jwk, type NodeSavedSession, type NodeSavedState, type OAuthSession } from "@atproto/oauth-client-node";
import { safeFetch } from "@flock/net/safe-fetch";
import { isScopeMissingError } from "@flock/protocol/atproto/xrpc";

export type { Jwk, NodeOAuthClient, OAuthSession };

// An app's own OAuth client: how an app account signs in once, and keeps its session, on the machine the app runs on.

export type AppOAuthConfig = {
  /**
   * Where the app is reached. Over https it is a confidential `private_key_jwt` client that serves its metadata and public keys
   * there, as the PDS reads them at sign-in and at every refresh, and gets the provider's long session. Over http (loopback
   * development) it is a public loopback client, which the provider gives a two-week session.
   */
  appUrl: string;
  /** The app's private ES256 signing keys, as JWKs with a `kid`, newest first. None on loopback. */
  keys: readonly Jwk[];
  name: string;
  scope: string;
  plcUrl: string;
  /** The file that holds the app's sessions and sign-in states, its DPoP keys and tokens among them: readable by its owner only. */
  stateFile: string;
};

export const APP_OAUTH_PATHS = { clientMetadata: "/oauth/client-metadata.json", jwks: "/oauth/jwks.json", callback: "/oauth/callback" } as const;

/**
 * Whether the app runs on loopback: plain http on 127.0.0.1 or [::1], loopback development only (RFC 8252 names a loopback
 * client by its address). Any other app URL must be https: a plain-http app elsewhere is refused, not taken for loopback.
 */
export function isLoopbackApp(appUrl: string): boolean {
  const url = new URL(appUrl);
  if (url.protocol === "https:") return false;
  if (url.protocol === "http:" && (url.hostname === "127.0.0.1" || url.hostname === "[::1]")) return true;
  throw new Error("An app is reached over https, or over http on 127.0.0.1 or [::1] in loopback development.");
}

export function appClientMetadata(config: Pick<AppOAuthConfig, "appUrl" | "keys" | "name" | "scope">) {
  const origin = new URL(config.appUrl).origin;
  const redirectUri = `${origin}${APP_OAUTH_PATHS.callback}`;
  const common = {
    client_name: config.name,
    redirect_uris: [redirectUri] as [string],
    grant_types: ["authorization_code", "refresh_token"] as ["authorization_code", "refresh_token"],
    scope: config.scope,
    response_types: ["code"] as ["code"],
    dpop_bound_access_tokens: true,
  };
  if (isLoopbackApp(config.appUrl)) {
    return {
      ...common,
      client_id: `http://localhost?${new URLSearchParams({ scope: config.scope, redirect_uri: redirectUri }).toString()}`,
      token_endpoint_auth_method: "none" as const,
      application_type: "native" as const,
    };
  }
  if (config.keys.length === 0) throw new Error("An app reached over https signs its token requests: give it at least one key.");
  return {
    ...common,
    client_id: `${origin}${APP_OAUTH_PATHS.clientMetadata}`,
    client_uri: origin,
    token_endpoint_auth_method: "private_key_jwt" as const,
    token_endpoint_auth_signing_alg: "ES256",
    jwks_uri: `${origin}${APP_OAUTH_PATHS.jwks}`,
  };
}

/**
 * The app's OAuth client. Every host it reaches (the account's PDS and authorization server, the identity hosts and the PLC
 * directory) is reached through `@flock/net`: these are hosts someone else named, in a DID document or a server's metadata, and
 * the library's own default fetch would reach any address. Loopback hosts are allowed in loopback development only.
 */
export async function appOAuthClient(config: AppOAuthConfig): Promise<NodeOAuthClient> {
  const file = new StateFile(config.stateFile);
  const loopback = isLoopbackApp(config.appUrl);
  return new NodeOAuthClient({
    clientMetadata: appClientMetadata(config),
    keyset: await Promise.all(config.keys.map((key) => JoseKey.fromImportable(key, key.kid))),
    allowHttp: loopback,
    fetch: safeFetch(() => loopback),
    plcDirectoryUrl: config.plcUrl,
    stateStore: file.store<NodeSavedState>("states"),
    sessionStore: file.store<NodeSavedSession>("sessions"),
  });
}

/**
 * Answers the routes an app serves for its OAuth client: its metadata and public keys, and the sign-in's return, which
 * completes the sign-in and gives the session. Anything else is null, for the app to answer.
 */
export async function answerAppOAuthRoute(client: NodeOAuthClient, url: URL): Promise<{ status: number; type: string; body: string; session?: OAuthSession } | null> {
  if (url.pathname === APP_OAUTH_PATHS.clientMetadata) return { status: 200, type: "application/json", body: JSON.stringify(client.clientMetadata) };
  if (url.pathname === APP_OAUTH_PATHS.jwks) return { status: 200, type: "application/json", body: JSON.stringify(client.jwks) };
  if (url.pathname !== APP_OAUTH_PATHS.callback) return null;
  const { session } = await client.callback(url.searchParams);
  return { status: 200, type: "text/plain; charset=utf-8", body: `Signed in as ${session.did}. This page can be closed.`, session };
}

/** Whether a failure means the app's session is gone or lacks a required scope, so the operator must sign it in again. */
export function isSessionLost(error: unknown): boolean {
  return error instanceof TokenRefreshError || error instanceof TokenRevokedError || error instanceof TokenInvalidError || isScopeMissingError(error);
}

type Store<T> = { get(key: string): Promise<T | undefined>; set(key: string, value: T): Promise<void>; del(key: string): Promise<void> };

/**
 * One JSON file holding the client's sign-in states and sessions, readable and writable by its owner only: a file found with
 * wider permissions is narrowed when it is read. It is rewritten whole through a temporary file of a random name, created
 * exclusively (a link planted at that name is refused, not followed), then renamed over it. Writes from this process are
 * serialized; the file serves one app process.
 */
export class StateFile {
  private queue: Promise<unknown> = Promise.resolve();
  private leftovers?: Promise<void>;

  constructor(private readonly path: string) {}

  store<T>(section: "states" | "sessions"): Store<T> {
    return {
      get: async (key) => {
        const entries = (await this.read())[section];
        return Object.hasOwn(entries, key) ? entries[key] as T : undefined;
      },
      set: (key, value) => this.change((contents) => { contents[section][key] = value; }),
      del: (key) => this.change((contents) => { delete contents[section][key]; }),
    };
  }

  private async read(): Promise<{ states: Record<string, unknown>; sessions: Record<string, unknown> }> {
    await (this.leftovers ??= this.clearLeftovers());
    try {
      const file = await lstat(this.path);
      if (!file.isFile()) throw new Error(`The state file ${this.path} must be a plain file, not a link.`);
      if ((file.mode & 0o077) !== 0) await chmod(this.path, 0o600);
      const parsed = JSON.parse(await readFile(this.path, "utf8")) as { states?: Record<string, unknown>; sessions?: Record<string, unknown> };
      return { states: parsed.states ?? {}, sessions: parsed.sessions ?? {} };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { states: {}, sessions: {} };
      throw error;
    }
  }

  /** A write cut short by a crash leaves its temporary file, tokens and all: removed the first time the file is read. */
  private async clearLeftovers(): Promise<void> {
    const name = basename(this.path);
    const ours = (entry: string) => entry.length === name.length + 41 && entry.startsWith(`${name}.`) && /^\.[0-9a-f-]{36}\.tmp$/.test(entry.slice(name.length));
    const names = await readdir(dirname(this.path)).catch(() => [] as string[]);
    await Promise.all(names.filter(ours).map((entry) => unlink(join(dirname(this.path), entry)).catch(() => undefined)));
  }

  private change(apply: (contents: { states: Record<string, unknown>; sessions: Record<string, unknown> }) => void): Promise<void> {
    const next = this.queue.then(async () => {
      const contents = await this.read();
      apply(contents);
      const temporary = `${this.path}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, JSON.stringify(contents), { mode: 0o600, flag: "wx" });
        await rename(temporary, this.path);
      } catch (error) {
        await unlink(temporary).catch(() => undefined);
        throw error;
      }
    });
    this.queue = next.catch(() => undefined);
    return next;
  }
}
