import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import type { NodeSavedSession, NodeSavedState } from "@atproto/oauth-client-node";
import { getConfig } from "@/lib/config";
import { getRawDb } from "@/lib/db";

type OAuthRow = { key: string; value: string; updated_at: number };
type OAuthValue = NodeSavedSession | NodeSavedState;
type OAuthTable = "oauth_state" | "oauth_session" | "authority_grant_state" | "authority_grant";
const STATE_TABLES: ReadonlySet<OAuthTable> = new Set(["oauth_state", "authority_grant_state"]);
const SQLITE_WRITE_RETRY_DELAYS_MS = [100, 250] as const;
const OAUTH_STATE_RETENTION_MS = 30 * 60 * 1000;
type Store<T> = {
  get(key: string): Promise<T | undefined>;
  set(key: string, value: T): Promise<void>;
  del(key: string): Promise<void>;
};

/**
 * An encrypted OAuth state or session store over one table. With `consumeOnRead`, a read deletes the row in the same
 * statement, so a value can be read once even by racing readers (a flow state is single use).
 */
export function oauthSqliteStore<K extends OAuthValue>(table: OAuthTable, options: { consumeOnRead?: boolean } = {}): Store<K> {
  return {
    async get(key) {
      const row = (options.consumeOnRead
        ? await retrySqliteBusyWrite(() => getRawDb().prepare(`DELETE FROM ${table} WHERE key = ? RETURNING value, updated_at`).get(key))
        : getRawDb().prepare(`SELECT value, updated_at FROM ${table} WHERE key = ?`).get(key)) as OAuthRow | undefined;
      if (!row) return undefined;
      const cutoff = Date.now() - OAUTH_STATE_RETENTION_MS;
      if (STATE_TABLES.has(table) && row.updated_at < cutoff) {
        await retrySqliteBusyWrite(() => getRawDb().prepare(`DELETE FROM ${table} WHERE key = ? AND updated_at < ?`).run(key, cutoff));
        return undefined;
      }
      return decryptJson<K>(row.value);
    },
    async set(key, value) {
      const encryptedValue = encryptJson(value);
      await retrySqliteBusyWrite(() => {
        const db = getRawDb();
        const write = db.transaction(() => {
          const now = Date.now();
          if (STATE_TABLES.has(table)) {
            db.prepare(`DELETE FROM ${table} WHERE updated_at < ?`).run(now - OAUTH_STATE_RETENTION_MS);
          }
          db.prepare(`INSERT INTO ${table}(key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`)
            .run(key, encryptedValue, now);
        });
        write();
      });
    },
    async del(key) {
      await retrySqliteBusyWrite(() => {
        getRawDb().prepare(`DELETE FROM ${table} WHERE key = ?`).run(key);
      });
    },
  };
}

export async function retrySqliteBusyWrite<T>(write: () => T): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return write();
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
      const retryable = code === "SQLITE_BUSY" || code === "SQLITE_LOCKED";
      if (!retryable || attempt >= SQLITE_WRITE_RETRY_DELAYS_MS.length) throw error;
      await new Promise((resolve) => setTimeout(resolve, SQLITE_WRITE_RETRY_DELAYS_MS[attempt]));
    }
  }
}

export function encryptJson(value: unknown): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", getConfig().encryptionKey, iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  return ["v1", iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), ciphertext.toString("base64url")].join(".");
}

/** A stored value that cannot be decrypted or parsed: corrupt, or written under another `AUTH_ENCRYPTION_KEY`. */
export class UnreadableStoredValueError extends Error {
  constructor(options?: ErrorOptions) {
    super("A stored OAuth value cannot be decrypted with the current key.", options);
    this.name = "UnreadableStoredValueError";
  }
}

export function decryptJson<T>(value: string): T {
  const [version, ivPart, tagPart, ciphertextPart, extra] = value.split(".");
  if (version !== "v1" || !ivPart || !tagPart || !ciphertextPart || extra !== undefined) {
    throw new UnreadableStoredValueError();
  }
  try {
    const decipher = createDecipheriv("aes-256-gcm", getConfig().encryptionKey, Buffer.from(ivPart, "base64url"));
    decipher.setAuthTag(Buffer.from(tagPart, "base64url"));
    const plaintext = Buffer.concat([decipher.update(Buffer.from(ciphertextPart, "base64url")), decipher.final()]);
    return JSON.parse(plaintext.toString("utf8")) as T;
  } catch (cause) {
    throw new UnreadableStoredValueError({ cause });
  }
}
