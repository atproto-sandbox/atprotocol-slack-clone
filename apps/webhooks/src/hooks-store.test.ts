import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { HooksStore, sha256Hex } from "./hooks-store";

const directory = mkdtempSync(join(tmpdir(), "webhooks-store-test-"));
after(() => rmSync(directory, { recursive: true, force: true }));

const WORKSPACE = "at:space/did:plc:authority/new.flock.workspace/acme";

test("HooksStore stores only sha256(secret) with 0o600 permissions, rotates and revokes cleanly, and verifies in constant time", async () => {
  const path = join(directory, "hooks.json");
  const store = new HooksStore(path);
  const created = await store.create({
    workspace: WORKSPACE,
    channelSkey: "acme-general",
    channelName: "general",
    privateChannel: false,
    createdBy: "did:plc:admin",
  });

  const onDisk = readFileSync(path, "utf8");
  assert.equal(onDisk.includes(created.secret), false, "plaintext secret is never stored on disk");
  assert.equal(onDisk.includes(sha256Hex(created.secret)), true, "sha256 digest is stored on disk");
  assert.equal(statSync(path).mode & 0o777, 0o600);

  assert.equal((await store.verifySecret(created.hook.id, created.secret))?.id, created.hook.id);
  assert.equal(await store.verifySecret(created.hook.id, `${created.secret.slice(0, -1)}X`), null);
  assert.equal(await store.verifySecret("unknown_hook_id_22char", created.secret), null);
  assert.equal(await store.verifySecret("__proto__", created.secret), null);

  // Rotate invalidates the old secret and issues a new one, still hashed at rest.
  const rotated = await store.rotate(created.hook.id);
  assert.ok(rotated);
  assert.notEqual(rotated.secret, created.secret);
  assert.equal(readFileSync(path, "utf8").includes(rotated.secret), false);
  assert.equal(await store.verifySecret(created.hook.id, created.secret), null);
  assert.equal((await store.verifySecret(created.hook.id, rotated.secret))?.id, created.hook.id);

  // Revoking hides the hook from active listings and refuses verification.
  assert.equal(await store.revoke(created.hook.id), true);
  assert.equal(await store.verifySecret(created.hook.id, rotated.secret), null);
  assert.deepEqual(await store.listActiveForWorkspace(WORKSPACE), []);
  assert.equal(await store.rotate(created.hook.id), null);
});

test("HooksStore narrows overly wide permissions and refuses symlinks", async () => {
  const plain = join(directory, "wide-hooks.json");
  writeFileSync(plain, JSON.stringify({ hooks: {} }), { mode: 0o644 });
  chmodSync(plain, 0o644);
  const store = new HooksStore(plain);
  assert.deepEqual(await store.listActiveForWorkspace(WORKSPACE), []);
  assert.equal(statSync(plain).mode & 0o777, 0o600);

  const link = join(directory, "linked-hooks.json");
  symlinkSync(plain, link);
  await assert.rejects(new HooksStore(link).listActiveForWorkspace(WORKSPACE), /plain file, not a link/);

  // Once warmed up, verifySecret serves from the in-memory cache without re-reading disk on every unauthenticated call.
  const cachedPath = join(directory, "cached-hooks.json");
  const cachedStore = new HooksStore(cachedPath);
  const { hook, secret } = await cachedStore.create({
    workspace: WORKSPACE,
    channelSkey: "acme-general",
    channelName: "general",
    privateChannel: false,
    createdBy: "did:plc:admin",
  });
  unlinkSync(cachedPath);
  assert.equal((await cachedStore.verifySecret(hook.id, secret))?.id, hook.id, "serves from memory cache without disk read");
});

test("HooksStore normalizes legacy at://<did>/space/... workspace URIs on cold load", async () => {
  const legacyPath = join(directory, "legacy-hooks.json");
  const legacyWorkspace = "at://did:plc:authority/space/new.flock.workspace/acme";
  writeFileSync(
    legacyPath,
    JSON.stringify({
      hooks: {
        legacyHookId0123456789: {
          id: "legacyHookId0123456789",
          workspace: legacyWorkspace,
          channelSkey: "general",
          channelName: "general",
          privateChannel: false,
          secretSha256: sha256Hex("secret"),
          createdBy: "did:plc:admin",
          createdAt: "2026-11-20T00:00:00.000Z",
          updatedAt: "2026-11-20T00:00:00.000Z",
        },
      },
    }),
    { mode: 0o600 },
  );
  const store = new HooksStore(legacyPath);
  const active = await store.listActiveForWorkspace(WORKSPACE);
  assert.equal(active.length, 1);
  assert.equal(active[0]?.workspace, WORKSPACE);
});
