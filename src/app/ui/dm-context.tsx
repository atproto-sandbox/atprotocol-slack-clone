"use client";

import dynamic from "next/dynamic";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { dmInboxUri } from "@/protocol/keys";
import type { DmConfig } from "@/dm/browser-session";
import type { DmClient, DmConversationSummary, DmInboxState, DmRequest } from "@/dm/dm-client";
import { resolveHandle } from "@/dm/browser-identity";
import type { BrowserDmStore } from "@/dm/browser-store";
import type { DmClientState, DmClientStatus } from "@/dm/use-dm-client";
import { applyAllowlistEdit, coMemberDids, describeSkippedSenders, type UiWorkspace } from "@/dm/ui-logic";
import { messageOf } from "./client-api";

// `DmProvider` must keep rendering its non-DM children (`Sidebar`, the
// workspace stage) normally during SSR, which a `next/dynamic(ssr:false)`
// component cannot do for content passed to it as `children`. The DM session
// hook itself (and, through it, the browser-only OAuth/WebCrypto modules) is
// therefore isolated in a childless bridge component instead; see the note
// there for why this is the only path that may import `@/dm/use-dm-client`.
const DmSessionBridge = dynamic(() => import("./dm-session-bridge").then((mod) => mod.DmSessionBridge), { ssr: false });

const DISCONNECTED_SESSION: DmClientState = {
  status: "connecting",
  client: null,
  store: null,
  error: "",
  connect: () => {},
  disconnect: async () => {},
};

export type DmView =
  | { kind: "home" }
  | { kind: "requests" }
  | { kind: "settings" }
  | { kind: "conversation"; convKey: string; participants: string[] };

export type DmContextValue = {
  did: string;
  dmConfig: DmConfig;
  status: DmClientStatus;
  client: DmClient | null;
  store: BrowserDmStore | null;
  connect: () => void;
  disconnect: () => Promise<void>;
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
  dmConfig: DmConfig;
  workspaces: UiWorkspace[];
  activeWorkspace: UiWorkspace | null;
  view: DmView | null;
  openView: (view: DmView | null) => void;
  children: ReactNode;
};

/**
 * Owns the shared DM state tree: the browser-held session, conversation and
 * request lists, display labels, and the content-free real-time fan-in (inbox
 * SSE, 60-second fallback poll, and re-notify backoff runs). Conversation
 * content lives in `dm-conversation.tsx`; `WorkspaceManager` keeps only the
 * single active DM view selector handed in as `view`.
 */
export function DmProvider({ did, dmConfig, workspaces, activeWorkspace, view, openView, children }: DmProviderProps) {
  const [session, setSession] = useState<DmClientState>(DISCONNECTED_SESSION);
  const { status, client, store, connect, disconnect } = session;
  const [conversations, setConversations] = useState<DmConversationSummary[]>([]);
  const [requests, setRequests] = useState<DmRequest[]>([]);
  const [skippedNote, setSkippedNote] = useState("");
  const [inbox, setInbox] = useState<DmInboxState | null>(null);
  const [labels, setLabels] = useState<Record<string, string>>({});
  const [showAll, setShowAll] = useState(false);
  const [localError, setError] = useState("");
  const error = localError || session.error;
  const resyncedRef = useRef(false);

  const refresh = useCallback(async (): Promise<DmInboxState | null> => {
    if (!client) return null;
    const [list, scan, inboxState] = await Promise.all([client.listConversations(), client.scanRequests(), client.getInbox()]);
    setConversations(list);
    setRequests(scan.requests);
    setSkippedNote(describeSkippedSenders(scan.skipped));
    setInbox(inboxState);
    return inboxState;
  }, [client]);

  useEffect(() => {
    if (status !== "ready" || !client) return;
    let cancelled = false;
    const cycle = async () => {
      if (cancelled) return;
      try {
        const state = await refresh();
        await client.renotifyPending();
        if (state?.exists) await client.watch([dmInboxUri(did)], dmConfig.serviceRef);
      } catch (caught) {
        if (!cancelled) setError(messageOf(caught));
      }
    };
    void cycle();
    const timer = window.setInterval(() => void cycle(), 60_000);
    return () => {
      cancelled = true;
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
    if (!client || !inboxExists) return;
    const query = new URLSearchParams({ space: dmInboxUri(did), after: "0" });
    const events = new EventSource(`/api/notifications/dm?${query}`);
    const reload = () => {
      void refresh().catch((caught) => setError(messageOf(caught)));
    };
    events.addEventListener("change", reload);
    events.addEventListener("error", () => {
      if (events.readyState === EventSource.CLOSED) reload();
    });
    return () => events.close();
  }, [client, did, inboxExists, refresh]);

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

  const value = useMemo<DmContextValue>(() => ({
    did,
    dmConfig,
    status,
    client,
    store,
    connect,
    disconnect,
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
    error,
    setError,
    refresh: async () => {
      try {
        await refresh();
      } catch (caught) {
        setError(messageOf(caught));
      }
    },
  }), [did, dmConfig, status, client, store, connect, disconnect, conversations, requests, skippedNote, inbox, labels, workspaces, activeWorkspace, showAll, view, openView, error, refresh]);

  return (
    <DmContext.Provider value={value}>
      <DmSessionBridge did={did} dmConfig={dmConfig} onSession={setSession} />
      {children}
    </DmContext.Provider>
  );
}
