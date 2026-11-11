"use client";

import { useCallback, useEffect, useMemo } from "react";
import type { Engine } from "@flock/client/engine";
import type { LiveSpaces, Snapshot, Snapshots } from "@flock/client/views";
import type { WorkspaceDiscovery } from "@flock/client/workspace-client";
import type { WorkspaceSummary } from "@flock/protocol/workspace-summary";
import { shownWorkspace } from "./selection";
import { useLiveKey, useSnapshot } from "./use-live-view";

/** The live view key of the account's workspaces. */
const WORKSPACES_KEY = "workspaces";

/** Rediscovery runs every minute too, since a new invitation reaches no space this account already follows. */
const REDISCOVER_MS = 60_000;

type Session = { engine: Engine | null; live: LiveSpaces | null; snapshots: Snapshots | null };

/**
 * The account's workspaces as a live view, and the one shown: discovered when the session is ready, again when the change
 * feed names the shown workspace's space (its directory, roster or admins changed), and every minute. `listed` sees each
 * discovery as it lands; `reload` discovers now and returns what was found.
 */
export function useDiscovery(session: Session, chosen: string | null, listed: (discovery: WorkspaceDiscovery) => void): {
  discovery: Snapshot<WorkspaceDiscovery>;
  workspace: WorkspaceSummary | null;
  reload: () => Promise<WorkspaceDiscovery | undefined>;
} {
  const { engine, live, snapshots } = session;
  const discovery = useSnapshot<WorkspaceDiscovery>(snapshots, WORKSPACES_KEY);
  const workspace = useMemo(() => shownWorkspace(discovery.value?.workspaces ?? [], chosen), [discovery.value, chosen]);

  const load = useCallback(async (): Promise<WorkspaceDiscovery> => {
    if (!engine) return { workspaces: [], candidates: [] };
    const found = await engine.workspaces.discover();
    listed(found);
    return found;
  }, [engine, listed]);

  useLiveKey(session, engine ? WORKSPACES_KEY : null, workspace ? [workspace.uri] : [], load);
  useEffect(() => {
    if (!live) return;
    const interval = window.setInterval(() => void live.reload(WORKSPACES_KEY), REDISCOVER_MS);
    return () => window.clearInterval(interval);
  }, [live]);

  const reload = useCallback(async () => {
    if (!live || !snapshots) return undefined;
    await live.reload(WORKSPACES_KEY);
    const current = snapshots.get<WorkspaceDiscovery>(WORKSPACES_KEY);
    if (current.error !== undefined) throw current.error;
    return current.value;
  }, [live, snapshots]);

  return { discovery, workspace, reload };
}
