"use client";

import { useCallback, useEffect, useMemo, useRef } from "react";
import type { Engine } from "@flock/client/engine";
import type { LiveSpaces, Snapshot, Snapshots } from "@flock/client/views";
import type { ReceivedGroupInvite, WorkspaceDiscovery } from "@flock/client/workspace-client";
import { groupMembersUri, groupMetaUri, personalInboxUri } from "@flock/protocol/keys";
import type { WorkspaceSummary } from "@flock/protocol/workspace-summary";
import { shownWorkspace } from "./selection";
import { useLiveKey, useSnapshot } from "./use-live-view";

const WORKSPACES_KEY = "workspaces";
const INVITES_KEY = "group-invites";
const REDISCOVER_MS = 60_000;

type Session = {
  engine: Engine | null;
  live: LiveSpaces | null;
  snapshots: Snapshots | null;
  needsNotifyScopeUpgrade?: boolean;
};

/**
 * The account's Atmosphere Groups workspaces and cross-PDS `org.atgrp.inbox/self` inbox as live views:
 * follows `meta/self`, `members/self`, and `workspace/self` on the active workspace, and registers an
 * Operator `getSpaceNotifyTarget` webhook on `personalInboxUri(did)` so incoming cross-PDS invitations
 * wake `LiveSpaces` immediately alongside periodic sweeps.
 */
export function useDiscovery(
  session: Session,
  did: string,
  chosen: string | null,
  listed: (discovery: WorkspaceDiscovery) => void,
): {
  discovery: Snapshot<WorkspaceDiscovery>;
  invites: Snapshot<ReceivedGroupInvite[]>;
  workspace: WorkspaceSummary | null;
  reload: () => Promise<WorkspaceDiscovery | undefined>;
  reloadInvites: () => Promise<void>;
} {
  const { engine, live, snapshots, needsNotifyScopeUpgrade = false } = session;
  const discovery = useSnapshot<WorkspaceDiscovery>(snapshots, WORKSPACES_KEY);
  const invites = useSnapshot<ReceivedGroupInvite[]>(snapshots, INVITES_KEY);
  const workspace = useMemo(() => shownWorkspace(discovery.value?.workspaces ?? [], chosen), [discovery.value, chosen]);
  const watchedInvitesRef = useRef<Engine | null>(null);

  const loadWorkspaces = useCallback(async (): Promise<WorkspaceDiscovery> => {
    if (!engine) {
      return { workspaces: [], candidates: [], joiningGroups: [], leavingGroups: [], reactivatingGroups: [] };
    }
    const autoCreateQueued =
      typeof window !== "undefined" && Boolean(window.sessionStorage.getItem("spaces.autoCreateWorkspace"));
    const found = autoCreateQueued
      ? await engine.workspaces.discoverCore()
      : await engine.workspaces.discover();
    listed(found);
    return found;
  }, [engine, listed]);

  const loadInvites = useCallback(async (): Promise<ReceivedGroupInvite[]> => {
    if (!engine) return [];
    if (engine.operator && !needsNotifyScopeUpgrade && watchedInvitesRef.current !== engine) {
      watchedInvitesRef.current = engine;
      await engine.workspaces.watchInvites(engine.operator).catch(() => {
        if (watchedInvitesRef.current === engine) {
          watchedInvitesRef.current = null;
        }
      });
    }
    return engine.workspaces.listInvites();
  }, [engine, needsNotifyScopeUpgrade]);

  const watchedWorkspaceSpaces = useMemo(
    () =>
      workspace
        ? [workspace.uri, groupMetaUri(workspace.authorityDid), groupMembersUri(workspace.authorityDid)]
        : [],
    [workspace],
  );
  const watchedInvitesSpaces = useMemo(
    () => (engine && !needsNotifyScopeUpgrade ? [personalInboxUri(did)] : []),
    [engine, did, needsNotifyScopeUpgrade],
  );

  useLiveKey(session, engine ? WORKSPACES_KEY : null, watchedWorkspaceSpaces, loadWorkspaces);
  useLiveKey(session, engine ? INVITES_KEY : null, watchedInvitesSpaces, loadInvites);

  useEffect(() => {
    if (!live) return;
    const interval = window.setInterval(() => {
      void live.reload(WORKSPACES_KEY);
      void live.reload(INVITES_KEY);
    }, REDISCOVER_MS);
    return () => window.clearInterval(interval);
  }, [live]);

  const reload = useCallback(async () => {
    if (!live || !snapshots) return undefined;
    await live.reload(WORKSPACES_KEY);
    void live.reload(INVITES_KEY);
    const current = snapshots.get<WorkspaceDiscovery>(WORKSPACES_KEY);
    if (current.error !== undefined) throw current.error;
    return current.value;
  }, [live, snapshots]);

  const reloadInvites = useCallback(async () => {
    if (!live) return;
    await live.reload(INVITES_KEY);
  }, [live]);

  return { discovery, invites, workspace, reload, reloadInvites };
}
