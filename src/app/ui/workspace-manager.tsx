"use client";

import dynamic from "next/dynamic";
import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChannelView } from "./channel-view";
import { acceptFailure } from "@/client/accept-errors";
import { captureInviteLink, INVITE_LINK_KEY, isAccessFailure, makeTid, needsAuthorityApproval, WORKSPACE_OPERATION_KEY, workspaceOperationIdFor, messageOf, parsePastedWorkspaceUri, type Message, type PendingOperation } from "./client-api";
import { DmProvider, type DmView } from "./dm-context";
import { InviteBanner } from "./invite-banner";
import { SessionProvider, useBrowserSessionContext } from "./session-context";
import { Sidebar } from "./sidebar";
import { WorkspaceHome } from "./workspace-home";
import { WorkspaceOnboarding } from "./workspace-onboarding";
import { channelKey, useChannelContent } from "./use-channel-content";
import { useAdminViews } from "./use-admin-views";
import { useDiscovery } from "./use-discovery";
import { shownChannel, type ChosenChannel } from "./selection";
import type { BrowserSessionConfig } from "@/browser/session";
import { SPACE_TYPE } from "@/protocol/nsids";
import type { WorkspaceDiscovery } from "@/client/workspace-client";
import type { WorkspaceSummary } from "@/protocol/workspace-summary";

// The DM stage renders only client-side; see the note in sidebar.tsx.
const DmStage = dynamic(() => import("./dm-stage").then((mod) => mod.DmStage), { ssr: false });

/** The signed-in account's app: its browser session restored once, and the workspace, channel and DM views on top of it. */
export function WorkspaceManager({ did, dmConfig }: { did: string; dmConfig: BrowserSessionConfig }) {
  return (
    <SessionProvider did={did} config={dmConfig}>
      <WorkspaceShell did={did} dmConfig={dmConfig} />
    </SessionProvider>
  );
}

function WorkspaceShell({ did, dmConfig }: { did: string; dmConfig: BrowserSessionConfig }) {
  // Sign-in, reads, writes and operator calls all go through the browser session and its engine; the server holds no member
  // session.
  const session = useBrowserSessionContext();
  const { engine, live, status: sessionStatus, error: sessionError, connect: connectSession } = session;
  /** The workspace and channel a person chose; what is shown follows the workspaces as last discovered. */
  const [chosenWorkspace, setChosenWorkspace] = useState<string | null>(null);
  const [chosenChannel, setChosenChannel] = useState<ChosenChannel | null>(null);
  const [dmView, setDmView] = useState<DmView | null>(null);
  const [workspaceName, setWorkspaceName] = useState("");
  const [inviteUri, setInviteUri] = useState("");
  const [invitedTo, setInvitedTo] = useState<string | null>(null);
  const [messageText, setMessageText] = useState("");
  const [replyTo, setReplyTo] = useState("");
  const [requestSubmitted, setRequestSubmitted] = useState(false);
  const [pendingOperation, setPendingOperation] = useState<PendingOperation | null>(null);
  /** An operation went through in this page, so the admin's app keeps the workspace reconciled from then on. */
  const [operatorReady, setOperatorReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const resumedRef = useRef(false);

  // Already a member: the invitation has been used, so it is no longer offered.
  const listed = useCallback((discovery: WorkspaceDiscovery) => {
    const waiting = sessionStorage.getItem(INVITE_LINK_KEY);
    if (!waiting || !discovery.workspaces.some((workspace) => workspace.uri === waiting)) return;
    sessionStorage.removeItem(INVITE_LINK_KEY);
    setInvitedTo((current) => current === waiting ? null : current);
  }, []);
  const { discovery: discovered, workspace: activeWorkspace, reload: refreshWorkspaces } = useDiscovery(session, chosenWorkspace, listed);
  const workspaces = useMemo(() => discovered.value?.workspaces ?? [], [discovered.value]);
  const workspaceCandidates = discovered.value?.candidates ?? [];
  const workspacesLoaded = discovered.value !== undefined;
  const activeUri = activeWorkspace?.uri ?? "";
  const activeChannel = useMemo(() => shownChannel(activeWorkspace, chosenChannel), [activeWorkspace, chosenChannel]);
  const workspaceDegraded = Boolean(activeWorkspace?.degradedReasons.length);
  // The workspace shown stays shown: one discovery fell back to becomes the choice, so a later discovery never moves the view.
  if (activeWorkspace && activeWorkspace.uri !== chosenWorkspace) setChosenWorkspace(activeWorkspace.uri);

  /** Empties what a person was typing in the open channel, and whether they had asked to join it. */
  const resetChannelInput = useCallback(() => {
    setReplyTo(""); setMessageText(""); setRequestSubmitted(false);
  }, []);

  const clearChannelView = useCallback(() => {
    setChosenChannel(null);
    resetChannelInput();
  }, [resetChannelInput]);

  // A channel gone from the directory, or from a workspace no longer shown, closes with what was typed in it.
  if (chosenChannel && workspacesLoaded && !activeChannel) clearChannelView();

  const openDmView = useCallback((view: DmView | null) => {
    setDmView(view);
    if (view) clearChannelView();
  }, [clearChannelView]);

  const openContent = useChannelContent(session, did, activeChannel);
  const contentRefused = openContent.content.value?.refused !== undefined;

  /** A write the account was refused (removed, the channel archived or paused) has the selection follow the workspace now. */
  const rediscoverAfterAccessFailure = useCallback((caught: unknown) => {
    if (isAccessFailure(caught)) void refreshWorkspaces().catch((error) => setError(messageOf(error)));
  }, [refreshWorkspaces]);

  /** Joins a workspace the account was added to: the browser writes the acceptance record to its own repo. */
  const acceptWorkspace = useCallback(async (workspace: string) => {
    if (!engine) return;
    setBusy(true);
    setError("");
    try {
      await engine.workspaces.accept(workspace);
      setStatus("Workspace invitation accepted. Loading shared records…");
      const current = await refreshWorkspaces();
      if (!current?.workspaces.some((entry) => entry.uri === workspace)) {
        setStatus("");
        setError("You accepted the invitation, but the workspace isn't available to you yet. Use Refresh in a moment, and ask an admin to check that your account was added.");
        return;
      }
      setChosenWorkspace(workspace); clearChannelView();
      setInviteUri("");
      setInvitedTo((current) => current === workspace ? null : current);
      if (sessionStorage.getItem(INVITE_LINK_KEY) === workspace) sessionStorage.removeItem(INVITE_LINK_KEY);
    } catch (caught) {
      setError(acceptFailure(caught)?.error ?? messageOf(caught));
    } finally {
      setBusy(false);
    }
  }, [engine, clearChannelView, refreshWorkspaces]);

  /** Sends the workspace authority to approve the operator's grant: for a workspace it is creating, or again for its own. */
  const approveAuthority = useCallback(async (input: { purpose: "createWorkspace"; name: string } | { purpose: "reauthorize" }) => {
    if (!engine?.operator) throw new Error("Connect this browser first.");
    const { url } = await engine.operator.startAuthorityFlow(input);
    window.location.assign(url);
  }, [engine]);

  // The first workspace needs the authority's grant. The operator says so with a typed answer,
  // and this approves, returns, and resumes the same journaled operation once. The resumed
  // attempt must not redirect again, so an approval that did not take shows an error instead
  // of looping.
  const createWorkspaceNamed = useCallback(async (name: string, options: { mayAuthorize: boolean }) => {
    let redirecting = false;
    setBusy(true); setError(""); setStatus("Creating protocol spaces and authority records…");
    try {
      const operationId = workspaceOperationIdFor(name, sessionStorage.getItem(WORKSPACE_OPERATION_KEY));
      sessionStorage.setItem(WORKSPACE_OPERATION_KEY, JSON.stringify({ name, operationId }));
      if (!engine?.operator) throw new Error("Connect this browser first.");
      const result = await engine.operator.createWorkspace({ name, operationId });
      const current = await refreshWorkspaces();
      if (current?.workspaces.some((entry) => entry.uri === result.workspace)) {
        setChosenWorkspace(result.workspace); clearChannelView();
      }
      if (result.state === "completed") {
        sessionStorage.removeItem(WORKSPACE_OPERATION_KEY);
        setStatus("Workspace created on AT Protocol.");
      } else setStatus(`Setup is pending after ${result.completedSteps.length} steps.${result.error ? ` ${result.error}` : ""} Retry to resume.`);
    } catch (caught) {
      setStatus("");
      if (!needsAuthorityApproval(caught)) { setError(messageOf(caught)); return; }
      if (!options.mayAuthorize) {
        setError("Permission was not granted, so the workspace could not be created. Try again and approve every requested permission.");
        return;
      }
      setStatus("Opening the permission screen. Approve it to finish creating your workspace…");
      sessionStorage.setItem("spaces.pendingWorkspaceName", name);
      sessionStorage.setItem("spaces.autoCreateWorkspace", "1");
      try {
        await approveAuthority({ purpose: "createWorkspace", name });
        redirecting = true;
      } catch (grantFailure) {
        sessionStorage.removeItem("spaces.pendingWorkspaceName");
        sessionStorage.removeItem("spaces.autoCreateWorkspace");
        setStatus("");
        setError(messageOf(grantFailure));
      }
    } finally { if (!redirecting) setBusy(false); }
  }, [engine, approveAuthority, clearChannelView, refreshWorkspaces]);

  useEffect(() => {
    // Back from the permission screen restores this page as it was left. The resume flags must not
    // survive to auto-run later, and the form must be usable again.
    const onPageShow = (event: PageTransitionEvent) => {
      if (!event.persisted) return;
      sessionStorage.removeItem("spaces.autoCreateWorkspace");
      sessionStorage.removeItem("spaces.pendingWorkspaceName");
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
    }, 0);
    return () => window.clearTimeout(timer);
  }, [engine, createWorkspaceNamed]);

  const admin = useAdminViews(session, activeWorkspace);
  const inboxView = admin.inbox.value;
  const stalledWork = admin.stalled.value;
  // A view that failed to load in the background (the change feed's or the minute's) is shown like any other failure.
  const backgroundFailure = [discovered.error, admin.inbox.error, admin.stalled.error].find((failure) => failure !== undefined);
  const shownError = error || (backgroundFailure === undefined ? "" : messageOf(backgroundFailure));

  useEffect(() => {
    const operator = engine?.operator;
    if (!activeWorkspace?.isAdmin || activeWorkspace.degradedReasons.length || !operator || !operatorReady) return;
    const workspace = activeWorkspace.uri;
    // Once an operation went through, an admin's app asks the operator to reconcile the member lists now and every five minutes.
    const reconcile = () => {
      void operator.execute({ workspace, operationId: makeTid(), request: { kind: "reconcileWorkspace" } }).then(({ operation }) => {
        if (operation.state !== "completed") setStatus(`Workspace reconciliation is ${operation.state}.${operation.error ? ` ${operation.error}` : ""}`);
      }).catch((caught) => setError(messageOf(caught)));
    };
    const timer = window.setTimeout(reconcile, 0);
    const interval = window.setInterval(reconcile, 300_000);
    return () => { window.clearTimeout(timer); window.clearInterval(interval); };
  }, [engine, activeWorkspace?.uri, activeWorkspace?.isAdmin, activeWorkspace?.degradedReasons.length, operatorReady]);

  useEffect(() => {
    // A read the account was refused (removed, the channel archived or paused) has the selection follow the workspace now.
    if (contentRefused) void refreshWorkspaces().catch((caught) => setError(messageOf(caught)));
  }, [contentRefused, refreshWorkspaces]);

  async function createWorkspace(event: FormEvent) {
    event.preventDefault();
    await createWorkspaceNamed(workspaceName, { mayAuthorize: true });
  }

  async function connectInvitation(uri: string) {
    if (busy) return;
    if (!parsePastedWorkspaceUri(uri)) { setError(`Paste a workspace URI in the form at://DID/space/${SPACE_TYPE.workspace}/key.`); return; }
    await acceptWorkspace(uri.trim());
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
      if (!engine?.operator) throw new Error("Connect this browser first.");
      const { operation } = await engine.operator.execute(pending);
      setOperatorReady(true);
      setStatus(request.kind === "inviteMember" && operation.state === "completed"
        ? `Added ${String(request.subject)}. Send them an invite link (use “Copy invite link”) so they can find and join the workspace.`
        : `Operation ${operation.state}; ${operation.completedSteps.length} steps recorded.${operation.error ? ` ${operation.error}` : ""}`);
      if (operation.state === "completed" || operation.state === "failed") {
        setPendingOperation(null);
        sessionStorage.removeItem("spaces.pendingOperatorOperation");
      }
      await refreshWorkspaces();
      if (request.kind === "leaveChannel" && operation.state === "completed") {
        clearChannelView();
        await engine?.channels.left({ workspace, skey: String(request.skey) }).catch((caught) => setError(messageOf(caught)));
      } else if (activeChannel?.workspace === workspace) await live?.reload(channelKey(activeChannel));
      // What an operation changes for an admin: the inbox's requests and the stalled operations.
      admin.reload();
    } catch (caught) {
      setStatus("");
      if (needsAuthorityApproval(caught)) {
        // The operator's grant for this workspace lapsed. Only its authority can renew it; the operation stays pending to retry.
        if (parsePastedWorkspaceUri(workspace)?.authorityDid !== did) { setError(messageOf(caught)); return; }
        setStatus("Opening the permission screen. Approve it, then retry the pending operation.");
        await approveAuthority({ purpose: "reauthorize" }).catch((grantFailure) => { setStatus(""); setError(messageOf(grantFailure)); });
        return;
      }
      setError(messageOf(caught));
    } finally { setBusy(false); }
  }

  async function openChannel(channel: WorkspaceSummary["channels"][number]) {
    if (!activeWorkspace) return;
    const selected = { workspace: activeWorkspace.uri, skey: channel.skey, name: channel.name, visibility: channel.visibility };
    const reopened = activeChannel !== null && channelKey(activeChannel) === channelKey(selected);
    setDmView(null);
    setChosenChannel({ workspace: selected.workspace, skey: selected.skey }); resetChannelInput(); setError("");
    // The channel's live view loads it (none while it is in transition); the same channel opened again keeps its view, which
    // is asked to load it now.
    if (reopened) await live?.reload(channelKey(selected));
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
      rediscoverAfterAccessFailure(caught);
    } finally { setBusy(false); }
  }

  /** Asks to join the open private channel, or withdraws the ask: a request record in the account's own repo, in the inbox. */
  async function requestPrivateAccess(withdraw = false) {
    if (!engine || !activeChannel || activeChannel.visibility === "transitioning") return;
    try {
      if (withdraw) await engine.channels.withdrawJoin(activeChannel);
      else await engine.channels.requestJoin(activeChannel);
      setRequestSubmitted(!withdraw);
      setStatus(withdraw ? "Your private-channel request was withdrawn." : "Your access request is in the workspace inbox.");
    } catch (caught) {
      setError(messageOf(caught));
      rediscoverAfterAccessFailure(caught);
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
    // The shown workspace chosen again only returns to its home; its inbox and operator state stay.
    setChosenWorkspace(uri);
  }

  function syncInbox() {
    admin.reload();
  }

  return (
    <DmProvider did={did} dmConfig={dmConfig} workspaces={workspaces} activeWorkspace={activeWorkspace} view={dmView} openView={openDmView}>
    <main className="app-frame">
      <Sidebar did={did} workspaces={workspaces} workspaceCandidates={workspaceCandidates} activeUri={activeUri} activeWorkspace={activeWorkspace} activeChannel={activeChannel} switchWorkspace={switchWorkspace} openChannel={openChannel} refresh={() => void refreshWorkspaces().catch((caught) => setError(messageOf(caught)))} />
      <section className="main-stage">
        <header className="topbar"><div className="breadcrumb">Your spaces <span>/</span> <strong>{activeChannel?.name ?? (dmView ? "Direct messages" : activeWorkspace?.name ?? "Overview")}</strong></div><div className="topbar-tools"><button className="help-button" onClick={() => void refreshWorkspaces().catch((caught) => setError(messageOf(caught)))}>↻ <span>Refresh</span></button><button className="top-avatar">{did.slice(-1).toUpperCase()}</button></div></header>
        <div className="overview-content">
          {shownError && <p className="form-error" role="alert">{shownError}</p>}
          {status && <p className="status-note" role="status">{status}</p>}
          {sessionStatus !== "ready" && <div className="starter-card permission-box" role="status"><p>{sessionStatus === "connecting" ? "Connecting this browser to your account…" : "Allow this browser to read your workspaces, channels and messages, and to send your messages, with one approval on your account’s own server."}</p>{sessionError && <p className="form-error" role="alert">{sessionError}</p>}{sessionStatus !== "connecting" && <button className="text-button" onClick={connectSession}>Connect this browser →</button>}</div>}
          {activeWorkspace && activeWorkspace.degradedReasons.length > 0 && <div className="envelope-alert" role="alert"><strong>Workspace is in degraded mode.</strong><ul>{activeWorkspace.degradedReasons.map((reason) => <li key={reason}>{reason}</li>)}</ul><p>Admin changes and inbox reconciliation are paused until the workspace is within the supported v1 limits.</p></div>}
          {pendingOperation && <p className="status-note">Operation {pendingOperation.operationId} is still pending. <button className="text-button" disabled={busy || workspaceDegraded} onClick={() => void runOperation(pendingOperation.request, pendingOperation.workspace, pendingOperation.operationId)}>Retry same operation ↻</button></p>}
          {stalledWork && stalledWork.operations.length > 0 && <div className="operation-alert" role="alert"><strong>{stalledWork.operations.length} operation(s) have had no progress for at least five minutes.{stalledWork.truncated ? " Showing the oldest 100; more stalled operations exist." : ""}</strong>{stalledWork.operations.map((operation) => <p key={`${operation.actor}:${operation.operationId}`}>{operation.operationId} · {operation.actor} · {operation.error ?? operation.state}</p>)}</div>}
          {inboxView && inboxView.skipped.length > 0 && <p className="status-note" role="status">Join requests from {inboxView.skipped.map(({ did: writer, reason }) => `${writer} (${reason})`).join("; ")} could not be read.</p>}
          {sessionStatus === "ready" && <>
          {!dmView && workspacesLoaded && invitedTo && !workspaces.some((workspace) => workspace.uri === invitedTo) && <InviteBanner workspace={invitedTo} busy={busy} join={() => void connectInvitation(invitedTo)} dismiss={dismissInvitation} />}
          {!dmView && !activeWorkspace && <WorkspaceOnboarding busy={busy} workspaceName={workspaceName} setWorkspaceName={setWorkspaceName} inviteUri={inviteUri} setInviteUri={setInviteUri} createWorkspace={createWorkspace} beginAccept={beginAccept} />}
          {!dmView && activeWorkspace && (!activeChannel || activeChannel.workspace !== activeUri) && <WorkspaceHome did={did} activeWorkspace={activeWorkspace} busy={busy} workspaceDegraded={workspaceDegraded} inbox={inboxView?.requests ?? []} inboxLoaded={inboxView !== undefined && !inboxView.refused} inboxPermissionMissing={inboxView?.refused === true} runOperation={runOperation} leaveWorkspace={leaveWorkspace} syncInbox={syncInbox} setStatus={setStatus} setError={setError} />}
          {!dmView && activeChannel?.workspace === activeUri && <ChannelView did={did} activeChannel={activeChannel} activeWorkspace={activeWorkspace} busy={busy} workspaceDegraded={workspaceDegraded} requestSubmitted={requestSubmitted} content={openContent.content} loadOlder={openContent.loadOlder} reload={openContent.reload} messageText={messageText} setMessageText={setMessageText} replyTo={replyTo} setReplyTo={setReplyTo} runOperation={runOperation} leaveChannel={leaveChannel} requestPrivateAccess={requestPrivateAccess} sendMessage={sendMessage} toggleReaction={toggleReaction} editMessage={editMessage} deleteMessage={deleteMessage} setError={setError} />}
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
    } catch (caught) { setError(messageOf(caught)); rediscoverAfterAccessFailure(caught); }
  }

  async function editMessage(message: Message) {
    if (!activeChannel || activeChannel.visibility === "transitioning") return;
    const text = window.prompt("Edit message", message.value.text ?? "");
    if (text === null) return;
    if (!engine) return;
    try {
      await engine.channels.edit(activeChannel, message.uri, text);
      await live?.reload(channelKey(activeChannel));
    } catch (caught) { setError(messageOf(caught)); rediscoverAfterAccessFailure(caught); }
  }

  async function deleteMessage(uri: string) {
    if (!activeChannel || activeChannel.visibility === "transitioning" || !window.confirm("Delete this message from your repo?")) return;
    if (!engine) return;
    try {
      await engine.channels.delete(activeChannel, uri);
      await live?.reload(channelKey(activeChannel));
    } catch (caught) { setError(messageOf(caught)); rediscoverAfterAccessFailure(caught); }
  }

}

