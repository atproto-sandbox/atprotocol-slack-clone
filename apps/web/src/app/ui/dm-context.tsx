"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { dmInboxUri } from "@flock/protocol/keys";
import type { BrowserSessionConfig } from "../../browser/session";
import type { DmClient, DmConversationSummary, DmInboxState, DmRequest } from "@flock/client/dm/dm-client";
import { resolveHandle } from "@flock/client/did-documents";
import type { BrowserDmStore } from "@flock/client/dm/browser-store";
import type { BrowserSessionStatus } from "../../browser/use-browser-session";
import { applyAllowlistEdit, coMemberDids, describeSkippedSenders, runDmCycle, type UiWorkspace } from "@flock/client/dm/ui-logic";
import { messageOf } from "./client-api";
import { useBrowserSessionContext } from "./session-context";

export type DmView =
  | { kind: "home" }
  | { kind: "requests" }
  | { kind: "settings" }
  | { kind: "conversation"; convKey: string; participants: string[] };

export type DmContextValue = {
  did: string;
  dmConfig: BrowserSessionConfig;
  status: BrowserSessionStatus;
  loaded: boolean;
  client: DmClient | null;
  store: BrowserDmStore | null;
  conversations: DmConversationSummary[];
  requests: DmRequest[];
  skippedNote: string;
  inbox: DmInboxState | null;
  labels: Readonly<Record<string, string>>;
  workspaces: UiWorkspace[];
  activeWorkspace: UiWorkspace | null;
  showAll: boolean;
  setShowAll: (value: boolean) => void;
  view: DmView | null;
  openView: (view: DmView | null) => void;
  needsNotifyScopeUpgrade: boolean;
  error: string;
  setError: (message: string) => void;
  refresh: () => Promise<void>;
};

const DmContext = createContext<DmContextValue | null>(null);

export function useDmContext(): DmContextValue {
  const value = useContext(DmContext);
  if (!value) throw new Error("useDmContext must be used inside DmProvider.");
  return value;
}

type DmProviderProps = {
  did: string;
  dmConfig: BrowserSessionConfig;
  workspaces: UiWorkspace[];
  activeWorkspace: UiWorkspace | null;
  view: DmView | null;
  openView: (view: DmView | null) => void;
  children: ReactNode;
};

/**
 * Owns the shared DM state tree: the browser-held session, conversation and
 * request lists, display labels, and the content-free real-time fan-in (the
 * operator's change feed, 60-second fallback poll, and re-notify backoff runs). Conversation
 * content lives in `dm-conversation.tsx`; `WorkspaceManager` keeps only the
 * single active DM view selector handed in as `view`.
 */
export function DmProvider({ did, dmConfig, workspaces, activeWorkspace, view, openView, children }: DmProviderProps) {
  const session = useBrowserSessionContext();
  const { status, client, store, live } = session;
  const [conversations, setConversations] = useState<DmConversationSummary[]>([]);
  const [requests, setRequests] = useState<DmRequest[]>([]);
  const [skippedNote, setSkippedNote] = useState("");
  const [inbox, setInbox] = useState<DmInboxState | null>(null);
  const [labels, setLabels] = useState<Record<string, string>>({});
  const [showAll, setShowAll] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [localError, setError] = useState("");
  const error = localError || session.error;
  const resyncedRef = useRef(false);
  const declarationCheckedRef = useRef(false);

  const refresh = useCallback(async (): Promise<DmInboxState | null> => {
    if (!client) return null;
    const [list, scan, inboxState] = await Promise.all([client.listConversations(), client.scanRequests(), client.getInbox()]);
    setConversations(list);
    setRequests(scan.requests);
    setSkippedNote(describeSkippedSenders(scan.skipped));
    setInbox(inboxState);
    setLoaded(true);
    return inboxState;
  }, [client]);

  useEffect(() => {
    if (status !== "ready" || !client) return;
    let cancelled = false;
    const watchController = new AbortController();
    const cycle = async () => {
      if (cancelled) return;
      await runDmCycle({
        refresh,
        client,
        inboxUri: dmInboxUri(did),
        serviceRef: dmConfig.serviceRef,
        signal: watchController.signal,
        declarationChecked: declarationCheckedRef,
        report: (caught) => { if (!cancelled) setError(messageOf(caught)); },
      });
    };
    void cycle();
    const timer = window.setInterval(() => void cycle(), 60_000);
    return () => {
      cancelled = true;
      watchController.abort();
      window.clearInterval(timer);
    };
  }, [status, client, did, dmConfig.serviceRef, refresh]);

  useEffect(() => {
    if (status !== "ready" || !client || resyncedRef.current) return;
    resyncedRef.current = true;
    const resync = async () => {
      try {
        const state = await client.getInbox();
        const seed = coMemberDids(workspaces, did);
        if (state.exists && state.mode === "allowlist" && seed.length > 0) {
          await applyAllowlistEdit(client, { mode: "allowlist", add: seed });
          await refresh();
        }
      } catch (caught) {
        setError(messageOf(caught));
      }
    };
    void resync();
  }, [status, client, did, workspaces, refresh]);

  const inboxExists = Boolean(inbox?.exists);
  useEffect(() => {
    if (!client || !live || !inboxExists) return;
    let stop: (() => void) | undefined;
    let stopped = false;
    // The operator's change feed says when the inbox changed; if unavailable, the 60-second poll keeps the view current.
    void live.watch(`dm:inbox:${did}`, [dmInboxUri(did)], () => refresh()).then(
      (unwatch) => { if (stopped) unwatch(); else stop = unwatch; },
      () => undefined,
    );
    return () => { stopped = true; stop?.(); };
  }, [client, live, did, inboxExists, refresh]);

  useEffect(() => {
    const targets = new Set<string>();
    const consider = (target: string) => {
      if (target !== did && !labels[target]) targets.add(target);
    };
    for (const conversation of conversations) for (const participant of conversation.participants) consider(participant);
    for (const request of requests) {
      consider(request.sender);
      for (const participant of request.participants) consider(participant);
    }
    if (targets.size === 0) return;
    let cancelled = false;
    void Promise.all([...targets].map(async (target) => [target, await resolveHandle(target, { plcUrl: dmConfig.plcUrl, loopback: dmConfig.loopback }).catch(() => null)] as const))
      .then((resolved) => {
        if (cancelled) return;
        setLabels((current) => {
          let changed = false;
          const next = { ...current };
          for (const [target, handle] of resolved) {
            if (handle && !next[target]) {
              next[target] = handle;
              changed = true;
            }
          }
          return changed ? next : current;
        });
      });
    return () => {
      cancelled = true;
    };
  }, [conversations, requests, labels, did, dmConfig.plcUrl, dmConfig.loopback]);

  const subscribeScopeMissing = useCallback(
    (onStoreChange: () => void) => (client ? client.onNotifyScopeMissing(onStoreChange) : () => {}),
    [client],
  );
  const runtimeScopeMissing = useSyncExternalStore(
    subscribeScopeMissing,
    () => Boolean(client?.isNotifyScopeMissing()),
    () => false,
  );
  const needsNotifyScopeUpgrade = session.needsNotifyScopeUpgrade || runtimeScopeMissing;

  const value = useMemo<DmContextValue>(() => ({
    did,
    dmConfig,
    status,
    loaded: Boolean(client && loaded),
    client,
    store,
    conversations: client ? conversations : [],
    requests: client ? requests : [],
    skippedNote: client ? skippedNote : "",
    inbox: client ? inbox : null,
    labels,
    workspaces,
    activeWorkspace,
    showAll,
    setShowAll,
    view,
    openView,
    needsNotifyScopeUpgrade,
    error,
    setError,
    refresh: async () => {
      try {
        await refresh();
      } catch (caught) {
        setError(messageOf(caught));
      }
    },
  }), [did, dmConfig, status, loaded, client, store, conversations, requests, skippedNote, inbox, labels, workspaces, activeWorkspace, showAll, view, openView, needsNotifyScopeUpgrade, error, refresh]);

  return (
    <DmContext.Provider value={value}>
      {children}
    </DmContext.Provider>
  );
}
