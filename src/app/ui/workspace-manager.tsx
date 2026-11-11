"use client";

import dynamic from "next/dynamic";
import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChannelView } from "./channel-view";
import { api, captureInviteLink, httpStatus, INVITE_LINK_KEY, isAccessFailure, isAuthorizationRequired, makeTid, WORKSPACE_OPERATION_KEY, workspaceOperationIdFor, mergeMessages, messageOf, parsePastedWorkspaceUri, TRANSITIONING_STATUS, withReactions, type ChannelSelection, type InboxRequest, type Message, type PendingOperation, type Reaction, type StalledOperation } from "./client-api";
import { DmProvider, type DmView } from "./dm-context";
import { InviteBanner } from "./invite-banner";
import { SessionProvider, useBrowserSessionContext } from "./session-context";
import { Sidebar } from "./sidebar";
import { WorkspaceHome } from "./workspace-home";
import { WorkspaceOnboarding } from "./workspace-onboarding";
import type { BrowserSessionConfig } from "@/browser/session";
import { SPACE_TYPE } from "@/protocol/nsids";
import { CHANNEL_PAGE } from "@/client/channel-client";
import type { LiveSpaces } from "@/client/views";
import type { WorkspaceCandidate } from "@/client/workspace-client";
import { channelUri, inboxUri, parseWorkspaceUri } from "@/protocol/keys";
import type { WorkspaceSummary } from "@/protocol/workspace-summary";

// The DM stage renders only client-side; see the note in sidebar.tsx.
const DmStage = dynamic(() => import("./dm-stage").then((mod) => mod.DmStage), { ssr: false });

type RefreshSelectedChannel = (selected: ChannelSelection) => Promise<void>;

/** The live view key of one open channel. */
function channelKey(channel: { workspace: string; skey: string }): string {
  return `channel:${channel.workspace} ${channel.skey}`;
}

/** The live view key of one workspace's admin inbox. */
function inboxKey(workspace: string): string {
  return `inbox:${workspace}`;
}

/** Keeps `key` live through the engine's change feed while an effect runs; the returned function stops it. */
function followLive(live: LiveSpaces, key: string, spaces: string[], load: () => Promise<unknown>, report: (message: string) => void): () => void {
  let stop: (() => void) | undefined;
  let stopped = false;
  void live.watch(key, spaces, load).then(
    (unwatch) => { if (stopped) unwatch(); else stop = unwatch; },
    (caught) => report(messageOf(caught)),
  );
  return () => { stopped = true; stop?.(); };
}

/** The signed-in account's app: its browser session restored once, and the workspace, channel and DM views on top of it. */
export function WorkspaceManager({ did, dmConfig }: { did: string; dmConfig: BrowserSessionConfig }) {
  return (
    <SessionProvider did={did} config={dmConfig}>
      <WorkspaceShell did={did} dmConfig={dmConfig} />
    </SessionProvider>
  );
}

function WorkspaceShell({ did, dmConfig }: { did: string; dmConfig: BrowserSessionConfig }) {
  // Reads come from the engine on the browser session; writes and operator calls still go through the server (R6a).
  const { engine, live, status: sessionStatus, error: sessionError, connect: connectSession } = useBrowserSessionContext();
  const [workspaces, setWorkspaces] = useState<WorkspaceSummary[]>([]);
  /** The last discovery's workspaces, as of now rather than as of the last render, for loads that land later. */
  const workspacesRef = useRef<WorkspaceSummary[]>([]);
  const [workspaceCandidates, setWorkspaceCandidates] = useState<WorkspaceCandidate[]>([]);
  const [inboxLoaded, setInboxLoaded] = useState(false);
  const [inboxPermissionMissing, setInboxPermissionMissing] = useState(false);
  const [activeUri, setActiveUri] = useState("");
  const [activeChannel, setActiveChannel] = useState<ChannelSelection | null>(null);
  const [dmView, setDmView] = useState<DmView | null>(null);
  const [workspaceName, setWorkspaceName] = useState("");
  const [inviteUri, setInviteUri] = useState("");
  const [invitedTo, setInvitedTo] = useState<string | null>(null);
  const [workspacesLoaded, setWorkspacesLoaded] = useState(false);
  const [messageText, setMessageText] = useState("");
  const [replyTo, setReplyTo] = useState("");
  const [messages, setMessages] = useState<Message[]>([]);
  const [inbox, setInbox] = useState<InboxRequest[]>([]);
  const [stalledOperations, setStalledOperations] = useState<StalledOperation[]>([]);
  const [stalledOperationsTruncated, setStalledOperationsTruncated] = useState(false);
  const [privateRoster, setPrivateRoster] = useState<string[]>([]);
  const [requestSubmitted, setRequestSubmitted] = useState(false);
  const [needOperatorLeave, setNeedOperatorLeave] = useState(false);
  const [pendingOperation, setPendingOperation] = useState<PendingOperation | null>(null);
  const [operatorReady, setOperatorReady] = useState(false);
  const [nextCursor, setNextCursor] = useState<string | undefined>(undefined);
  const [hasMore, setHasMore] = useState(false);
  const [needJoinWrite, setNeedJoinWrite] = useState(false);
  const [channelReading, setChannelReading] = useState(false);
  /** The channel whose first load the view waits for, so it shows as busy from the click on. */
  const [awaitingChannel, setAwaitingChannel] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const channelDataEpoch = useRef(0);
  const channelReads = useRef(0);
  /** How many messages the open channel shows, so a reload reads as many. */
  const shownRef = useRef<{ key: string | null; count: number }>({ key: null, count: 0 });
  const operatorDataEpoch = useRef(0);
  const workspaceRefreshEpoch = useRef(0);
  const activeUriRef = useRef(activeUri);
  const activeChannelRef = useRef<ChannelSelection | null>(null);
  const refreshSelectedChannelRef = useRef<RefreshSelectedChannel | null>(null);
  const inboxPermissionMissingRef = useRef(false);
  const joiningRef = useRef(false);
  const resumedRef = useRef(false);

  const activeWorkspace = useMemo(() => workspaces.find((workspace) => workspace.uri === activeUri) ?? null, [activeUri, workspaces]);
  const workspaceDegraded = Boolean(activeWorkspace?.degradedReasons.length);

  const selectWorkspace = useCallback((uri: string) => {
    operatorDataEpoch.current += 1;
    inboxPermissionMissingRef.current = false;
    setInboxLoaded(false);
    setInboxPermissionMissing(false);
    activeUriRef.current = uri;
    setActiveUri(uri);
    setInbox([]);
    setStalledOperations([]);
  }, []);

  const selectChannel = useCallback((channel: ChannelSelection | null) => {
    activeChannelRef.current = channel;
    setActiveChannel(channel);
  }, []);

  /**
   * Empties the open channel's content. The join-request state (the "grant request access" box and whether a request was
   * sent) is the account's own, not channel data, so a background reload that fails to read the channel keeps it; only
   * leaving the channel clears it.
   */
  const resetChannelContent = useCallback((options: { keepRequestAccess?: boolean } = {}) => {
    setMessages([]); setPrivateRoster([]); setHasMore(false); setNextCursor(undefined); setReplyTo(""); setMessageText("");
    if (!options.keepRequestAccess) { setNeedJoinWrite(false); setRequestSubmitted(false); }
  }, []);

  const clearChannelView = useCallback(() => {
    channelDataEpoch.current += 1;
    activeChannelRef.current = null;
    setActiveChannel(null);
    resetChannelContent();
  }, [resetChannelContent]);

  const openDmView = useCallback((view: DmView | null) => {
    setDmView(view);
    if (view) clearChannelView();
  }, [clearChannelView]);

  const handleChannelReadFailure = useCallback((caught: unknown) => {
    const statusCode = httpStatus(caught);
    if (statusCode !== 401 && statusCode !== 403 && statusCode !== 409) return false;
    channelDataEpoch.current += 1;
    resetChannelContent({ keepRequestAccess: true });
    const selected = activeChannelRef.current;
    if (selected) void refreshSelectedChannelRef.current?.(selected).catch((error) => setError(messageOf(error)));
    return true;
  }, [resetChannelContent]);

  const refreshWorkspaces = useCallback(async () => {
    const requestEpoch = ++workspaceRefreshEpoch.current;
    try {
      if (!engine) return null;
      const result = await engine.workspaces.discover();
      if (workspaceRefreshEpoch.current !== requestEpoch) return null;
      setWorkspaceCandidates(result.candidates);
      const current = activeUriRef.current;
      const selectedStillExists = current !== "" && result.workspaces.some((workspace) => workspace.uri === current);
      workspacesRef.current = result.workspaces;
      setWorkspaces(result.workspaces);
      setWorkspacesLoaded(true);
      // Already a member: the invitation has been used, so do not keep offering it.
      const waiting = sessionStorage.getItem(INVITE_LINK_KEY);
      if (waiting && result.workspaces.some((workspace) => workspace.uri === waiting)) {
        sessionStorage.removeItem(INVITE_LINK_KEY);
        setInvitedTo((current) => current === waiting ? null : current);
      }
      if (!selectedStillExists) {
        const fallback = result.workspaces[0]?.uri ?? "";
        selectWorkspace(fallback);
        clearChannelView();
        setInbox([]); setStalledOperations([]);
      } else {
        const selectedChannel = activeChannelRef.current;
        if (selectedChannel?.workspace === current) {
          const workspace = result.workspaces.find((entry) => entry.uri === current);
          const channel = workspace?.channels.find((entry) => entry.skey === selectedChannel.skey);
          if (!channel) clearChannelView();
          else if (channel.visibility !== selectedChannel.visibility) {
            channelDataEpoch.current += 1;
            selectChannel({ ...selectedChannel, name: channel.name, visibility: channel.visibility });
            resetChannelContent();
            if (channel.visibility === "transitioning") setStatus(TRANSITIONING_STATUS);
          } else if (channel.name !== selectedChannel.name) selectChannel({ ...selectedChannel, name: channel.name });
        }
        // Inbox and operator results still on their way are dropped only when the account is no longer this workspace's
        // admin; a discovery that changed nothing for them leaves them be.
        if (!result.workspaces.find((workspace) => workspace.uri === current)?.isAdmin) {
          operatorDataEpoch.current += 1;
          setInbox([]);
          setStalledOperations([]);
        }
      }
      return result.workspaces;
    } catch (caught) {
      if (workspaceRefreshEpoch.current !== requestEpoch) return null;
      workspacesRef.current = [];
      setWorkspaces([]);
      setWorkspaceCandidates([]);
      selectWorkspace("");
      clearChannelView();
      setInbox([]); setStalledOperations([]);
      throw caught;
    }
  }, [engine, clearChannelView, resetChannelContent, selectChannel, selectWorkspace]);

  /** Runs a read of the open channel; the channel shows as busy until every read in flight has settled. */
  const readingChannel = useCallback(async <T,>(read: () => Promise<T>): Promise<T> => {
    channelReads.current += 1;
    setChannelReading(true);
    try { return await read(); }
    finally {
      channelReads.current -= 1;
      if (channelReads.current === 0) setChannelReading(false);
    }
  }, []);

  useEffect(() => {
    shownRef.current = { key: activeChannel ? channelKey(activeChannel) : null, count: messages.length };
  }, [activeChannel, messages]);

  /**
   * Reads a page of the open channel: older than `before` to append, else the newest, as many as the view already shows (a
   * reload keeps the older pages a person loaded).
   */
  const loadMessages = useCallback((channel: ChannelSelection, before?: string, append = false) => readingChannel(async () => {
    const selectedChannel = activeChannelRef.current;
    if (!engine || !selectedChannel || selectedChannel.workspace !== channel.workspace || selectedChannel.skey !== channel.skey) return false;
    const requestEpoch = channelDataEpoch.current;
    const shown = shownRef.current.key === channelKey(channel) ? shownRef.current.count : 0;
    let page: Awaited<ReturnType<typeof engine.channels.readPage>>;
    try {
      page = await engine.channels.readPage({ workspace: channel.workspace, skey: channel.skey }, before !== undefined ? { before } : { limit: Math.max(CHANNEL_PAGE, shown) });
    } catch (caught) {
      if (channelDataEpoch.current === requestEpoch) handleChannelReadFailure(caught);
      throw caught;
    }
    if (channelDataEpoch.current !== requestEpoch) return false;
    const messages = withReactions(page.messages as Array<Omit<Message, "reactions">>, page.reactions as Reaction[], did);
    setMessages((current) => mergeMessages(current, messages, append));
    setNextCursor(page.next);
    setHasMore(page.next !== undefined);
    if (page.degradedReasons.length) setStatus(`${page.degradedReasons.join(" ")} Older records need operator review.`);
    else setStatus("");
    return true;
  }), [engine, did, handleChannelReadFailure, readingChannel]);

  const refreshPrivateRoster = useCallback((channel: ChannelSelection) => readingChannel(async () => {
    const selectedChannel = activeChannelRef.current;
    if (!selectedChannel || selectedChannel.workspace !== channel.workspace || selectedChannel.skey !== channel.skey) return;
    if (!engine) return;
    const requestEpoch = channelDataEpoch.current;
    let members: string[];
    try {
      members = await engine.channels.roster({ workspace: channel.workspace, skey: channel.skey });
    } catch (caught) {
      if (channelDataEpoch.current === requestEpoch) handleChannelReadFailure(caught);
      throw caught;
    }
    if (channelDataEpoch.current !== requestEpoch) return;
    setPrivateRoster(members);
  }), [engine, handleChannelReadFailure, readingChannel]);

  /**
   * The open channel's page and, for a private channel, its roster: what the channel's live watch loads when it starts and
   * whenever the change feed names the channel. A private channel this account is not on answers with a refusal, and its
   * roster card offers to request access.
   */
  const loadChannelContent = useCallback(async () => {
    const selected = activeChannelRef.current;
    try {
      if (!selected || selected.visibility === "transitioning") return;
      await readingChannel(async () => {
        if (!await loadMessages(selected)) return;
        if (selected.visibility === "private") await refreshPrivateRoster(selected);
      });
    } catch (caught) {
      if (selected?.visibility !== "private" || !isAccessFailure(caught)) setError(messageOf(caught));
    } finally {
      if (selected) setAwaitingChannel((current) => (current === channelKey(selected) ? null : current));
    }
  }, [loadMessages, refreshPrivateRoster, readingChannel]);

  /**
   * The open channel's name and visibility as `workspaces` list them: a channel gone from the directory closes, and one in
   * transition empties. Its content is the channel's live watch's to load.
   */
  const followSelection = useCallback((workspaces: WorkspaceSummary[], requested: ChannelSelection) => {
    const latest = activeChannelRef.current;
    if (!latest || latest.workspace !== requested.workspace || latest.skey !== requested.skey || activeUriRef.current !== requested.workspace) return;
    const channel = workspaces.find((entry) => entry.uri === requested.workspace)?.channels.find((entry) => entry.skey === requested.skey);
    if (!channel) { clearChannelView(); return; }
    if (latest.name !== channel.name || latest.visibility !== channel.visibility) {
      selectChannel({ workspace: requested.workspace, skey: channel.skey, name: channel.name, visibility: channel.visibility });
    }
    if (channel.visibility === "transitioning") {
      channelDataEpoch.current += 1;
      resetChannelContent();
      setStatus(TRANSITIONING_STATUS);
    }
  }, [clearChannelView, resetChannelContent, selectChannel]);

  /** Reads the workspaces again and has the open channel follow what they list. */
  const refreshSelectedChannel = useCallback(async (requested: ChannelSelection) => {
    const selected = activeChannelRef.current;
    if (!selected || selected.workspace !== requested.workspace || selected.skey !== requested.skey || activeUriRef.current !== requested.workspace) return;
    const current = await refreshWorkspaces();
    if (current) followSelection(current, requested);
  }, [followSelection, refreshWorkspaces]);
  useEffect(() => { refreshSelectedChannelRef.current = refreshSelectedChannel; }, [refreshSelectedChannel]);

  const recheckChannelAfterAccessFailure = useCallback((caught: unknown) => {
    if (!isAccessFailure(caught)) return;
    const selected = activeChannelRef.current;
    if (selected) void refreshSelectedChannel(selected).catch((error) => setError(messageOf(error)));
  }, [refreshSelectedChannel]);

  const acceptWorkspace = useCallback(async (workspace: string) => {
    setBusy(true);
    setError("");
    try {
      await api("/api/workspaces/accept", { method: "POST", body: JSON.stringify({ workspace }) });
      setStatus("Workspace invitation accepted. Loading shared records…");
      const current = await refreshWorkspaces();
      if (!current?.some((entry) => entry.uri === workspace)) {
        setStatus("");
        setError("You accepted the invitation, but the workspace isn't available to you yet. Use Refresh in a moment, and ask an admin to check that your account was added.");
        return;
      }
      selectWorkspace(workspace); clearChannelView();
      setInviteUri("");
      setInvitedTo((current) => current === workspace ? null : current);
      if (sessionStorage.getItem(INVITE_LINK_KEY) === workspace) sessionStorage.removeItem(INVITE_LINK_KEY);
    } catch (caught) {
      setError(messageOf(caught));
    } finally {
      setBusy(false);
    }
  }, [clearChannelView, refreshWorkspaces, selectWorkspace]);

  const grant = useCallback(async (action: string, workspaceUri?: string, skey?: string, workspaceName?: string) => {
    const ref = workspaceUri ? parsePastedWorkspaceUri(workspaceUri) : null;
    const response = await api<{ redirectUrl: string }>("/api/oauth/permission", {
      method: "POST",
      body: JSON.stringify({ action, workspaceDid: ref?.authorityDid ?? did, ...(ref ? { workspaceSkey: ref.skey } : {}), ...(skey ? { skey } : {}), ...(workspaceName ? { workspaceName } : {}) }),
    });
    window.location.assign(response.redirectUrl);
  }, [did]);

  // The first workspace needs a one-time permission grant. The server says so with a typed
  // error, and this authorizes, returns, and resumes the same journaled operation once. The
  // resumed attempt must not redirect again, so a grant that did not take shows an error
  // instead of looping.
  const createWorkspaceNamed = useCallback(async (name: string, options: { mayAuthorize: boolean }) => {
    let redirecting = false;
    setBusy(true); setError(""); setStatus("Creating protocol spaces and authority records…");
    try {
      const operationId = workspaceOperationIdFor(name, sessionStorage.getItem(WORKSPACE_OPERATION_KEY));
      sessionStorage.setItem(WORKSPACE_OPERATION_KEY, JSON.stringify({ name, operationId }));
      const result = await api<{ workspace: string; state: string; completedSteps: string[]; error?: string }>("/api/workspaces/bootstrap", {
        method: "POST", body: JSON.stringify({ name, operationId }),
      });
      const current = await refreshWorkspaces();
      if (current?.some((entry) => entry.uri === result.workspace)) {
        selectWorkspace(result.workspace); clearChannelView();
      }
      if (result.state === "completed") {
        sessionStorage.removeItem(WORKSPACE_OPERATION_KEY);
        setStatus("Workspace created on AT Protocol.");
      } else setStatus(`Setup is pending after ${result.completedSteps.length} steps.${result.error ? ` ${result.error}` : ""} Retry to resume.`);
    } catch (caught) {
      setStatus("");
      if (!isAuthorizationRequired(caught)) { setError(messageOf(caught)); return; }
      if (!options.mayAuthorize) {
        setError("Permission was not granted, so the workspace could not be created. Try again and approve every requested permission.");
        return;
      }
      setStatus("Opening the permission screen. Approve it to finish creating your workspace…");
      sessionStorage.setItem("spaces.pendingWorkspaceName", name);
      sessionStorage.setItem("spaces.autoCreateWorkspace", "1");
      try {
        await grant("workspaceAuthority", undefined, undefined, name);
        redirecting = true;
      } catch (grantFailure) {
        sessionStorage.removeItem("spaces.pendingWorkspaceName");
        sessionStorage.removeItem("spaces.autoCreateWorkspace");
        setStatus("");
        setError(messageOf(grantFailure));
      }
    } finally { if (!redirecting) setBusy(false); }
  }, [clearChannelView, grant, refreshWorkspaces, selectWorkspace]);

  /** The admin inbox of `workspaceUri`, while it is the selected workspace and this account is its admin. */
  const loadInboxFor = useCallback(async (workspaceUri: string) => {
    // Every inbox load goes through the inbox's live view, which runs one at a time per workspace.
    const summary = workspacesRef.current.find((workspace) => workspace.uri === workspaceUri);
    if (activeUriRef.current !== workspaceUri || !summary?.isAdmin || summary.degradedReasons.length || inboxPermissionMissingRef.current) return;
    const requestEpoch = operatorDataEpoch.current;
    try {
      if (!engine?.operator) return;
      const result: { requests: InboxRequest[]; skipped?: Array<{ did: string; reason: string }> } = await engine.workspaces.inboxRequests(workspaceUri, engine.operator);
      if (operatorDataEpoch.current !== requestEpoch || activeUriRef.current !== workspaceUri) return;
      setInbox(result.requests);
      if (result.skipped?.length) setStatus(`Join requests from ${result.skipped.map(({ did, reason }) => `${did} (${reason})`).join("; ")} could not be read.`);
      setInboxLoaded(true);
      setInboxPermissionMissing(false);
      inboxPermissionMissingRef.current = false;
    } catch (caught) {
      if (operatorDataEpoch.current !== requestEpoch || activeUriRef.current !== workspaceUri) return;
      setInbox([]);
      setInboxLoaded(false);
      if (httpStatus(caught) === 401 || httpStatus(caught) === 403) {
        setInboxPermissionMissing(true);
        inboxPermissionMissingRef.current = true;
        return;
      }
      setError(messageOf(caught));
    }
  }, [engine]);

  /** The stalled operations of `workspaceUri`, while it is the selected workspace and this account is its admin. */
  const loadStalledOperationsFor = useCallback(async (workspaceUri: string) => {
    const summary = workspacesRef.current.find((workspace) => workspace.uri === workspaceUri);
    if (activeUriRef.current !== workspaceUri || !summary?.isAdmin) return;
    const requestEpoch = operatorDataEpoch.current;
    try {
      const result = await api<{ operations: StalledOperation[]; truncated: boolean }>(`/api/operator/stalled?workspace=${encodeURIComponent(workspaceUri)}`);
      if (operatorDataEpoch.current !== requestEpoch || activeUriRef.current !== workspaceUri) return;
      setStalledOperations(result.operations);
      setStalledOperationsTruncated(result.truncated);
    } catch (caught) {
      if (operatorDataEpoch.current !== requestEpoch || activeUriRef.current !== workspaceUri) return;
      setStalledOperations([]);
      setStalledOperationsTruncated(false);
      setError(messageOf(caught));
    }
  }, []);

  useEffect(() => {
    // Back from the permission screen restores this page as it was left. The resume flags must not
    // survive to auto-run later, and the form must be usable again.
    const onPageShow = (event: PageTransitionEvent) => {
      if (!event.persisted) return;
      sessionStorage.removeItem("spaces.autoCreateWorkspace");
      sessionStorage.removeItem("spaces.pendingWorkspaceName");
      sessionStorage.removeItem("spaces.pendingInvite");
      setBusy(false);
      setStatus("");
    };
    window.addEventListener("pageshow", onPageShow);
    return () => window.removeEventListener("pageshow", onPageShow);
  }, []);

  useEffect(() => {
    // What arrives in the URL is taken before the browser session is ready, since connecting it leaves the page.
    const timer = window.setTimeout(() => {
      const search = window.location.search;
      const invitedWorkspace = captureInviteLink(search, sessionStorage) ?? sessionStorage.getItem(INVITE_LINK_KEY);
      const authorityFailed = new URLSearchParams(search).get("authority") === "failed";
      if (search.includes("invite=") || search.includes("authority=")) window.history.replaceState(null, "", window.location.pathname);
      if (invitedWorkspace) { setInvitedTo(invitedWorkspace); setInviteUri(invitedWorkspace); }
      // A workspace creation that was waiting on the approval reports the outcome itself when it retries.
      if (authorityFailed && !sessionStorage.getItem("spaces.autoCreateWorkspace")) {
        setError("The workspace authority permission was not approved. Try again from the operation that asked for it.");
      }
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);

  useEffect(() => {
    // Everything this resumes reads through the engine, so it waits for the browser session, and runs once.
    if (!engine) return;
    const timer = window.setTimeout(() => {
      if (resumedRef.current) return;
      resumedRef.current = true;
      void refreshWorkspaces().catch((caught) => setError(messageOf(caught)));
      const savedName = sessionStorage.getItem("spaces.pendingWorkspaceName");
      if (savedName) { setWorkspaceName(savedName); sessionStorage.removeItem("spaces.pendingWorkspaceName"); }
      if (sessionStorage.getItem("spaces.autoCreateWorkspace")) {
        sessionStorage.removeItem("spaces.autoCreateWorkspace");
        if (savedName) void createWorkspaceNamed(savedName, { mayAuthorize: false });
      }
      const savedOperatorOperation = sessionStorage.getItem("spaces.pendingOperatorOperation");
      if (savedOperatorOperation) {
        try { setPendingOperation(JSON.parse(savedOperatorOperation) as PendingOperation); }
        catch { sessionStorage.removeItem("spaces.pendingOperatorOperation"); }
      }
      const pendingInvite = sessionStorage.getItem("spaces.pendingInvite");
      if (pendingInvite) { sessionStorage.removeItem("spaces.pendingInvite"); void acceptWorkspace(pendingInvite); }
      const pendingChannel = sessionStorage.getItem("spaces.pendingChannel");
      if (pendingChannel) {
        sessionStorage.removeItem("spaces.pendingChannel");
        try {
          const channel = JSON.parse(pendingChannel) as ChannelSelection;
          channelDataEpoch.current += 1;
          selectWorkspace(channel.workspace); selectChannel(channel);
          setAwaitingChannel(channel.visibility !== "transitioning" ? channelKey(channel) : null);
        } catch { setError("Could not restore the channel selection."); }
      }
    }, 0);
    return () => window.clearTimeout(timer);
  }, [engine, acceptWorkspace, createWorkspaceNamed, refreshWorkspaces, selectChannel, selectWorkspace]);

  useEffect(() => {
    if (!activeChannel) return;
    // Once a minute the open channel is read again with its workspace, whatever the change feed said.
    const timer = window.setInterval(() => {
      void refreshSelectedChannel(activeChannel).then(() => live?.reload(channelKey(activeChannel))).catch((caught) => setError(messageOf(caught)));
    }, 60_000);
    return () => window.clearInterval(timer);
  }, [activeChannel, live, refreshSelectedChannel]);

  useEffect(() => {
    if (!activeWorkspace?.isAdmin || !live) return;
    const workspace = parseWorkspaceUri(activeWorkspace.uri);
    if (!workspace) return;
    // Stalled operations come from the operator through the server (R6a): read now and every minute. The inbox's join
    // requests are read again whenever the change feed says the inbox changed, and every minute regardless: a request whose
    // notification was dropped reaches no feed, and only the sweep's union of inbox writers finds it.
    const workspaceUri = activeWorkspace.uri;
    const key = inboxKey(workspaceUri);
    const timer = window.setTimeout(() => void loadStalledOperationsFor(workspaceUri), 0);
    const interval = window.setInterval(() => { void loadStalledOperationsFor(workspaceUri); void live.reload(key); }, 60_000);
    const stopInbox = followLive(live, key, [inboxUri(workspace.authorityDid, workspace.skey)], () => loadInboxFor(workspaceUri), setError);
    return () => { window.clearTimeout(timer); window.clearInterval(interval); stopInbox(); };
  }, [activeWorkspace?.uri, activeWorkspace?.isAdmin, live, loadInboxFor, loadStalledOperationsFor]);

  useEffect(() => {
    if (!activeWorkspace?.isAdmin || activeWorkspace.degradedReasons.length || !operatorReady) return;
    const reconcile = () => {
      void api<{ operation: { state: string; error?: string } }>("/api/operator/reconcile", {
        method: "POST", body: JSON.stringify({ workspace: activeWorkspace.uri }),
      }).then((result) => {
        if (result.operation.state !== "completed") setStatus(`Workspace reconciliation is ${result.operation.state}.${result.operation.error ? ` ${result.operation.error}` : ""}`);
      }).catch((caught) => setError(messageOf(caught)));
    };
    const timer = window.setTimeout(reconcile, 0);
    const interval = window.setInterval(reconcile, 300_000);
    return () => { window.clearTimeout(timer); window.clearInterval(interval); };
  }, [activeWorkspace?.uri, activeWorkspace?.isAdmin, activeWorkspace?.degradedReasons.length, operatorReady]);

  useEffect(() => {
    if (!live || !activeWorkspace?.uri) return;
    const workspaceUri = activeWorkspace.uri;
    // The workspace's directory, roster and admins: with a channel open, its name and visibility follow them.
    const refresh = async () => {
      if (activeUriRef.current !== workspaceUri) return;
      const selected = activeChannelRef.current;
      const settled = selected?.workspace === workspaceUri ? refreshSelectedChannel(selected) : refreshWorkspaces();
      await settled.catch((caught) => setError(messageOf(caught)));
    };
    // The workspace space through the change feed; discovery itself every minute while no channel is open (an open channel
    // refreshes every minute on its own), since a new invitation reaches no space this account already follows.
    const stop = followLive(live, `workspace:${workspaceUri}`, [workspaceUri], refresh, setError);
    const interval = window.setInterval(() => { if (!activeChannelRef.current) void refresh(); }, 60_000);
    return () => { window.clearInterval(interval); stop(); };
  }, [activeWorkspace?.uri, live, refreshSelectedChannel, refreshWorkspaces]);

  const openChannelKey = activeChannel && activeChannel.visibility !== "transitioning" ? channelKey(activeChannel) : null;
  useEffect(() => {
    const workspace = activeChannelRef.current && parseWorkspaceUri(activeChannelRef.current.workspace);
    if (!live || !openChannelKey || !workspace || !activeChannelRef.current) return;
    // The channel's content is loaded by this watch alone: when it starts, and whenever the change feed names the channel.
    return followLive(live, openChannelKey, [channelUri(workspace.authorityDid, activeChannelRef.current.skey)], loadChannelContent, setError);
  }, [openChannelKey, activeChannel?.visibility, live, loadChannelContent]);

  async function createWorkspace(event: FormEvent) {
    event.preventDefault();
    await createWorkspaceNamed(workspaceName, { mayAuthorize: true });
  }

  async function connectInvitation(uri: string) {
    // A double-click must not start two permission requests; the guard lapses by itself so a cancelled navigation cannot stick.
    if (joiningRef.current) return;
    const ref = parsePastedWorkspaceUri(uri);
    if (!ref) { setError(`Paste a workspace URI in the form at://DID/space/${SPACE_TYPE.workspace}/key.`); return; }
    joiningRef.current = true;
    window.setTimeout(() => { joiningRef.current = false; }, 3_000);
    setError(""); setStatus("Opening the permission screen…");
    sessionStorage.setItem("spaces.pendingInvite", uri.trim());
    try { await grant("joinWorkspace", uri.trim()); }
    catch (caught) {
      sessionStorage.removeItem("spaces.pendingInvite");
      setStatus("");
      setError(messageOf(caught));
      joiningRef.current = false;
    }
  }

  function dismissInvitation() {
    sessionStorage.removeItem(INVITE_LINK_KEY);
    setInvitedTo(null);
  }

  async function beginAccept(event: FormEvent) {
    event.preventDefault();
    await connectInvitation(inviteUri);
  }

  async function runOperation(request: Record<string, unknown>, workspace = activeWorkspace?.uri, operationId = makeTid()) {
    if (!workspace) return;
    if (activeWorkspace?.uri === workspace && activeWorkspace.degradedReasons.length) {
      setError(`Workspace mutations are paused in degraded mode. ${activeWorkspace.degradedReasons.join(" ")}`);
      return;
    }
    const pending = { workspace, operationId, request };
    setPendingOperation(pending);
    sessionStorage.setItem("spaces.pendingOperatorOperation", JSON.stringify(pending));
    setBusy(true); setError(""); setStatus("Submitting workspace operation…");
    try {
      const result = await api<{ operation: { state: string; completedSteps: string[]; operationId: string; error?: string } }>("/api/operator/execute", {
        method: "POST", body: JSON.stringify(pending),
      });
      const operation = result.operation;
      setOperatorReady(true);
      setStatus(request.kind === "inviteMember" && operation.state === "completed"
        ? `Added ${String(request.subject)}. Send them an invite link (use “Copy invite link”) so they can find and join the workspace.`
        : `Operation ${operation.state}; ${operation.completedSteps.length} steps recorded.${operation.error ? ` ${operation.error}` : ""}`);
      if (operation.state === "completed" || operation.state === "failed") {
        setPendingOperation(null);
        sessionStorage.removeItem("spaces.pendingOperatorOperation");
      }
      const currentWorkspaces = await refreshWorkspaces();
      if (request.kind === "leaveChannel" && operation.state === "completed") {
        clearChannelView(); setNeedOperatorLeave(false);
        await engine?.channels.left({ workspace, skey: String(request.skey) }).catch((caught) => setError(messageOf(caught)));
      } else if (currentWorkspaces && activeChannel?.workspace === workspace) {
        followSelection(currentWorkspaces, activeChannel);
        await live?.reload(channelKey(activeChannel));
      }
      // What an operation changes for an admin: the inbox's requests and the stalled operations.
      void live?.reload(inboxKey(workspace));
      void loadStalledOperationsFor(workspace);
    } catch (caught) {
      const statusCode = httpStatus(caught);
      if (isAuthorizationRequired(caught)) {
        // The operator's grant for this workspace lapsed. Only its authority can renew it; the operation stays pending to retry.
        if (parsePastedWorkspaceUri(workspace)?.authorityDid !== did) { setError(messageOf(caught)); return; }
        setStatus("Opening the permission screen. Approve it, then retry the pending operation.");
        await grant("workspaceAuthority").catch((grantFailure) => { setStatus(""); setError(messageOf(grantFailure)); });
        return;
      }
      if (request.kind === "leaveWorkspace" || request.kind === "leaveChannel") setNeedOperatorLeave(true);
      setError(statusCode === 401 || statusCode === 403
        ? `${messageOf(caught)} If this is the first admin action, grant the operator method permission below and retry.`
        : messageOf(caught));
    } finally { setBusy(false); }
  }

  async function openChannel(channel: WorkspaceSummary["channels"][number]) {
    if (!activeWorkspace) return;
    const selected = { workspace: activeWorkspace.uri, skey: channel.skey, name: channel.name, visibility: channel.visibility };
    const reopened = activeChannelRef.current !== null && channelKey(activeChannelRef.current) === channelKey(selected)
      && activeChannelRef.current.visibility === selected.visibility;
    channelDataEpoch.current += 1;
    setDmView(null);
    selectChannel(selected); resetChannelContent(); setError("");
    if (selected.visibility === "transitioning") {
      setStatus(TRANSITIONING_STATUS);
      return;
    }
    // The channel's live watch loads it; the same channel opened again keeps its watch, which is asked to load it now.
    setAwaitingChannel(channelKey(selected));
    if (reopened) await live?.reload(channelKey(selected));
  }

  async function authorizeCurrentChannel(action: string) {
    if (!activeChannel || !activeWorkspace) return;
    sessionStorage.setItem("spaces.pendingChannel", JSON.stringify(activeChannel));
    try { await grant(action, activeWorkspace.uri, activeChannel.skey); }
    catch (caught) { sessionStorage.removeItem("spaces.pendingChannel"); setError(messageOf(caught)); }
  }

  // Messages and reactions are written by the engine to the account's own repo, with the browser session's grant; the
  // engine keeps an own write in view until the authority lists it.
  async function sendMessage(event: FormEvent) {
    event.preventDefault();
    if (!engine || !activeChannel || activeChannel.visibility === "transitioning" || !messageText.trim()) return;
    setBusy(true); setError("");
    try {
      await engine.channels.send(activeChannel, messageText, replyTo || undefined);
      setMessageText(""); setReplyTo("");
      await live?.reload(channelKey(activeChannel));
    } catch (caught) {
      setError(messageOf(caught));
      recheckChannelAfterAccessFailure(caught);
    } finally { setBusy(false); }
  }

  async function requestPrivateAccess(withdraw = false) {
    if (!activeChannel || activeChannel.visibility === "transitioning") return;
    try {
      await api("/api/channels/requests", { method: "POST", body: JSON.stringify({ workspace: activeChannel.workspace, skey: activeChannel.skey, ...(withdraw ? { action: "withdraw" } : {}) }) });
      setRequestSubmitted(!withdraw);
      setStatus(withdraw ? "Your private-channel request was withdrawn." : "Your access request is in the workspace inbox.");
      setNeedJoinWrite(false);
    } catch (caught) {
      setError(messageOf(caught));
      if (httpStatus(caught) === 401 || httpStatus(caught) === 403) setNeedJoinWrite(true);
      recheckChannelAfterAccessFailure(caught);
    }
  }

  async function leaveWorkspace() {
    if (!activeWorkspace || did === activeWorkspace.authorityDid) return;
    await runOperation({ kind: "leaveWorkspace" });
  }

  async function leaveChannel() {
    if (!activeChannel) return;
    await runOperation({ kind: "leaveChannel", skey: activeChannel.skey });
  }

  function switchWorkspace(uri: string) {
    setDmView(null);
    clearChannelView();
    // The selected workspace chosen again only returns to its home; its inbox and operator state stay.
    if (uri !== activeUriRef.current) selectWorkspace(uri);
  }

  function syncInbox() {
    if (!activeWorkspace) return;
    inboxPermissionMissingRef.current = false; setInboxPermissionMissing(false); setInboxLoaded(false);
    void live?.reload(inboxKey(activeWorkspace.uri));
  }

  return (
    <DmProvider did={did} dmConfig={dmConfig} workspaces={workspaces} activeWorkspace={activeWorkspace} view={dmView} openView={openDmView}>
    <main className="app-frame">
      <Sidebar did={did} workspaces={workspaces} workspaceCandidates={workspaceCandidates} activeUri={activeUri} activeWorkspace={activeWorkspace} activeChannel={activeChannel} switchWorkspace={switchWorkspace} openChannel={openChannel} grant={grant} setError={setError} />
      <section className="main-stage">
        <header className="topbar"><div className="breadcrumb">Your spaces <span>/</span> <strong>{activeChannel?.name ?? (dmView ? "Direct messages" : activeWorkspace?.name ?? "Overview")}</strong></div><div className="topbar-tools"><button className="help-button" onClick={() => void refreshWorkspaces().catch((caught) => setError(messageOf(caught)))}>↻ <span>Refresh</span></button><button className="top-avatar">{did.slice(-1).toUpperCase()}</button></div></header>
        <div className="overview-content">
          {error && <p className="form-error" role="alert">{error}</p>}
          {status && !(activeChannel?.visibility === "transitioning" && status === TRANSITIONING_STATUS) && <p className="status-note" role="status">{status}</p>}
          {sessionStatus !== "ready" && <div className="starter-card permission-box" role="status"><p>{sessionStatus === "connecting" ? "Connecting this browser to your account…" : "Allow this browser to read your workspaces, channels and messages, and to send your messages, with one approval on your account’s own server."}</p>{sessionError && <p className="form-error" role="alert">{sessionError}</p>}{sessionStatus !== "connecting" && <button className="text-button" onClick={connectSession}>Connect this browser →</button>}</div>}
          {activeWorkspace && activeWorkspace.degradedReasons.length > 0 && <div className="envelope-alert" role="alert"><strong>Workspace is in degraded mode.</strong><ul>{activeWorkspace.degradedReasons.map((reason) => <li key={reason}>{reason}</li>)}</ul><p>Admin changes and inbox reconciliation are paused until the workspace is within the supported v1 limits.</p></div>}
          {pendingOperation && <p className="status-note">Operation {pendingOperation.operationId} is still pending. <button className="text-button" disabled={busy || workspaceDegraded} onClick={() => void runOperation(pendingOperation.request, pendingOperation.workspace, pendingOperation.operationId)}>Retry same operation ↻</button></p>}
          {stalledOperations.length > 0 && <div className="operation-alert" role="alert"><strong>{stalledOperations.length} operation(s) have had no progress for at least five minutes.{stalledOperationsTruncated ? " Showing the oldest 100; more stalled operations exist." : ""}</strong>{stalledOperations.map((operation) => <p key={`${operation.actor}:${operation.operationId}`}>{operation.operationId} · {operation.actor} · {operation.error ?? operation.state}</p>)}</div>}
          {sessionStatus === "ready" && <>
          {!dmView && workspacesLoaded && invitedTo && !workspaces.some((workspace) => workspace.uri === invitedTo) && <InviteBanner workspace={invitedTo} busy={busy} join={() => void connectInvitation(invitedTo)} dismiss={dismissInvitation} />}
          {!dmView && !activeWorkspace && <WorkspaceOnboarding busy={busy} workspaceName={workspaceName} setWorkspaceName={setWorkspaceName} inviteUri={inviteUri} setInviteUri={setInviteUri} createWorkspace={createWorkspace} beginAccept={beginAccept} />}
          {!dmView && activeWorkspace && (!activeChannel || activeChannel.workspace !== activeUri) && <WorkspaceHome did={did} activeWorkspace={activeWorkspace} busy={busy} workspaceDegraded={workspaceDegraded} needOperatorLeave={needOperatorLeave} inbox={inbox} inboxLoaded={inboxLoaded} inboxPermissionMissing={inboxPermissionMissing} runOperation={runOperation} grant={grant} leaveWorkspace={leaveWorkspace} syncInbox={syncInbox} setStatus={setStatus} setError={setError} />}
          {!dmView && activeChannel?.workspace === activeUri && <ChannelView did={did} activeChannel={activeChannel} activeWorkspace={activeWorkspace} busy={busy} workspaceDegraded={workspaceDegraded} needOperatorLeave={needOperatorLeave} needJoinWrite={needJoinWrite} requestSubmitted={requestSubmitted} privateRoster={privateRoster} reading={channelReading || (activeChannel !== null && awaitingChannel === channelKey(activeChannel))} messages={messages} hasMore={hasMore} nextCursor={nextCursor} messageText={messageText} setMessageText={setMessageText} replyTo={replyTo} setReplyTo={setReplyTo} loadMessages={loadMessages} runOperation={runOperation} grant={grant} leaveChannel={leaveChannel} requestPrivateAccess={requestPrivateAccess} authorizeCurrentChannel={authorizeCurrentChannel} sendMessage={sendMessage} toggleReaction={toggleReaction} editMessage={editMessage} deleteMessage={deleteMessage} setError={setError} />}
          {dmView && <DmStage />}
          </>}
          <div className="data-note"><span className="note-icon">◈</span><span><strong>Your conversations belong to you.</strong><small>Records remain in their authors’ AT Protocol accounts. Workspace access is enforced by PDS member lists.</small></span><a href="https://atproto.com" target="_blank" rel="noreferrer">How it works ↗</a></div>
        </div>
      </section>
    </main>
    </DmProvider>
  );

  async function toggleReaction(subject: string, emoji: string, active: boolean) {
    if (!engine || !activeChannel || activeChannel.visibility === "transitioning") return;
    try {
      if (active) await engine.channels.unreact(activeChannel, subject, emoji);
      else await engine.channels.react(activeChannel, subject, emoji);
      await live?.reload(channelKey(activeChannel));
    } catch (caught) { setError(messageOf(caught)); recheckChannelAfterAccessFailure(caught); }
  }

  async function editMessage(message: Message) {
    if (!activeChannel || activeChannel.visibility === "transitioning") return;
    const text = window.prompt("Edit message", message.value.text ?? "");
    if (text === null) return;
    if (!engine) return;
    try {
      await engine.channels.edit(activeChannel, message.uri, text);
      await live?.reload(channelKey(activeChannel));
    } catch (caught) { setError(messageOf(caught)); recheckChannelAfterAccessFailure(caught); }
  }

  async function deleteMessage(uri: string) {
    if (!activeChannel || activeChannel.visibility === "transitioning" || !window.confirm("Delete this message from your repo?")) return;
    if (!engine) return;
    try {
      await engine.channels.delete(activeChannel, uri);
      await live?.reload(channelKey(activeChannel));
    } catch (caught) { setError(messageOf(caught)); recheckChannelAfterAccessFailure(caught); }
  }

}

