"use client";

import { useCallback, useEffect } from "react";
import type { Engine } from "@flock/client/engine";
import type { TasksSpaceView } from "@flock/client/ext/tasks";
import type { LiveSpaces, Snapshot, Snapshots } from "@flock/client/views";
import { useLiveKey, useSnapshot } from "../../use-live-view";

export function tasksSnapshotKey(workspaceUri: string): string {
  return `tasks:${workspaceUri}`;
}

/**
 * Returns the space URIs whose change-feed ticks should invalidate and reload the Tasks view: both the workspace space
 * (roster/install/extension mutations) and the isolated Tasks space itself.
 */
export function tasksWatchedSpaces(workspaceUri: string | null, tasksSpaceUri: string | null): string[] {
  if (!workspaceUri) return [];
  return tasksSpaceUri ? [workspaceUri, tasksSpaceUri] : [workspaceUri];
}

type Session = { engine: Engine | null; live: LiveSpaces | null; snapshots: Snapshots | null };

const TASKS_FALLBACK_POLL_MS = 60_000;

/**
 * Keeps a workspace's Tasks space subscribed in `LiveSpaces` so remote task, edit, project, and comment writes update
 * the UI live, while providing immediate post-mutation and explicit fresh sync helpers.
 */
export function useTasksSpace(
  session: Session,
  workspaceUri: string | null,
  tasksSpaceUri: string | null,
): {
  tasksView: Snapshot<TasksSpaceView>;
  reload: (options?: { fresh?: boolean }) => Promise<void>;
} {
  const { engine, live, snapshots } = session;
  const key = workspaceUri && tasksSpaceUri ? tasksSnapshotKey(workspaceUri) : null;

  const load = useCallback(async (): Promise<TasksSpaceView> => {
    if (!engine || !workspaceUri) {
      throw new Error("Tasks workspace session is not ready.");
    }
    return engine.tasks.readSpace(workspaceUri);
  }, [engine, workspaceUri]);

  useLiveKey(session, key, tasksWatchedSpaces(workspaceUri, tasksSpaceUri), load);

  useEffect(() => {
    if (!live || !key) return;
    const interval = window.setInterval(() => void live.reload(key), TASKS_FALLBACK_POLL_MS);
    return () => window.clearInterval(interval);
  }, [live, key]);

  const reload = useCallback(
    async (options: { fresh?: boolean } = {}) => {
      if (!engine || !snapshots || !key || !workspaceUri) return;
      if (options.fresh) {
        await snapshots.refresh(key, () => engine.tasks.readSpace(workspaceUri, { fresh: true }));
        return;
      }
      if (live) {
        await live.reload(key);
        return;
      }
      await snapshots.refresh(key, () => engine.tasks.readSpace(workspaceUri));
    },
    [engine, live, snapshots, key, workspaceUri],
  );

  return {
    tasksView: useSnapshot<TasksSpaceView>(snapshots, key),
    reload,
  };
}
