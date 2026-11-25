import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { chmod, lstat, readdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { normalizeLegacySpaceUri } from "@flock/client/workspace-client";

const DUMMY_DIGEST = createHash("sha256").update("flock-webhooks-dummy-secret", "utf8").digest();
const HOOK_ID_PATTERN = /^[A-Za-z0-9_-]{22}$/;
const SECRET_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export const MAX_HOOKS_PER_WORKSPACE = 100;

export class WorkspaceHookCapError extends Error {
  constructor(readonly maxHooks: number) {
    super(`This workspace already has the maximum of ${maxHooks} active webhooks.`);
    this.name = "WorkspaceHookCapError";
  }
}

export type StoredHook = {
  id: string;
  workspace: string;
  channelSkey: string;
  channelName: string;
  privateChannel: boolean;
  secretSha256: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  revokedAt?: string;
};

/**
 * Owner-only (`0o600`), symlink-refusing, atomic JSON store for incoming webhook metadata, stored beside (never inside) the
 * app's OAuth state file. Only `sha256(secret)` is ever written to disk; plaintext secrets exist only in the return value of
 * `create` and `rotate`. Parsed entries are cached in memory after the first read and updated atomically on `change()`.
 */
export class HooksStore {
  private queue: Promise<unknown> = Promise.resolve();
  private leftovers?: Promise<void>;
  private cached?: Record<string, StoredHook>;
  private loading?: Promise<Record<string, StoredHook>>;

  constructor(
    private readonly path: string,
    private readonly now: () => number = Date.now,
  ) {}

  async listActiveForWorkspace(workspace: string): Promise<StoredHook[]> {
    const hooks = await this.readAll();
    return Object.values(hooks)
      .filter((hook) => hook.workspace === workspace && hook.revokedAt === undefined)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id));
  }

  async get(id: string): Promise<StoredHook | undefined> {
    if (!HOOK_ID_PATTERN.test(id)) return undefined;
    const hooks = await this.readAll();
    return Object.hasOwn(hooks, id) ? hooks[id] : undefined;
  }

  /**
   * Constant-time secret verification: hashes `secret` with SHA-256 and runs `timingSafeEqual` against 32 bytes whether the
   * hook is unknown, wrong-secret, or revoked, returning the active hook only when all three hold.
   */
  async verifySecret(id: string, secret: string): Promise<StoredHook | null> {
    const providedDigest = createHash("sha256").update(secret, "utf8").digest();
    const wellFormed = HOOK_ID_PATTERN.test(id) && SECRET_PATTERN.test(secret);
    const hooks = await this.readAll();
    const hook = wellFormed && Object.hasOwn(hooks, id) ? hooks[id] : undefined;
    const expectedDigest = hook && /^[0-9a-f]{64}$/.test(hook.secretSha256)
      ? Buffer.from(hook.secretSha256, "hex")
      : DUMMY_DIGEST;
    const matched = timingSafeEqual(providedDigest, expectedDigest);
    return matched && wellFormed && hook && hook.revokedAt === undefined ? hook : null;
  }

  async create(input: {
    workspace: string;
    channelSkey: string;
    channelName: string;
    privateChannel: boolean;
    createdBy: string;
    maxForWorkspace?: number;
  }): Promise<{ hook: StoredHook; secret: string }> {
    const id = randomBytes(16).toString("base64url");
    const secret = randomBytes(32).toString("base64url");
    const timestamp = new Date(this.now()).toISOString();
    const maxHooks = input.maxForWorkspace ?? MAX_HOOKS_PER_WORKSPACE;
    const hook: StoredHook = {
      id,
      workspace: input.workspace,
      channelSkey: input.channelSkey,
      channelName: input.channelName,
      privateChannel: input.privateChannel,
      secretSha256: sha256Hex(secret),
      createdBy: input.createdBy,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    await this.change((hooks) => {
      const activeCount = Object.values(hooks).filter(
        (entry) => entry.workspace === input.workspace && entry.revokedAt === undefined,
      ).length;
      if (activeCount >= maxHooks) throw new WorkspaceHookCapError(maxHooks);
      hooks[id] = hook;
    });
    return { hook, secret };
  }

  async rotate(id: string, channelMeta?: { channelName: string; privateChannel: boolean }): Promise<{ hook: StoredHook; secret: string } | null> {
    if (!HOOK_ID_PATTERN.test(id)) return null;
    const secret = randomBytes(32).toString("base64url");
    let updated: StoredHook | null = null;
    await this.change((hooks) => {
      const existing = Object.hasOwn(hooks, id) ? hooks[id] : undefined;
      if (!existing || existing.revokedAt !== undefined) return;
      updated = {
        ...existing,
        ...(channelMeta ? { channelName: channelMeta.channelName, privateChannel: channelMeta.privateChannel } : {}),
        secretSha256: sha256Hex(secret),
        updatedAt: new Date(this.now()).toISOString(),
      };
      hooks[id] = updated;
    });
    return updated ? { hook: updated, secret } : null;
  }

  async revoke(id: string): Promise<boolean> {
    if (!HOOK_ID_PATTERN.test(id)) return false;
    let revoked = false;
    await this.change((hooks) => {
      const existing = Object.hasOwn(hooks, id) ? hooks[id] : undefined;
      if (!existing || existing.revokedAt !== undefined) return;
      hooks[id] = { ...existing, revokedAt: new Date(this.now()).toISOString(), updatedAt: new Date(this.now()).toISOString() };
      revoked = true;
    });
    return revoked;
  }

  private readAll(): Promise<Record<string, StoredHook>> {
    if (this.cached) return Promise.resolve(this.cached);
    this.loading ??= this.loadCold().finally(() => {
      this.loading = undefined;
    });
    return this.loading;
  }

  private async loadCold(): Promise<Record<string, StoredHook>> {
    await (this.leftovers ??= this.clearLeftovers());
    try {
      const file = await lstat(this.path);
      if (!file.isFile()) throw new Error(`The hooks file ${this.path} must be a plain file, not a link.`);
      if ((file.mode & 0o077) !== 0) await chmod(this.path, 0o600);
      const parsed = JSON.parse(await readFile(this.path, "utf8")) as { hooks?: Record<string, StoredHook> };
      const raw = parsed.hooks ?? {};
      const clean: Record<string, StoredHook> = Object.create(null) as Record<string, StoredHook>;
      for (const [key, value] of Object.entries(raw)) {
        clean[key] = typeof value.workspace === "string"
          ? { ...value, workspace: normalizeLegacySpaceUri(value.workspace) }
          : value;
      }
      return (this.cached ??= clean);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        const empty = Object.create(null) as Record<string, StoredHook>;
        return (this.cached ??= empty);
      }
      throw error;
    }
  }

  private async clearLeftovers(): Promise<void> {
    const name = basename(this.path);
    const ours = (entry: string) =>
      entry.length === name.length + 41 &&
      entry.startsWith(`${name}.`) &&
      /^\.[0-9a-f-]{36}\.tmp$/.test(entry.slice(name.length));
    const names = await readdir(dirname(this.path)).catch(() => [] as string[]);
    await Promise.all(names.filter(ours).map((entry) => unlink(join(dirname(this.path), entry)).catch(() => undefined)));
  }

  private change(apply: (hooks: Record<string, StoredHook>) => void): Promise<void> {
    const next = this.queue.then(async () => {
      const current = await this.readAll();
      const working: Record<string, StoredHook> = Object.create(null) as Record<string, StoredHook>;
      for (const [key, value] of Object.entries(current)) working[key] = value;
      apply(working);
      const temporary = `${this.path}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, JSON.stringify({ hooks: working }), { mode: 0o600, flag: "wx" });
        await rename(temporary, this.path);
        this.cached = working;
      } catch (error) {
        await unlink(temporary).catch(() => undefined);
        throw error;
      }
    });
    this.queue = next.catch(() => undefined);
    return next;
  }
}

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
