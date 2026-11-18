export type ShellLifecycleSnapshot = {
  mountCount: number;
  unmountCount: number;
  gateToken: string | null;
  sessionBuildCount: number;
  engineToken: string | null;
  liveToken: string | null;
};

const SHELL_LIFECYCLE_KEY = "__flockShellLifecycle";

const instanceTokens = new WeakMap<object, string>();
let instanceSeq = 0;
let gateSeq = 0;

function tokenForInstance(kind: "engine" | "live", instance: object): string {
  let token = instanceTokens.get(instance);
  if (!token) {
    instanceSeq += 1;
    token = `${kind}-${instanceSeq}`;
    instanceTokens.set(instance, token);
  }
  return token;
}

function lifecycleHost(): ShellLifecycleSnapshot | null {
  const win = (globalThis as unknown as { window?: Record<string, unknown> }).window;
  if (!win) return null;
  const existing = win[SHELL_LIFECYCLE_KEY] as ShellLifecycleSnapshot | undefined;
  if (existing) return existing;
  const created: ShellLifecycleSnapshot = {
    mountCount: 0,
    unmountCount: 0,
    gateToken: null,
    sessionBuildCount: 0,
    engineToken: null,
    liveToken: null,
  };
  win[SHELL_LIFECYCLE_KEY] = created;
  return created;
}

/**
 * Tracks `<AccountGate>` React mount/unmount transitions on `window.__flockShellLifecycle` so E2E tests can distinguish
 * a continuously mounted `(shell)` layout from a same-document remount.
 */
export function registerAccountGateMount(): () => void {
  const state = lifecycleHost();
  if (!state) return () => {};
  state.mountCount += 1;
  gateSeq += 1;
  const token = `gate-${gateSeq}`;
  state.gateToken = token;
  return () => {
    state.unmountCount += 1;
    if (state.gateToken === token) state.gateToken = null;
  };
}

/**
 * Tracks live `Engine` and `LiveSpaces` object identities built by `useBrowserSession`, clearing active tokens when the
 * session stops or unmounts.
 */
export function registerShellSession(engine: object, live: object): () => void {
  const state = lifecycleHost();
  if (!state) return () => {};
  const engineToken = tokenForInstance("engine", engine);
  const liveToken = tokenForInstance("live", live);
  state.sessionBuildCount += 1;
  state.engineToken = engineToken;
  state.liveToken = liveToken;
  return () => {
    if (state.engineToken === engineToken) state.engineToken = null;
    if (state.liveToken === liveToken) state.liveToken = null;
  };
}
