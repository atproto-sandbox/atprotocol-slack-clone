import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { createBrowserDmStore } from "./browser-store";

type StorageLike = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
};

const realLocalStorage = Reflect.getOwnPropertyDescriptor(globalThis, "localStorage");
let raw: Map<string, string>;
let failing: boolean;

const fakeStorage: StorageLike = {
  getItem(key: string): string | null {
    if (failing) throw new Error("storage denied");
    return raw.has(key) ? raw.get(key)! : null;
  },
  setItem(key: string, value: string): void {
    if (failing) throw new Error("storage denied");
    raw.set(key, value);
  },
  removeItem(key: string): void {
    if (failing) throw new Error("storage denied");
    raw.delete(key);
  },
};

function installStorage(): void {
  Object.defineProperty(globalThis, "localStorage", { value: fakeStorage, configurable: true, writable: true });
}

function removeStorage(): void {
  if (realLocalStorage) Object.defineProperty(globalThis, "localStorage", realLocalStorage);
  else Reflect.deleteProperty(globalThis, "localStorage");
}

beforeEach(() => {
  raw = new Map();
  failing = false;
  installStorage();
});

afterEach(() => {
  removeStorage();
});

test("DM state persists under the dm:<did>: prefix and survives a new store instance", async () => {
  const store = createBrowserDmStore("did:plc:alice");
  assert.equal(store.persistent, true);
  await store.set("hidden-request:at://x", "1");
  await store.set("renotify:conv:bob", '{"attempts":1}');
  assert.deepEqual(Object.fromEntries(raw), {
    "dm:did:plc:alice:hidden-request:at://x": "1",
    "dm:did:plc:alice:renotify:conv:bob": '{"attempts":1}',
  });

  const restored = createBrowserDmStore("did:plc:alice");
  assert.equal(await restored.get("hidden-request:at://x"), "1");
  assert.equal(await restored.get("missing"), null);

  const other = createBrowserDmStore("did:plc:bob");
  assert.equal(await other.get("hidden-request:at://x"), null, "accounts never share DM state");
});

test("deleting removes only the named entry", async () => {
  const store = createBrowserDmStore("did:plc:alice");
  await store.set("a", "1");
  await store.set("b", "2");
  await store.delete("a");
  assert.equal(await store.get("a"), null);
  assert.equal(await store.get("b"), "2");
});

test("storage failures fall back to memory without throwing and are reported as non-persistent", async () => {
  const store = createBrowserDmStore("did:plc:alice");
  await store.set("before", "kept");
  failing = true;

  await store.set("after", "memory");
  assert.equal(await store.get("after"), "memory");
  await store.delete("after");
  assert.equal(await store.get("after"), null);
  assert.equal(store.persistent, false, "the UI is told state will not survive a reload");

  failing = false;
  assert.equal(await store.get("before"), null, "once storage failed, reads come from the memory fallback");
});

test("unavailable storage is detected up front and still serves every operation from memory", async () => {
  failing = true;
  const store = createBrowserDmStore("did:plc:carol");
  assert.equal(store.persistent, false);
  assert.equal(await store.get("k"), null);
  await store.set("k", "v");
  assert.equal(await store.get("k"), "v");
  await store.delete("k");
  assert.equal(await store.get("k"), null);
});
