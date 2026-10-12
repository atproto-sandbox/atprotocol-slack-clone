"use client";

import dynamic from "next/dynamic";
import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChannelView } from "./channel-view";
import { api, captureInviteLink, httpStatus, INVITE_LINK_KEY, isAccessFailure, isAuthorizationRequired, makeTid, WORKSPACE_OPERATION_KEY, workspaceOperationIdFor, mergeMessages, messageOf, parseWorkspaceUri, TRANSITIONING_STATUS, withReactions, type ChannelSelection, type InboxRequest, type Message, type PendingOperation, type Reaction, type StalledOperation } from "./client-api";
import { DmProvider, type DmView } from "./dm-context";
import { InviteBanner } from "./invite-banner";
import { Sidebar } from "./sidebar";
import { WorkspaceHome } from "./workspace-home";
import { WorkspaceOnboarding } from "./workspace-onboarding";
import type { DmConfig } from "@/dm/browser-session";
import type { WorkspaceCandidate, WorkspaceSummary } from "@/workspaces/read-model";

// The DM stage renders only client-side; see the note in sidebar.tsx.
const DmStage = dynamic(() => import("./dm-stage").then((mod) => mod.DmStage), { ssr: false });

type RefreshSelectedChannel = (selected: ChannelSelection, reloadContent?: boolean) => Promise<void>;

export function WorkspaceManager({ did, dmConfig }: { did: string; dmConfig: DmConfig }) {
  const [workspaces, setWorkspaces] = useState<WorkspaceSummary[]>([]);
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
  const [nextOffset, setNextOffset] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [needChannelRead, setNeedChannelRead] = useState(false);
  const [needChannelWrite, setNeedChannelWrite] = useState(false);
  const [needJoinWrite, setNeedJoinWrite] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const channelDataEpoch = useRef(0);
  const operatorDataEpoch = useRef(0);
  const workspaceRefreshEpoch = useRef(0);
  const activeUriRef = useRef(activeUri);
  const activeChannelRef = useRef<ChannelSelection | null>(null);
  const refreshSelectedChannelRef = useRef<RefreshSelectedChannel | null>(null);
  const inboxPermissionMissingRef = useRef(false);
  const inboxRequestInFlightRef = useRef(false);
  const joiningRef = useRef(false);

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

  const resetChannelContent = useCallback(() => {
    setMessages([]); setPrivateRoster([]); setHasMore(false); setNextOffset(0); setReplyTo(""); setMessageText("");
    setNeedChannelRead(false); setNeedChannelWrite(false); setNeedJoinWrite(false); setRequestSubmitted(false);
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
    resetChannelContent();
    setNeedChannelRead(statusCode === 401 || statusCode === 403);
    const selected = activeChannelRef.current;
    if (selected) void refreshSelectedChannelRef.current?.(selected, false).catch((error) => setError(messageOf(error)));
    return true;
  }, [resetChannelContent]);

  const refreshWorkspaces = useCallback(async () => {
    const requestEpoch = ++workspaceRefreshEpoch.current;
    operatorDataEpoch.current += 1;
    try {
      const result = await api<{ workspaces: WorkspaceSummary[]; candidates: WorkspaceCandidate[] }>("/api/workspaces");
      if (workspaceRefreshEpoch.current !== requestEpoch) return null;
      setWorkspaceCandidates(result.candidates);
      const current = activeUriRef.current;
      const selectedStillExists = current !== "" && result.workspaces.some((workspace) => workspace.uri === current);
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
        if (!result.workspaces.find((workspace) => workspace.uri === current)?.isAdmin) {
          setInbox([]);
          setStalledOperations([]);
        }
      }
      return result.workspaces;
    } catch (caught) {
      if (workspaceRefreshEpoch.current !== requestEpoch) return null;
      setWorkspaces([]);
      setWorkspaceCandidates([]);
      selectWorkspace("");
      clearChannelView();
      setInbox([]); setStalledOperations([]);
      throw caught;
    }
  }, [clearChannelView, resetChannelContent, selectChannel, selectWorkspace]);

  const loadMessages = useCallback(async (channel: ChannelSelection, offset = 0, append = false) => {
    const selectedChannel = activeChannelRef.current;
    if (!selectedChannel || selectedChannel.workspace !== channel.workspace || selectedChannel.skey !== channel.skey) return false;
    const requestEpoch = channelDataEpoch.current;
    const query = new URLSearchParams({ workspace: channel.workspace, skey: channel.skey, offset: String(offset) });
    let result: { messages: Array<Omit<Message, "reactions">>; reactions: Reaction[]; nextOffset: number; hasMore: boolean; degraded: boolean; degradedReasons?: string[] };
    try {
      result = await api(`/api/channels/messages?${query}`);
    } catch (caught) {
      if (channelDataEpoch.current === requestEpoch) handleChannelReadFailure(caught);
      throw caught;
    }
    if (channelDataEpoch.current !== requestEpoch) return false;
    const messages = withReactions(result.messages, result.reactions, did);
    setMessages((current) => mergeMessages(current, messages, append));
    setNextOffset(result.nextOffset);
    setHasMore(result.hasMore);
    setNeedChannelRead(false);
    if (result.degraded) setStatus(`${(result.degradedReasons ?? ["Channel history exceeded its sync limit."]).join(" ")} Older records need operator review.`);
    else setStatus("");
    return true;
  }, [did, handleChannelReadFailure]);

  const refreshPrivateRoster = useCallback(async (channel: ChannelSelection) => {
    const selectedChannel = activeChannelRef.current;
    if (!selectedChannel || selectedChannel.workspace !== channel.workspace || selectedChannel.skey !== channel.skey) return;
    const requestEpoch = channelDataEpoch.current;
    const query = new URLSearchParams({ workspace: channel.workspace, skey: channel.skey });
    let result: { members: string[] };
    try {
      result = await api(`/api/channels/roster?${query}`);
    } catch (caught) {
      if (channelDataEpoch.current === requestEpoch) handleChannelReadFailure(caught);
      throw caught;
    }
    if (channelDataEpoch.current !== requestEpoch) return;
    setPrivateRoster(result.members);
  }, [handleChannelReadFailure]);

  const refreshSelectedChannel = useCallback(async (requested: ChannelSelection, reloadContent = true) => {
    const selected = activeChannelRef.current;
    if (!selected || selected.workspace !== requested.workspace || selected.skey !== requested.skey || activeUriRef.current !== requested.workspace) return;
    const current = await refreshWorkspaces();
    if (!current) return;
    const latest = activeChannelRef.current;
    if (!latest || latest.workspace !== requested.workspace || latest.skey !== requested.skey || activeUriRef.current !== requested.workspace) return;
    const workspace = current.find((entry) => entry.uri === requested.workspace);
    const channel = workspace?.channels.find((entry) => entry.skey === requested.skey);
    if (!channel) { clearChannelView(); return; }
    const selection = { workspace: requested.workspace, skey: channel.skey, name: channel.name, visibility: channel.visibility };
    if (latest.name !== selection.name || latest.visibility !== selection.visibility) selectChannel(selection);
    const currentSelection = latest.name === selection.name && latest.visibility === selection.visibility ? latest : selection;
    channelDataEpoch.current += 1;
    if (channel.visibility === "transitioning") {
      resetChannelContent();
      setStatus(TRANSITIONING_STATUS);
      return;
    }
    if (!reloadContent) return;
    if (channel.visibility !== "private") setPrivateRoster([]);
    void loadMessages(currentSelection).catch((caught) => {
      if (!isAccessFailure(caught)) setError(messageOf(caught));
    });
    if (channel.visibility === "private") void refreshPrivateRoster(currentSelection).catch((caught) => {
      if (!isAccessFailure(caught)) setError(messageOf(caught));
    });
  }, [clearChannelView, loadMessages, refreshPrivateRoster, refreshWorkspaces, resetChannelContent, selectChannel]);
  useEffect(() => { refreshSelectedChannelRef.current = refreshSelectedChannel; }, [refreshSelectedChannel]);

  const recheckChannelAfterAccessFailure = useCallback((caught: unknown) => {
    if (!isAccessFailure(caught)) return;
    const selected = activeChannelRef.current;
    if (selected) void refreshSelectedChannel(selected, false).catch((error) => setError(messageOf(error)));
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

  const grant = useCallback(async (action: string, workspaceUri?: string, skey?: string) => {
    const ref = workspaceUri ? parseWorkspaceUri(workspaceUri) : null;
    const response = await api<{ redirectUrl: string }>("/api/oauth/permission", {
      method: "POST",
      body: JSON.stringify({ action, workspaceDid: ref?.authorityDid ?? did, ...(ref ? { workspaceSkey: ref.skey } : {}), ...(skey ? { skey } : {}) }),
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
        await grant("workspaceAuthority");
        redirecting = true;
      } catch (grantFailure) {
        sessionStorage.removeItem("spaces.pendingWorkspaceName");
        sessionStorage.removeItem("spaces.autoCreateWorkspace");
        setStatus("");
        setError(messageOf(grantFailure));
      }
    } finally { if (!redirecting) setBusy(false); }
  }, [clearChannelView, grant, refreshWorkspaces, selectWorkspace]);

  const loadInbox = useCallback(async () => {
    if (!activeWorkspace || activeWorkspace.degradedReasons.length || inboxPermissionMissingRef.current || inboxRequestInFlightRef.current) return;
    const workspaceUri = activeWorkspace.uri;
    const requestEpoch = operatorDataEpoch.current;
    inboxRequestInFlightRef.current = true;
    try {
      const result = await api<{ requests: InboxRequest[] }>(`/api/inbox/requests?workspace=${encodeURIComponent(workspaceUri)}`);
      if (operatorDataEpoch.current !== requestEpoch || activeUriRef.current !== workspaceUri) return;
      setInbox(result.requests);
      setInboxLoaded(true);
      setInboxPermissionMissing(false);
      inboxPermissionMissingRef.current = false;
      setError("");
    } catch (caught) {
      if (operatorDataEpoch.current !== requestEpoch || activeUriRef.current !== workspaceUri) return;
      setInbox([]);
      setInboxLoaded(false);
      if (httpStatus(caught) === 401 || httpStatus(caught) === 403) {
        setInboxPermissionMissing(true);
        inboxPermissionMissingRef.current = true;
        setError("");
        return;
      }
      setError(messageOf(caught));
    } finally {
      inboxRequestInFlightRef.current = false;
    }
  }, [activeWorkspace]);

  const loadStalledOperations = useCallback(async () => {
    if (!activeWorkspace?.isAdmin) return;
    const workspaceUri = activeWorkspace.uri;
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
  }, [activeWorkspace]);

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
    const timer = window.setTimeout(() => {
      void refreshWorkspaces().catch((caught) => setError(messageOf(caught)));
      const invitedWorkspace = captureInviteLink(window.location.search, sessionStorage) ?? sessionStorage.getItem(INVITE_LINK_KEY);
      if (invitedWorkspace) { setInvitedTo(invitedWorkspace); setInviteUri(invitedWorkspace); }
      if (window.location.search.includes("invite=")) window.history.replaceState(null, "", window.location.pathname);
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
          if (channel.visibility !== "transitioning") {
            void loadMessages(channel).catch((caught) => setError(messageOf(caught)));
            if (channel.visibility === "private") void refreshPrivateRoster(channel).catch((caught) => { if (!isAccessFailure(caught)) setError(messageOf(caught)); });
          }
        } catch { setError("Could not restore the channel selection."); }
      }
    }, 0);
    return () => window.clearTimeout(timer);
  }, [acceptWorkspace, createWorkspaceNamed, loadMessages, refreshPrivateRoster, refreshWorkspaces, selectChannel, selectWorkspace]);

  useEffect(() => {
    if (!activeChannel) return;
    const timer = window.setInterval(() => {
      void refreshSelectedChannel(activeChannel).catch((caught) => setError(messageOf(caught)));
    }, 60_000);
    return () => window.clearInterval(timer);
  }, [activeChannel, refreshSelectedChannel]);

  useEffect(() => {
    if (!activeWorkspace?.isAdmin) return;
    const timer = window.setTimeout(() => { void loadInbox(); void loadStalledOperations(); }, 0);
    const interval = window.setInterval(() => { void loadInbox(); void loadStalledOperations(); }, 60_000);
    const query = new URLSearchParams({ workspace: activeWorkspace.uri, inbox: "1", after: "0" });
    const events = new EventSource(`/api/notifications?${query}`);
    events.addEventListener("change", () => void loadInbox());
    events.addEventListener("error", () => { if (events.readyState === EventSource.CLOSED) void loadInbox(); });
    return () => { window.clearTimeout(timer); window.clearInterval(interval); events.close(); };
  }, [activeWorkspace?.uri, activeWorkspace?.isAdmin, loadInbox, loadStalledOperations]);

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
    if (!activeChannel) {
      if (!activeWorkspace?.uri) return;
      const workspaceUri = activeWorkspace.uri;
      const query = new URLSearchParams({ workspace: workspaceUri, after: "0" });
      const events = new EventSource(`/api/notifications?${query}`);
      const refresh = () => {
        if (activeUriRef.current !== workspaceUri) return;
        void refreshWorkspaces().catch((caught) => setError(messageOf(caught)));
      };
      events.addEventListener("change", refresh);
      events.addEventListener("error", () => { if (events.readyState === EventSource.CLOSED) refresh(); });
      const interval = window.setInterval(refresh, 60_000);
      return () => { window.clearInterval(interval); events.close(); };
    }
    const workspaceQuery = new URLSearchParams({ workspace: activeChannel.workspace, after: "0" });
    const channelQuery = new URLSearchParams({ workspace: activeChannel.workspace, skey: activeChannel.skey, after: "0" });
    const channelEvents = activeChannel.visibility === "transitioning" ? null : new EventSource(`/api/notifications?${channelQuery}`);
    const workspaceEvents = new EventSource(`/api/notifications?${workspaceQuery}`);
    const refresh = () => {
      void refreshSelectedChannel(activeChannel).catch((caught) => setError(messageOf(caught)));
    };
    const refreshWhenClosed = (source: EventSource) => () => { if (source.readyState === EventSource.CLOSED) refresh(); };
    channelEvents?.addEventListener("change", refresh);
    if (channelEvents) channelEvents.addEventListener("error", refreshWhenClosed(channelEvents));
    workspaceEvents.addEventListener("change", refresh);
    workspaceEvents.addEventListener("error", refreshWhenClosed(workspaceEvents));
    return () => { channelEvents?.close(); workspaceEvents.close(); };
  }, [activeChannel, activeWorkspace?.uri, refreshSelectedChannel, refreshWorkspaces]);

  async function createWorkspace(event: FormEvent) {
    event.preventDefault();
    await createWorkspaceNamed(workspaceName, { mayAuthorize: true });
  }

  async function connectInvitation(uri: string) {
    // A double-click must not start two permission requests; the guard lapses by itself so a cancelled navigation cannot stick.
    if (joiningRef.current) return;
    const ref = parseWorkspaceUri(uri);
    if (!ref) { setError("Paste a workspace URI in the form at://DID/space/org.slack.workspace/key."); return; }
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
      const refreshedWorkspace = currentWorkspaces?.find((entry) => entry.uri === workspace);
      if (request.kind === "leaveChannel" && operation.state === "completed") {
        clearChannelView(); setNeedOperatorLeave(false);
      } else if (currentWorkspaces && activeChannel?.workspace === workspace) {
        const selectionEpoch = ++channelDataEpoch.current;
        const refreshedChannel = refreshedWorkspace?.channels.find((entry) => entry.skey === activeChannel.skey);
        if (!refreshedChannel) {
          clearChannelView();
        }
        else {
          const selection = { workspace, skey: refreshedChannel.skey, name: refreshedChannel.name, visibility: refreshedChannel.visibility };
          selectChannel(selection);
          if (refreshedChannel.visibility === "transitioning") {
            resetChannelContent();
            setStatus(TRANSITIONING_STATUS);
          } else {
            if (refreshedChannel.visibility === "private") {
              await refreshPrivateRoster(selection).catch((caught) => {
                if (!isAccessFailure(caught)) setError(messageOf(caught));
              });
            } else setPrivateRoster([]);
            if (channelDataEpoch.current !== selectionEpoch) return;
            await loadMessages(selection).catch((caught) => {
              if (!isAccessFailure(caught)) setError(messageOf(caught));
            });
          }
        }
      }
    } catch (caught) {
      const statusCode = httpStatus(caught);
      if (request.kind === "leaveWorkspace" || request.kind === "leaveChannel") setNeedOperatorLeave(true);
      setError(statusCode === 401 || statusCode === 403
        ? `${messageOf(caught)} If this is the first admin action, grant the operator method permission below and retry.`
        : messageOf(caught));
    } finally { setBusy(false); }
  }

  async function openChannel(channel: WorkspaceSummary["channels"][number]) {
    if (!activeWorkspace) return;
    const selected = { workspace: activeWorkspace.uri, skey: channel.skey, name: channel.name, visibility: channel.visibility };
    channelDataEpoch.current += 1;
    setDmView(null);
    selectChannel(selected); resetChannelContent(); setError("");
    try {
      if (selected.visibility === "transitioning") {
        setStatus(TRANSITIONING_STATUS);
        return;
      }
      if (!await loadMessages(selected)) return;
      if (selected.visibility === "private") await refreshPrivateRoster(selected);
    }
    catch (caught) {
      setError(messageOf(caught));
      if (httpStatus(caught) === 403 || httpStatus(caught) === 401) setNeedChannelRead(true);
    }
  }

  async function authorizeCurrentChannel(action: string) {
    if (!activeChannel || !activeWorkspace) return;
    sessionStorage.setItem("spaces.pendingChannel", JSON.stringify(activeChannel));
    try { await grant(action, activeWorkspace.uri, activeChannel.skey); }
    catch (caught) { sessionStorage.removeItem("spaces.pendingChannel"); setError(messageOf(caught)); }
  }

  async function sendMessage(event: FormEvent) {
    event.preventDefault();
    if (!activeChannel || activeChannel.visibility === "transitioning" || !messageText.trim()) return;
    setBusy(true); setError("");
    try {
      await api("/api/channels/messages/write", { method: "POST", body: JSON.stringify({
        workspace: activeChannel.workspace, skey: activeChannel.skey, action: "create", text: messageText, ...(replyTo ? { parent: replyTo } : {}),
      }) });
      setMessageText(""); setReplyTo("");
      await loadMessages(activeChannel);
    } catch (caught) {
      setError(messageOf(caught));
      if (httpStatus(caught) === 401 || httpStatus(caught) === 403) setNeedChannelWrite(true);
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
    selectWorkspace(uri); clearChannelView(); setInbox([]); setStalledOperations([]);
  }

  function syncInbox() {
    inboxPermissionMissingRef.current = false; setInboxPermissionMissing(false); setInboxLoaded(false); void loadInbox();
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
          {activeWorkspace && activeWorkspace.degradedReasons.length > 0 && <div className="envelope-alert" role="alert"><strong>Workspace is in degraded mode.</strong><ul>{activeWorkspace.degradedReasons.map((reason) => <li key={reason}>{reason}</li>)}</ul><p>Admin changes and inbox reconciliation are paused until the workspace is within the supported v1 limits.</p></div>}
          {pendingOperation && <p className="status-note">Operation {pendingOperation.operationId} is still pending. <button className="text-button" disabled={busy || workspaceDegraded} onClick={() => void runOperation(pendingOperation.request, pendingOperation.workspace, pendingOperation.operationId)}>Retry same operation ↻</button></p>}
          {stalledOperations.length > 0 && <div className="operation-alert" role="alert"><strong>{stalledOperations.length} operation(s) have had no progress for at least five minutes.{stalledOperationsTruncated ? " Showing the oldest 100; more stalled operations exist." : ""}</strong>{stalledOperations.map((operation) => <p key={`${operation.actor}:${operation.operationId}`}>{operation.operationId} · {operation.actor} · {operation.error ?? operation.state}</p>)}</div>}
          {!dmView && workspacesLoaded && invitedTo && !workspaces.some((workspace) => workspace.uri === invitedTo) && <InviteBanner workspace={invitedTo} busy={busy} join={() => void connectInvitation(invitedTo)} dismiss={dismissInvitation} />}
          {!dmView && !activeWorkspace && <WorkspaceOnboarding busy={busy} workspaceName={workspaceName} setWorkspaceName={setWorkspaceName} inviteUri={inviteUri} setInviteUri={setInviteUri} createWorkspace={createWorkspace} beginAccept={beginAccept} />}
          {!dmView && activeWorkspace && (!activeChannel || activeChannel.workspace !== activeUri) && <WorkspaceHome did={did} activeWorkspace={activeWorkspace} busy={busy} workspaceDegraded={workspaceDegraded} needOperatorLeave={needOperatorLeave} inbox={inbox} inboxLoaded={inboxLoaded} inboxPermissionMissing={inboxPermissionMissing} runOperation={runOperation} grant={grant} leaveWorkspace={leaveWorkspace} syncInbox={syncInbox} setStatus={setStatus} setError={setError} />}
          {!dmView && activeChannel?.workspace === activeUri && <ChannelView did={did} activeChannel={activeChannel} activeWorkspace={activeWorkspace} busy={busy} workspaceDegraded={workspaceDegraded} needOperatorLeave={needOperatorLeave} needChannelRead={needChannelRead} needChannelWrite={needChannelWrite} needJoinWrite={needJoinWrite} requestSubmitted={requestSubmitted} privateRoster={privateRoster} messages={messages} hasMore={hasMore} nextOffset={nextOffset} messageText={messageText} setMessageText={setMessageText} replyTo={replyTo} setReplyTo={setReplyTo} loadMessages={loadMessages} runOperation={runOperation} grant={grant} leaveChannel={leaveChannel} requestPrivateAccess={requestPrivateAccess} authorizeCurrentChannel={authorizeCurrentChannel} sendMessage={sendMessage} toggleReaction={toggleReaction} editMessage={editMessage} deleteMessage={deleteMessage} setError={setError} />}
          {dmView && <DmStage />}
          <div className="data-note"><span className="note-icon">◈</span><span><strong>Your conversations belong to you.</strong><small>Records remain in their authors’ AT Protocol accounts. Workspace access is enforced by PDS member lists.</small></span><a href="https://atproto.com" target="_blank" rel="noreferrer">How it works ↗</a></div>
        </div>
      </section>
    </main>
    </DmProvider>
  );

  async function toggleReaction(subject: string, emoji: string, active: boolean) {
    if (!activeChannel || activeChannel.visibility === "transitioning") return;
    try {
      await api("/api/channels/reactions", { method: "POST", body: JSON.stringify({ workspace: activeChannel.workspace, skey: activeChannel.skey, subject, emoji, active: !active }) });
      await loadMessages(activeChannel);
    } catch (caught) { setError(messageOf(caught)); if (httpStatus(caught) === 403) setNeedChannelWrite(true); recheckChannelAfterAccessFailure(caught); }
  }

  async function editMessage(message: Message) {
    if (!activeChannel || activeChannel.visibility === "transitioning") return;
    const text = window.prompt("Edit message", message.value.text ?? "");
    if (text === null) return;
    try {
      await api("/api/channels/messages/write", { method: "POST", body: JSON.stringify({ workspace: activeChannel.workspace, skey: activeChannel.skey, action: "edit", uri: message.uri, text }) });
      await loadMessages(activeChannel);
    } catch (caught) { setError(messageOf(caught)); if (httpStatus(caught) === 403) setNeedChannelWrite(true); recheckChannelAfterAccessFailure(caught); }
  }

  async function deleteMessage(uri: string) {
    if (!activeChannel || activeChannel.visibility === "transitioning" || !window.confirm("Delete this message from your repo?")) return;
    try {
      await api("/api/channels/messages/write", { method: "POST", body: JSON.stringify({ workspace: activeChannel.workspace, skey: activeChannel.skey, action: "delete", uri }) });
      await loadMessages(activeChannel);
    } catch (caught) { setError(messageOf(caught)); recheckChannelAfterAccessFailure(caught); }
  }

}

