import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { registerAccountGateMount, registerShellSession, type ShellLifecycleSnapshot } from "./shell-lifecycle";

const globalAny = globalThis as unknown as { window?: Record<string, unknown> };
const originalWindow = globalAny.window;

afterEach(() => {
  if (originalWindow === undefined) delete globalAny.window;
  else globalAny.window = originalWindow;
});

test("registerAccountGateMount and registerShellSession detect remounts and new Engine/LiveSpaces instances (Codex #13)", () => {
  const fakeWindow: Record<string, unknown> = {};
  globalAny.window = fakeWindow;

  const engine1 = { id: "engine-a" };
  const live1 = { id: "live-a" };
  const cleanupGate1 = registerAccountGateMount();
  const cleanupSession1 = registerShellSession(engine1, live1);

  const first = fakeWindow.__flockShellLifecycle as ShellLifecycleSnapshot;
  assert.equal(first.mountCount, 1);
  assert.equal(first.unmountCount, 0);
  assert.equal(first.sessionBuildCount, 1);
  assert.ok(first.gateToken);
  assert.ok(first.engineToken);
  assert.ok(first.liveToken);
  const initialTokens = { ...first };

  // Simulate an unintended React remount of AccountGate and useBrowserSession.
  cleanupSession1();
  cleanupGate1();
  assert.equal(first.unmountCount, 1);
  assert.equal(first.gateToken, null);
  assert.equal(first.engineToken, null);
  assert.equal(first.liveToken, null);

  const engine2 = { id: "engine-b" };
  const live2 = { id: "live-b" };
  const cleanupGate2 = registerAccountGateMount();
  const cleanupSession2 = registerShellSession(engine2, live2);

  assert.equal(first.mountCount, 2);
  assert.equal(first.sessionBuildCount, 2);
  assert.notEqual(first.gateToken, initialTokens.gateToken);
  assert.notEqual(first.engineToken, initialTokens.engineToken);
  assert.notEqual(first.liveToken, initialTokens.liveToken);

  cleanupSession2();
  cleanupGate2();
});
