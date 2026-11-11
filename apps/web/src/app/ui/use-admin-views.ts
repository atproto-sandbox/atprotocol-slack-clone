"use client";

import { useCallback, useEffect } from "react";
import type { Engine } from "@flock/client/engine";
import type { InboxJoinRequest, SkippedInboxWriter } from "@flock/client/inbox-requests";
import type { StalledWork } from "@flock/client/operator-client";
import type { LiveSpaces, Snapshot, Snapshots } from "@flock/client/views";
import { inboxUri, parseWorkspaceUri } from "@flock/protocol/keys";
import type { WorkspaceSummary } from "@flock/protocol/workspace-summary";
import { httpStatus } from "./client-api";
import { useLiveKey, useSnapshot } from "./use-live-view";

/** What an admin's inbox shows: the open join requests, the writers that could not be read, or that the read was refused. */
type InboxView = { requests: InboxJoinRequest[]; skipped: SkippedInboxWriter[]; refused?: boolean };

/** The live view keys of one workspace's admin inbox and stalled operations. */
const inboxKey = (workspace: string): string => `inbox:${workspace}`;
const stalledKey = (workspace: string): string => `stalled:${workspace}`;

type Session = { engine: Engine | null; live: LiveSpaces | null; snapshots: Snapshots | null };

/** Every minute: the inbox swept whatever the feed said (a request whose notice was dropped reaches no feed), and stalled work. */
const SWEEP_MS = 60_000;

/**
 * The selected workspace's admin views, while the account is its admin and it is within the envelope: the inbox (read again
 * when the change feed names it, and every minute) and the operator's stalled operations (every minute). Each is keyed by
 * its workspace, so a result that lands after the selection moved, or after the account stopped being admin, is never shown.
 */
export function useAdminViews(session: Session, workspace: WorkspaceSummary | null): {
  inbox: Snapshot<InboxView>;
  stalled: Snapshot<StalledWork>;
  reload: () => void;
} {
  const { engine, live, snapshots } = session;
  const uri = workspace?.isAdmin && workspace.degradedReasons.length === 0 ? workspace.uri : null;
  const parsed = uri ? parseWorkspaceUri(uri) : null;
  const inbox = parsed ? inboxUri(parsed.authorityDid, parsed.skey) : null;

  const loadInbox = useCallback(async (): Promise<InboxView> => {
    if (!engine?.operator || !uri) return { requests: [], skipped: [] };
    try {
      const { requests, skipped } = await engine.workspaces.inboxRequests(uri, engine.operator);
      return { requests, skipped };
    } catch (error) {
      if (httpStatus(error) !== 401 && httpStatus(error) !== 403) throw error;
      return { requests: [], skipped: [], refused: true };
    }
  }, [engine, uri]);
  const loadStalled = useCallback(async (): Promise<StalledWork> => {
    if (!engine?.operator || !uri) return { operations: [], registrations: [], truncated: false };
    return engine.operator.listStalledOperations(uri);
  }, [engine, uri]);

  useLiveKey(session, uri ? inboxKey(uri) : null, inbox ? [inbox] : [], loadInbox);
  useLiveKey(session, uri ? stalledKey(uri) : null, [], loadStalled);
  useEffect(() => {
    if (!live || !uri) return;
    const interval = window.setInterval(() => { void live.reload(inboxKey(uri)); void live.reload(stalledKey(uri)); }, SWEEP_MS);
    return () => window.clearInterval(interval);
  }, [live, uri]);

  const reload = useCallback(() => {
    if (!live || !uri) return;
    void live.reload(inboxKey(uri));
    void live.reload(stalledKey(uri));
  }, [live, uri]);

  return {
    inbox: useSnapshot<InboxView>(snapshots, uri ? inboxKey(uri) : null),
    stalled: useSnapshot<StalledWork>(snapshots, uri ? stalledKey(uri) : null),
    reload,
  };
}
