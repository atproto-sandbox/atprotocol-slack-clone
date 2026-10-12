import type { DmStore } from "./dm-client";

export type BrowserDmStore = DmStore & { readonly persistent: boolean };

/**
 * The `DmDeps.store` for the browser: `localStorage` under `dm:<did>:`, with
 * every access wrapped in try/catch. When storage is unavailable (private
 * mode, disabled storage, quota), all state falls back to memory and
 * `persistent` turns false so the UI can say reloads will lose it.
 */
export function createBrowserDmStore(did: string): BrowserDmStore {
  const prefix = `dm:${did}:`;
  const memory = new Map<string, string>();
  let persistent = storageWritable(prefix);

  return {
    get persistent() {
      return persistent;
    },
    async get(key: string): Promise<string | null> {
      if (persistent) {
        try {
          return localStorage.getItem(prefix + key);
        } catch {
          persistent = false;
        }
      }
      return memory.has(key) ? memory.get(key)! : null;
    },
    async set(key: string, value: string): Promise<void> {
      if (persistent) {
        try {
          localStorage.setItem(prefix + key, value);
          return;
        } catch {
          persistent = false;
        }
      }
      memory.set(key, value);
    },
    async delete(key: string): Promise<void> {
      if (persistent) {
        try {
          localStorage.removeItem(prefix + key);
          return;
        } catch {
          persistent = false;
        }
      }
      memory.delete(key);
    },
  };
}

function storageWritable(prefix: string): boolean {
  try {
    const probe = `${prefix}__probe__`;
    localStorage.setItem(probe, "1");
    localStorage.removeItem(probe);
    return true;
  } catch {
    return false;
  }
}
