"use client";

import dynamic from "next/dynamic";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChannelView } from "./channel-view";
import { acceptFailure } from "@flock/client/accept-errors";
import { captureInviteLink, INVITE_LINK_KEY, isAccessFailure, makeTid, needsAuthorityApproval, WORKSPACE_OPERATION_KEY, workspaceCreationFrom, workspaceOperationIdFor, messageOf, parsePastedWorkspaceUri, resolveScopedReplyTo, type Message, type PendingOperation, type PermalinkResolution, type ScopedReplyDraft, type WorkspaceCreationInput } from "./client-api";
import { DmProvider, type DmView } from "./dm-context";
import type { ExtensionToggleOutcome } from "./extensions-panel";
import { TasksWorkspaceView } from "./ext/tasks/tasks-workspace-view";
import { InviteBanner } from "./invite-banner";
import { channelRoute, dmConversationRoute, dmHomeRoute, homeRoute, messageRoute, parseRoute, sanitizeReturnTo, sentThreadCleanupRoute, tasksRoute, workspaceRoute } from "./routes";
import { SessionProvider, useBrowserSessionContext } from "./session-context";
import { Sidebar } from "./sidebar";
import { WorkspaceHome } from "./workspace-home";
import type { AppDirectory } from "./apps-panel";
import { channelCommandContext, resolveComposerSubmission, WorkspaceDeclarationCache, type WorkspaceDeclarations } from "./interactions";
import { WorkspaceOnboarding } from "./workspace-onboarding";
import { channelKey, useChannelContent } from "./use-channel-content";
import { useAdminViews } from "./use-admin-views";
import { useDiscovery } from "./use-discovery";
import { NO_WORKSPACE, shownChannel } from "./selection";
import type { BrowserSessionConfig } from "../../browser/session";
import type { ExtensionId } from "@flock/protocol/extensions";
import { isDid } from "@flock/protocol/keys";
import { SPACE_TYPE } from "@flock/protocol/nsids";
import type { AuthorityFlowRequest } from "@flock/client/operator-client";
import type { WorkspaceDiscovery } from "@flock/client/workspace-client";
import type { WorkspaceSummary } from "@flock/protocol/workspace-summary";

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
  const { engine, live, snapshots, status: sessionStatus, error: sessionError, connect: connectSession } = session;
  const pathname = usePathname() ?? "/";
  const searchParams = useSearchParams();
  const router = useRouter();
  const searchString = useMemo(() => {
    const encoded = searchParams.toString();
    return encoded ? `?${encoded}` : "";
  }, [searchParams]);
  const routeKey = `${pathname}${searchString}`;
  const parsedRoute = useMemo(() => parseRoute(pathname, searchString), [pathname, searchString]);
  const routeWorkspaceUri =
    parsedRoute && (parsedRoute.kind === "workspace" || parsedRoute.kind === "channel" || parsedRoute.kind === "message" || parsedRoute.kind === "tasks")
      ? parsedRoute.workspaceUri
      : null;

  /** The workspace a person chose on `/` (or kept for sidebar context on `/dm`); deep workspace routes override it. */
  const [chosenWorkspace, setChosenWorkspace] = useState<string | null>(null);
  const [workspaceName, setWorkspaceName] = useState("");
  const [workspaceAccount, setWorkspaceAccount] = useState("");
  const [inviteUri, setInviteUri] = useState("");
  const [invitedTo, setInvitedTo] = useState<string | null>(null);
  const [messageText, setMessageText] = useState("");
  const [chosenCommandApp, setChosenCommandApp] = useState<string | null>(null);
  const [composerStatus, setComposerStatus] = useState("");
  const [pendingActions, setPendingActions] = useState<ReadonlySet<string>>(() => new Set());
  const pendingActionsRef = useRef(new Set<string>());
  const [declarationsByWorkspace, setDeclarationsByWorkspace] = useState<Record<string, WorkspaceDeclarations>>({});
  const declarationCacheRef = useRef<WorkspaceDeclarationCache | null>(null);
  const declarationEngineRef = useRef<typeof engine>(null);
  const [replyDraft, setReplyDraft] = useState<ScopedReplyDraft | null>(null);
  const [permalinkLookup, setPermalinkLookup] = useState<{ channelKey: string; resolution: PermalinkResolution } | null>(null);
  const [trackedChannelIdentity, setTrackedChannelIdentity] = useState<string | null>(null);
  const [requestSubmitted, setRequestSubmitted] = useState(false);
  const [pendingOperation, setPendingOperation] = useState<PendingOperation | null>(null);
  /** An operation went through in this page, so the admin's app keeps the workspace reconciled from then on. */
  const [operatorReady, setOperatorReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const resumedRef = useRef(false);
  const navEpochRef = useRef(0);
  const navigateTo = useCallback((url: string, replace = false) => {
    navEpochRef.current += 1;
    if (replace) router.replace(url);
    else router.push(url);
  }, [router]);

  useEffect(() => {
    navEpochRef.current += 1;
  }, [pathname]);

  if (replyDraft && replyDraft.routeKey !== routeKey) {
    setReplyDraft(null);
  }

  useEffect(() => {
    const bumpEpoch = () => { navEpochRef.current += 1; };
    window.addEventListener("popstate", bumpEpoch);
    return () => window.removeEventListener("popstate", bumpEpoch);
  }, []);
  /** The engine's reads of an app account, for the Apps panel: its declaration, and the DID of an account an admin typed. */
  const appDirectory = useMemo<AppDirectory | null>(() => engine ? {
    declaration: (appDid) => engine.workspaces.appDeclaration(appDid),
    resolve: (account) => engine.workspaces.resolveAccount(account),
  } : null, [engine]);

  // Already a member: the invitation has been used, so it is no longer offered.
  const listed = useCallback((discovery: WorkspaceDiscovery) => {
    const waiting = sessionStorage.getItem(INVITE_LINK_KEY);
    if (!waiting || !discovery.workspaces.some((workspace) => workspace.uri === waiting)) return;
    sessionStorage.removeItem(INVITE_LINK_KEY);
    setInvitedTo((current) => current === waiting ? null : current);
  }, []);
  const discoveryChoice = routeWorkspaceUri ?? chosenWorkspace;
  const { discovery: discovered, workspace: discoveredWorkspace, reload: refreshWorkspaces } = useDiscovery(session, discoveryChoice, listed);
  const workspaces = useMemo(() => discovered.value?.workspaces ?? [], [discovered.value]);
  const workspaceCandidates = discovered.value?.candidates ?? [];
  const workspacesLoaded = discovered.value !== undefined;
  const missingRouteWorkspace = Boolean(routeWorkspaceUri && workspacesLoaded && !workspaces.some((workspace) => workspace.uri === routeWorkspaceUri));
  const activeWorkspace = missingRouteWorkspace ? null : discoveredWorkspace;
  const activeUri = activeWorkspace?.uri ?? "";
  const activeDeclarations = useMemo<WorkspaceDeclarations>(
    () => (activeUri ? declarationsByWorkspace[activeUri] ?? {} : {}),
    [activeUri, declarationsByWorkspace],
  );
  const workspaceDegraded = Boolean(activeWorkspace?.degradedReasons.length);
  // The workspace shown stays shown: one discovery fell back to becomes the choice, so a later discovery never moves the view.
  if (activeWorkspace && activeWorkspace.uri !== chosenWorkspace && (!routeWorkspaceUri || activeWorkspace.uri === routeWorkspaceUri)) {
    setChosenWorkspace(activeWorkspace.uri);
  }

  const routeChannelSkey =
    parsedRoute && (parsedRoute.kind === "channel" || parsedRoute.kind === "message")
      ? parsedRoute.channelSkey
      : null;
  const activeChannel = useMemo(
    () => (activeWorkspace && routeChannelSkey ? shownChannel(activeWorkspace, { workspace: activeWorkspace.uri, skey: routeChannelSkey }) : null),
    [activeWorkspace, routeChannelSkey],
  );
  const missingRouteChannel = Boolean(workspacesLoaded && activeWorkspace && routeChannelSkey && !activeChannel);

  const dmView = useMemo<DmView | null>(() => {
    if (parsedRoute?.kind !== "dm") return null;
    if (parsedRoute.view === "conversation") {
      return { kind: "conversation", convKey: parsedRoute.convKey, participants: [] };
    }
    return { kind: parsedRoute.view };
  }, [parsedRoute]);

  const tasksEnabledOnActive = Boolean(activeWorkspace?.extensions?.some((ext) => ext.extId === "tasks" && ext.active));
  const tasksRouteActive = parsedRoute?.kind === "tasks";

  useEffect(() => {
    if (!engine || !activeWorkspace) return;
    if (declarationEngineRef.current !== engine) {
      declarationEngineRef.current = engine;
      declarationCacheRef.current = new WorkspaceDeclarationCache();
    }
    const cache = (declarationCacheRef.current ??= new WorkspaceDeclarationCache());
    const workspaceUri = activeWorkspace.uri;
    const installDids = activeWorkspace.installs.map((install) => install.did);
    const syncSnapshot = () => {
      const next = cache.snapshotOf(workspaceUri);
      setDeclarationsByWorkspace((current) => ({ ...current, [workspaceUri]: next }));
    };
    cache.ensureWorkspace(workspaceUri, installDids, (appDid) => engine.workspaces.appDeclaration(appDid), syncSnapshot);
    syncSnapshot();
  }, [engine, activeWorkspace]);

  /** Empties what a person was typing in the open channel, and whether they had asked to join it. */
  const resetChannelInput = useCallback(() => {
    setReplyDraft(null); setMessageText(""); setChosenCommandApp(null); setComposerStatus(""); setRequestSubmitted(false);
  }, []);

  const activeChannelIdentity = activeChannel ? `${activeChannel.workspace} ${activeChannel.skey}` : null;
  if (trackedChannelIdentity !== activeChannelIdentity) {
    setTrackedChannelIdentity(activeChannelIdentity);
    setReplyDraft(null);
    setMessageText("");
    setChosenCommandApp(null);
    setComposerStatus("");
    setRequestSubmitted(false);
    setPermalinkLookup(null);
  }

  const openDmView = useCallback((view: DmView | null) => {
    resetChannelInput();
    setError("");
    if (!view) {
      navigateTo(activeWorkspace ? workspaceRoute(activeWorkspace.authorityDid, activeWorkspace.skey) : homeRoute());
      return;
    }
    if (view.kind === "conversation") {
      navigateTo(dmConversationRoute(view.convKey));
      return;
    }
    navigateTo(dmHomeRoute(view.kind));
  }, [navigateTo, activeWorkspace, resetChannelInput]);

  const openContent = useChannelContent(session, did, activeChannel);
  const contentRefused = openContent.content.value?.refused !== undefined;

  /** A write the account was refused (removed, the channel archived or paused) has the selection follow the workspace now. */
  const rediscoverAfterAccessFailure = useCallback((caught: unknown) => {
    if (isAccessFailure(caught)) void refreshWorkspaces().catch((err) => setError(messageOf(err)));
  }, [refreshWorkspaces]);

  const routeThread = parsedRoute?.kind === "channel" ? (parsedRoute.thread ?? "") : "";
  const effectiveReplyTo = resolveScopedReplyTo(routeKey, routeThread, replyDraft);
  const highlightedMessageUri =
    parsedRoute?.kind === "message"
      ? parsedRoute.messageUri
      : parsedRoute?.kind === "channel"
        ? (parsedRoute.thread ?? null)
        : null;

  const activeChannelWorkspace = activeChannel?.workspace ?? null;
  const activeChannelSkey = activeChannel?.skey ?? null;
  const activeChannelVisibility = activeChannel?.visibility ?? null;
  const activeChannelKey =
    activeChannelWorkspace && activeChannelSkey && activeChannelVisibility && activeChannelVisibility !== "transitioning"
      ? channelKey({ workspace: activeChannelWorkspace, skey: activeChannelSkey, visibility: activeChannelVisibility })
      : null;
  const hasChannelValue = openContent.content.value !== undefined;
  const channelRefused = Boolean(openContent.content.value?.refused);
  const channelHasError = openContent.content.error !== undefined;
  const channelLoading = openContent.content.loading;
  const inLoadedWindow = Boolean(
    highlightedMessageUri && openContent.content.value?.messages.some((entry) => entry.uri === highlightedMessageUri),
  );

  if (!highlightedMessageUri && permalinkLookup !== null) {
    setPermalinkLookup(null);
  }

  useEffect(() => {
    if (
      !highlightedMessageUri ||
      !engine ||
      !activeChannelWorkspace ||
      !activeChannelSkey ||
      !activeChannelKey ||
      activeChannelVisibility === "transitioning" ||
      !hasChannelValue ||
      channelLoading ||
      channelRefused ||
      channelHasError ||
      inLoadedWindow
    ) {
      return;
    }
    let cancelled = false;
    const targetUri = highlightedMessageUri;
    const ref = { workspace: activeChannelWorkspace, skey: activeChannelSkey };
    void engine.channels.getMessage(ref, targetUri).then(
      (found) => {
        if (cancelled) return;
        if (!found) {
          setPermalinkLookup({ channelKey: activeChannelKey, resolution: { uri: targetUri, status: "not_found" } });
          return;
        }
        const linked: Message = {
          uri: found.uri,
          rkey: found.rkey,
          repo: found.repo,
          value: found.value as Message["value"],
          reactions: [],
        };
        setPermalinkLookup({
          channelKey: activeChannelKey,
          resolution: { uri: targetUri, status: "resolved", message: linked },
        });
      },
      (caught: unknown) => {
        if (cancelled) return;
        rediscoverAfterAccessFailure(caught);
        setPermalinkLookup({
          channelKey: activeChannelKey,
          resolution: { uri: targetUri, status: "error", message: messageOf(caught) },
        });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [
    engine,
    activeChannelWorkspace,
    activeChannelSkey,
    activeChannelVisibility,
    activeChannelKey,
    highlightedMessageUri,
    hasChannelValue,
    channelLoading,
    channelRefused,
    channelHasError,
    inLoadedWindow,
    rediscoverAfterAccessFailure,
  ]);

  const activePermalinkResolution = useMemo<PermalinkResolution | null>(() => {
    if (!highlightedMessageUri || !activeChannelKey) return null;
    if (inLoadedWindow) {
      return { uri: highlightedMessageUri, status: "resolved", message: null };
    }
    if (
      permalinkLookup &&
      permalinkLookup.channelKey === activeChannelKey &&
      permalinkLookup.resolution.uri === highlightedMessageUri
    ) {
      return permalinkLookup.resolution;
    }
    if (hasChannelValue && !channelLoading && !channelRefused && !channelHasError) {
      return { uri: highlightedMessageUri, status: "loading" };
    }
    return null;
  }, [
    highlightedMessageUri,
    activeChannelKey,
    inLoadedWindow,
    permalinkLookup,
    hasChannelValue,
    channelLoading,
    channelRefused,
    channelHasError,
  ]);

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
      setChosenWorkspace(workspace); resetChannelInput();
      setInviteUri("");
      setInvitedTo((cur) => cur === workspace ? null : cur);
      if (sessionStorage.getItem(INVITE_LINK_KEY) === workspace) sessionStorage.removeItem(INVITE_LINK_KEY);
    } catch (caught) {
      setError(acceptFailure(caught)?.error ?? messageOf(caught));
    } finally {
      setBusy(false);
    }
  }, [engine, resetChannelInput, refreshWorkspaces]);

  /**
   * Sends the browser to approve the operator's grant for a workspace account (this person's own, or a dedicated one, which
   * whoever approves must sign in as): for a workspace being created, or again for a workspace's account.
   */
  const approveAuthority = useCallback(async (input: AuthorityFlowRequest) => {
    if (!engine?.operator) throw new Error("Connect this browser first.");
    const { url } = await engine.operator.startAuthorityFlow(input);
    window.location.assign(url);
  }, [engine]);

  // The first workspace needs the authority's grant. The operator says so with a typed answer,
  // and this approves, returns, and resumes the same journaled operation once. The resumed
  // attempt must not redirect again, so an approval that did not take shows an error instead
  // of looping.
  const createWorkspaceNamed = useCallback(async ({ name, account }: WorkspaceCreationInput, options: { mayAuthorize: boolean }) => {
    let redirecting = false;
    setBusy(true); setError(""); setStatus("Creating protocol spaces and authority records…");
    try {
      if (account && !isDid(account)) throw new Error("The workspace account must be a DID (did:plc:… or did:web:…), or empty for your own account.");
      const authority = account ? { authority: account } : {};
      const operationId = workspaceOperationIdFor({ name, account }, sessionStorage.getItem(WORKSPACE_OPERATION_KEY));
      sessionStorage.setItem(WORKSPACE_OPERATION_KEY, JSON.stringify({ name, account, operationId }));
      if (!engine?.operator) throw new Error("Connect this browser first.");
      const result = await engine.operator.createWorkspace({ name, operationId, ...authority });
      // Under a dedicated account the person is a member, not the owner: like an invited member, they list the workspace
      // once they have accepted it, which only their own session can write.
      if (account && result.state === "completed") await engine.workspaces.accept(result.workspace);
      const current = await refreshWorkspaces();
      if (current?.workspaces.some((entry) => entry.uri === result.workspace)) {
        setChosenWorkspace(result.workspace); resetChannelInput();
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
      setStatus(account
        ? "Opening the permission screen. Sign in there as the workspace account and approve it to finish creating the workspace…"
        : "Opening the permission screen. Approve it to finish creating your workspace…");
      sessionStorage.setItem("spaces.pendingWorkspaceName", name);
      sessionStorage.setItem("spaces.pendingWorkspaceAccount", account);
      sessionStorage.setItem("spaces.autoCreateWorkspace", "1");
      try {
        await approveAuthority({ purpose: "createWorkspace", name, ...(account ? { authority: account } : {}) });
        redirecting = true;
      } catch (grantFailure) {
        sessionStorage.removeItem("spaces.pendingWorkspaceName");
        sessionStorage.removeItem("spaces.pendingWorkspaceAccount");
        sessionStorage.removeItem("spaces.autoCreateWorkspace");
        setStatus("");
        setError(messageOf(grantFailure));
      }
    } finally { if (!redirecting) setBusy(false); }
  }, [engine, approveAuthority, resetChannelInput, refreshWorkspaces]);

  useEffect(() => {
    // Back from the permission screen restores this page as it was left. The resume flags must not
    // survive to auto-run later, and the form must be usable again.
    const onPageShow = (event: PageTransitionEvent) => {
      if (!event.persisted) return;
      sessionStorage.removeItem("spaces.autoCreateWorkspace");
      sessionStorage.removeItem("spaces.pendingWorkspaceName");
      sessionStorage.removeItem("spaces.pendingWorkspaceAccount");
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
      if (search.includes("invite=") || search.includes("authority=")) {
        const cleaned = sanitizeReturnTo(window.location.pathname, search);
        window.history.replaceState(null, "", cleaned ?? window.location.pathname);
      }
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
      const savedAccount = sessionStorage.getItem("spaces.pendingWorkspaceAccount") ?? "";
      if (savedName) { setWorkspaceName(savedName); setWorkspaceAccount(savedAccount); sessionStorage.removeItem("spaces.pendingWorkspaceName"); }
      sessionStorage.removeItem("spaces.pendingWorkspaceAccount");
      if (sessionStorage.getItem("spaces.autoCreateWorkspace")) {
        sessionStorage.removeItem("spaces.autoCreateWorkspace");
        if (savedName) void createWorkspaceNamed({ name: savedName, account: savedAccount }, { mayAuthorize: false });
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
    await createWorkspaceNamed(workspaceCreationFrom({ name: workspaceName, account: workspaceAccount }, did), { mayAuthorize: true });
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

  async function runOperation(request: Record<string, unknown>, workspace = activeWorkspace?.uri, operationId = makeTid()): Promise<boolean> {
    if (!workspace) return false;
    if (activeWorkspace?.uri === workspace && activeWorkspace.degradedReasons.length) {
      setError(`Workspace mutations are paused in degraded mode. ${activeWorkspace.degradedReasons.join(" ")}`);
      return false;
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
        resetChannelInput();
        await engine?.channels.left({ workspace, skey: String(request.skey) }).catch((caught) => setError(messageOf(caught)));
        const liveRoute = typeof window === "undefined" ? parsedRoute : parseRoute(window.location.pathname, window.location.search);
        const onLeftChannel =
          (liveRoute?.kind === "channel" || liveRoute?.kind === "message") &&
          liveRoute.workspaceUri === workspace &&
          liveRoute.channelSkey === String(request.skey);
        if (activeWorkspace && activeWorkspace.uri === workspace && onLeftChannel) {
          navigateTo(workspaceRoute(activeWorkspace.authorityDid, activeWorkspace.skey));
        }
      } else if (request.kind === "leaveWorkspace" && operation.state === "completed") {
        const liveRoute = typeof window === "undefined" ? parsedRoute : parseRoute(window.location.pathname, window.location.search);
        if (liveRoute && liveRoute.kind !== "home" && "workspaceUri" in liveRoute && liveRoute.workspaceUri === workspace) {
          navigateTo(homeRoute());
        }
      } else if (activeChannel?.workspace === workspace) await live?.reload(channelKey(activeChannel));
      // What an operation changes for an admin: the inbox's requests and the stalled operations.
      admin.reload();
      return operation.state === "completed";
    } catch (caught) {
      setStatus("");
      if (needsAuthorityApproval(caught)) {
        // The operator's grant for this workspace lapsed. Any admin may open its renewal, which only a sign-in as the workspace
        // account completes; the operation stays pending to retry.
        const authority = parsePastedWorkspaceUri(workspace)?.authorityDid;
        if (!authority) { setError(messageOf(caught)); return false; }
        setStatus(authority === did
          ? "Opening the permission screen. Approve it, then retry the pending operation."
          : "Opening the permission screen. Sign in there as the workspace account and approve it, then retry the pending operation.");
        await approveAuthority({ purpose: "reauthorize", authority }).catch((grantFailure) => { setStatus(""); setError(messageOf(grantFailure)); });
        return false;
      }
      setError(messageOf(caught));
      return false;
    } finally { setBusy(false); }
  }

  async function toggleExtension(extId: ExtensionId, enable: boolean): Promise<ExtensionToggleOutcome> {
    if (!activeWorkspace) return { kind: "failed" };
    if (activeWorkspace.degradedReasons.length) {
      setError(`Workspace mutations are paused in degraded mode. ${activeWorkspace.degradedReasons.join(" ")}`);
      return { kind: "failed" };
    }
    const workspace = activeWorkspace.uri;
    const operationId = makeTid();
    const request = { kind: enable ? "enableExtension" : "disableExtension", extId } as const;
    const pending = { workspace, operationId, request };
    setPendingOperation(pending);
    sessionStorage.setItem("spaces.pendingOperatorOperation", JSON.stringify(pending));
    setBusy(true);
    setError("");
    setStatus(enable ? `Enabling ${extId} extension…` : `Disabling ${extId} extension…`);
    try {
      if (!engine?.operator) throw new Error("Connect this browser first.");
      const { operation } = enable
        ? await engine.operator.enableExtension(workspace, extId, operationId)
        : await engine.operator.disableExtension(workspace, extId, operationId);
      setOperatorReady(true);
      setStatus(`Operation ${operation.state}; ${operation.completedSteps.length} steps recorded.${operation.error ? ` ${operation.error}` : ""}`);
      if (operation.state === "completed" || operation.state === "failed") {
        setPendingOperation(null);
        sessionStorage.removeItem("spaces.pendingOperatorOperation");
      }
      await refreshWorkspaces();
      admin.reload();
      return operation.state === "completed" ? { kind: "completed" } : { kind: "failed" };
    } catch (caught) {
      setStatus("");
      if (needsAuthorityApproval(caught)) {
        return {
          kind: "reauthorizationRequired",
          message: messageOf(caught),
          authorityDid: activeWorkspace.authorityDid,
        };
      }
      setError(messageOf(caught));
      return { kind: "failed" };
    } finally {
      setBusy(false);
    }
  }

  async function reauthorizeAuthority(authorityDid: string): Promise<void> {
    setBusy(true);
    setError("");
    setStatus(
      authorityDid === did
        ? "Opening the permission screen. Approve it, then retry the pending operation."
        : "Opening the permission screen. Sign in there as the workspace account and approve it, then retry the pending operation.",
    );
    try {
      await approveAuthority({ purpose: "reauthorize", authority: authorityDid });
    } catch (caught) {
      setStatus("");
      setError(messageOf(caught));
      setBusy(false);
    }
  }

  async function openChannel(channel: WorkspaceSummary["channels"][number]) {
    if (!activeWorkspace) return;
    const selected = { workspace: activeWorkspace.uri, skey: channel.skey, name: channel.name, visibility: channel.visibility };
    const reopened = activeChannel !== null && channelKey(activeChannel) === channelKey(selected);
    const targetUrl = channelRoute({
      authority: activeWorkspace.authorityDid,
      workspaceSkey: activeWorkspace.skey,
      channelSkey: channel.skey,
    });
    resetChannelInput(); setError("");
    if (reopened && parsedRoute?.kind === "channel" && !parsedRoute.thread) {
      await live?.reload(channelKey(selected));
      return;
    }
    navigateTo(targetUrl);
  }

  function openTasks() {
    if (!activeWorkspace) return;
    resetChannelInput();
    setError("");
    navigateTo(tasksRoute(activeWorkspace.authorityDid, activeWorkspace.skey));
  }

  function handleReplyToChange(nextUri: string) {
    setReplyDraft({ routeKey, uri: nextUri });
    if (!activeWorkspace || !activeChannel) return;
    if (parsedRoute?.kind === "channel") {
      // Only touch the URL when entering a thread or removing an existing ?thread= query param.
      if (!nextUri && !parsedRoute.thread) return;
      router.replace(
        channelRoute({
          authority: activeWorkspace.authorityDid,
          workspaceSkey: activeWorkspace.skey,
          channelSkey: activeChannel.skey,
          ...(nextUri ? { thread: nextUri } : {}),
        }),
      );
    } else if (parsedRoute?.kind === "message" && nextUri) {
      navigateTo(
        channelRoute({
          authority: activeWorkspace.authorityDid,
          workspaceSkey: activeWorkspace.skey,
          channelSkey: activeChannel.skey,
          thread: nextUri,
        }),
      );
    }
  }

  function openMessagePermalink(message: Message) {
    if (!activeWorkspace || !activeChannel) return;
    navigateTo(
      messageRoute({
        authority: activeWorkspace.authorityDid,
        workspaceSkey: activeWorkspace.skey,
        channelSkey: activeChannel.skey,
        repo: message.repo,
        rkey: message.rkey,
      }),
    );
  }

  // Messages and reactions are written by the engine to the account's own repo, with the browser session's grant; the
  // engine keeps an own write in view until the authority lists it. Slash commands write only into the app's inbox.
  async function sendMessage(event: FormEvent) {
    event.preventDefault();
    if (!engine || !activeWorkspace || !activeChannel || activeChannel.visibility === "transitioning") return;
    const sentWorkspace = activeWorkspace;
    const sentChannel = activeChannel;
    const replyTarget = effectiveReplyTo || undefined;
    const sendEpoch = navEpochRef.current;
    const finishSentMessage = () => {
      // If the person navigated elsewhere while the PDS write finished, do not clobber the new route or URL.
      if (navEpochRef.current !== sendEpoch) return;
      const liveRoute = typeof window === "undefined"
        ? parsedRoute
        : parseRoute(window.location.pathname, window.location.search);
      if (
        liveRoute?.kind !== "channel" ||
        liveRoute.workspaceUri !== sentWorkspace.uri ||
        liveRoute.channelSkey !== sentChannel.skey
      ) {
        return;
      }
      const encodedSearch = typeof window === "undefined" ? "" : new URLSearchParams(window.location.search).toString();
      const liveRouteKey = typeof window === "undefined"
        ? routeKey
        : `${window.location.pathname}${encodedSearch ? `?${encodedSearch}` : ""}`;
      setMessageText("");
      setChosenCommandApp(null);
      setReplyDraft(liveRoute.thread ? { routeKey: liveRouteKey, uri: "" } : null);
      const cleanupUrl = sentThreadCleanupRoute(liveRoute, {
        authority: sentWorkspace.authorityDid,
        workspaceSkey: sentWorkspace.skey,
        workspaceUri: sentWorkspace.uri,
        channelSkey: sentChannel.skey,
      });
      if (cleanupUrl) router.replace(cleanupUrl);
    };
    const linkedMessage =
      activePermalinkResolution?.status === "resolved" ? activePermalinkResolution.message : null;
    const commandContent =
      openContent.content.value &&
      linkedMessage &&
      !openContent.content.value.messages.some((entry) => entry.uri === linkedMessage.uri)
        ? { ...openContent.content.value, messages: [...openContent.content.value.messages, linkedMessage] }
        : openContent.content.value;
    const context = channelCommandContext({
      workspace: activeWorkspace,
      channel: activeChannel,
      viewerDid: did,
      content: commandContent,
      replyTo: effectiveReplyTo,
      declarations: activeDeclarations,
    });
    const resolution = resolveComposerSubmission(messageText, { ...context, chosenAppDid: chosenCommandApp });
    if (resolution.kind === "empty") return;
    if (
      resolution.kind === "blocked" ||
      resolution.kind === "held" ||
      resolution.kind === "unknown" ||
      resolution.kind === "ambiguous"
    ) {
      setComposerStatus(resolution.reason);
      return;
    }
    setBusy(true); setError(""); setComposerStatus("");
    try {
      if (resolution.kind === "command") {
        await engine.appInboxes.sendCommand(sentChannel, resolution.appDid, resolution.command, resolution.text, replyTarget);
        finishSentMessage();
        if (navEpochRef.current === sendEpoch) setComposerStatus(`Sent /${resolution.command} to ${resolution.appName}.`);
        return;
      }
      await engine.channels.send(sentChannel, resolution.text, replyTarget);
      finishSentMessage();
      await live?.reload(channelKey(sentChannel));
    } catch (caught) {
      setError(messageOf(caught));
      rediscoverAfterAccessFailure(caught);
    } finally { setBusy(false); }
  }

  async function sendAction(message: Message, actionId: string) {
    if (!engine || !activeChannel || activeChannel.visibility === "transitioning") return;
    const actionKey = `${message.uri} ${actionId}`;
    if (pendingActionsRef.current.has(actionKey)) return;
    pendingActionsRef.current.add(actionKey);
    setPendingActions(new Set(pendingActionsRef.current));
    setError("");
    try {
      await engine.appInboxes.sendAction(activeChannel, message.repo, message.uri, actionId);
    } catch (caught) {
      setError(messageOf(caught));
      rediscoverAfterAccessFailure(caught);
    } finally {
      pendingActionsRef.current.delete(actionKey);
      setPendingActions(new Set(pendingActionsRef.current));
    }
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
    resetChannelInput();
    setError("");
    if (uri === NO_WORKSPACE) {
      setChosenWorkspace(NO_WORKSPACE);
      if (pathname !== "/") navigateTo(homeRoute());
      return;
    }
    setChosenWorkspace(uri);
    const target = workspaces.find((entry) => entry.uri === uri);
    if (target) {
      navigateTo(workspaceRoute(target.authorityDid, target.skey));
    } else if (pathname !== "/") {
      navigateTo(homeRoute());
    }
  }

  function syncInbox() {
    admin.reload();
  }

  const sidebarWorkspace = discoveredWorkspace;
  const breadcrumbLabel =
    activeChannel?.name ??
    (dmView
      ? "Direct messages"
      : tasksRouteActive
        ? `${activeWorkspace?.name ?? "Workspace"} / Tasks`
        : activeWorkspace?.name ?? "Overview");

  return (
    <DmProvider did={did} dmConfig={dmConfig} workspaces={workspaces} activeWorkspace={sidebarWorkspace} view={dmView} openView={openDmView}>
    <main className="app-frame">
      <Sidebar
        did={did}
        workspaces={workspaces}
        workspaceCandidates={workspaceCandidates}
        activeUri={activeWorkspace?.uri ?? sidebarWorkspace?.uri ?? ""}
        activeWorkspace={sidebarWorkspace}
        activeChannel={activeChannel}
        tasksEnabled={tasksEnabledOnActive}
        tasksActive={tasksRouteActive}
        openTasks={openTasks}
        switchWorkspace={switchWorkspace}
        openChannel={openChannel}
        refresh={() => void refreshWorkspaces().catch((caught) => setError(messageOf(caught)))}
      />
      <section className="main-stage">
        <header className="topbar"><div className="breadcrumb">Your spaces <span>/</span> <strong>{breadcrumbLabel}</strong></div><div className="topbar-tools"><button className="help-button" onClick={() => void refreshWorkspaces().catch((caught) => setError(messageOf(caught)))}>↻ <span>Refresh</span></button><button className="top-avatar">{did.slice(-1).toUpperCase()}</button></div></header>
        <div className="overview-content">
          {shownError && <p className="form-error" role="alert">{shownError}</p>}
          {status && <p className="status-note" role="status">{status}</p>}
          {sessionStatus !== "ready" && <div className="starter-card permission-box" role="status"><p>{sessionStatus === "connecting" ? "Connecting this browser to your account…" : "Allow this browser to read your workspaces, channels and messages, and to send your messages, with one approval on your account’s own server."}</p>{sessionError && <p className="form-error" role="alert">{sessionError}</p>}{sessionStatus !== "connecting" && <button className="text-button" onClick={connectSession}>Connect this browser →</button>}</div>}
          {activeWorkspace && activeWorkspace.degradedReasons.length > 0 && <div className="envelope-alert" role="alert"><strong>Workspace is in degraded mode.</strong><ul>{activeWorkspace.degradedReasons.map((reason) => <li key={reason}>{reason}</li>)}</ul><p>Admin changes and inbox reconciliation are paused until the workspace is within the supported v1 limits.</p></div>}
          {pendingOperation && <p className="status-note">Operation {pendingOperation.operationId} is still pending. <button className="text-button" disabled={busy || workspaceDegraded} onClick={() => void runOperation(pendingOperation.request, pendingOperation.workspace, pendingOperation.operationId)}>Retry same operation ↻</button></p>}
          {stalledWork && stalledWork.operations.length > 0 && <div className="operation-alert" role="alert"><strong>{stalledWork.operations.length} operation(s) have had no progress for at least five minutes.{stalledWork.truncated ? " Showing the oldest 100; more stalled operations exist." : ""}</strong>{stalledWork.operations.map((operation) => <p key={`${operation.actor}:${operation.operationId}`}>{operation.operationId} · {operation.actor} · {operation.error ?? operation.state}</p>)}</div>}
          {inboxView && inboxView.skipped.length > 0 && <p className="status-note" role="status">Join requests from {inboxView.skipped.map(({ did: writer, reason }) => `${writer} (${reason})`).join("; ")} could not be read.</p>}
          {sessionStatus === "ready" && <>
          {parsedRoute === null ? (
            <div className="starter-card">
              <p className="form-error" role="alert">Page not found.</p>
              <button type="button" className="text-button" onClick={() => navigateTo(homeRoute())}>Back to your spaces →</button>
            </div>
          ) : dmView ? (
            <DmStage />
          ) : (
            <>
              {workspacesLoaded && invitedTo && !workspaces.some((workspace) => workspace.uri === invitedTo) && <InviteBanner workspace={invitedTo} busy={busy} join={() => void connectInvitation(invitedTo)} dismiss={dismissInvitation} />}
              {missingRouteWorkspace ? (
                <div className="starter-card">
                  <p className="form-error" role="alert">Workspace not found or you do not have access to it.</p>
                  <button type="button" className="text-button" onClick={() => navigateTo(homeRoute())}>Back to your spaces →</button>
                </div>
              ) : !activeWorkspace ? (
                workspacesLoaded || parsedRoute.kind === "home" ? (
                  <WorkspaceOnboarding busy={busy} workspaceName={workspaceName} setWorkspaceName={setWorkspaceName} workspaceAccount={workspaceAccount} setWorkspaceAccount={setWorkspaceAccount} inviteUri={inviteUri} setInviteUri={setInviteUri} createWorkspace={createWorkspace} beginAccept={beginAccept} />
                ) : (
                  <p className="status-note" role="status">Loading workspace…</p>
                )
              ) : missingRouteChannel ? (
                <div className="starter-card">
                  <p className="form-error" role="alert">Channel not found or you no longer have access to it.</p>
                  <button type="button" className="text-button" onClick={() => navigateTo(workspaceRoute(activeWorkspace.authorityDid, activeWorkspace.skey))}>Back to workspace →</button>
                </div>
              ) : parsedRoute.kind === "tasks" && engine ? (
                <TasksWorkspaceView
                  did={did}
                  engine={engine}
                  live={live}
                  snapshots={snapshots}
                  workspace={activeWorkspace}
                  route={parsedRoute}
                  navigate={(url) => navigateTo(url)}
                  onEnableTasks={() => navigateTo(workspaceRoute(activeWorkspace.authorityDid, activeWorkspace.skey))}
                  setStatus={setStatus}
                  setError={setError}
                />
              ) : activeChannel?.workspace === activeUri ? (
                <ChannelView
                  did={did}
                  activeChannel={activeChannel}
                  activeWorkspace={activeWorkspace}
                  declarations={activeDeclarations}
                  busy={busy}
                  workspaceDegraded={workspaceDegraded}
                  requestSubmitted={requestSubmitted}
                  content={openContent.content}
                  loadOlder={openContent.loadOlder}
                  reload={openContent.reload}
                  messageText={messageText}
                  setMessageText={setMessageText}
                  chosenCommandApp={chosenCommandApp}
                  setChosenCommandApp={setChosenCommandApp}
                  composerStatus={composerStatus}
                  pendingActions={pendingActions}
                  replyTo={effectiveReplyTo}
                  setReplyTo={handleReplyToChange}
                  highlightedMessageUri={highlightedMessageUri}
                  permalinkResolution={activePermalinkResolution}
                  onOpenPermalink={openMessagePermalink}
                  runOperation={runOperation}
                  leaveChannel={leaveChannel}
                  requestPrivateAccess={requestPrivateAccess}
                  sendMessage={sendMessage}
                  sendAction={sendAction}
                  toggleReaction={toggleReaction}
                  editMessage={editMessage}
                  deleteMessage={deleteMessage}
                  setError={setError}
                />
              ) : (
                <WorkspaceHome
                  did={did}
                  apps={appDirectory}
                  activeWorkspace={activeWorkspace}
                  declarations={activeDeclarations}
                  busy={busy}
                  workspaceDegraded={workspaceDegraded}
                  inbox={inboxView?.requests ?? []}
                  inboxLoaded={inboxView !== undefined && !inboxView.refused}
                  inboxPermissionMissing={inboxView?.refused === true}
                  runOperation={runOperation}
                  onToggleExtension={toggleExtension}
                  onReauthorizeAuthority={reauthorizeAuthority}
                  onOpenExtension={(extId) => {
                    if (extId === "tasks") openTasks();
                  }}
                  leaveWorkspace={leaveWorkspace}
                  syncInbox={syncInbox}
                  setStatus={setStatus}
                  setError={setError}
                />
              )}
            </>
          )}
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
