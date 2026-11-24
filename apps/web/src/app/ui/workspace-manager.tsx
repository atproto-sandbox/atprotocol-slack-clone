"use client";

import dynamic from "next/dynamic";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChannelView } from "./channel-view";
import { acceptFailure } from "@flock/client/accept-errors";
import { captureInviteLink, clearPendingOperatorOperation, INVITE_LINK_KEY, isAccessFailure, makeTid, needsAuthorityApproval, readPendingOperatorOperations, upsertPendingOperatorOperation, WORKSPACE_OPERATION_KEY, workspaceCreationFrom, workspaceOperationIdFor, messageOf, parsePastedGroupOrWorkspace, parsePastedWorkspaceUri, resolveScopedReplyTo, type Message, type PendingOperation, type PermalinkResolution, type ScopedReplyDraft, type WorkspaceCreationInput } from "./client-api";
import { DmProvider, type DmView } from "./dm-context";
import type { ExtensionToggleOutcome } from "./extensions-panel";
import { TasksWorkspaceView } from "./ext/tasks/tasks-workspace-view";
import { InviteBanner } from "./invite-banner";
import type { ReportRuleOption } from "./report-subject-modal";
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
import type { GroupClient, GroupRule } from "@flock/client/group-client";
import { isDid } from "@flock/protocol/keys";
import { SPACE_TYPE } from "@flock/protocol/nsids";
import type { AuthorityFlowRequest, OperatorClient } from "@flock/client/operator-client";
import type { ReceivedGroupInvite, WorkspaceClient, WorkspaceDiscovery } from "@flock/client/workspace-client";
import type { WorkspaceSummary } from "@flock/protocol/workspace-summary";

// The DM stage renders only client-side; see the note in sidebar.tsx.
const DmStage = dynamic(() => import("./dm-stage").then((mod) => mod.DmStage), { ssr: false });

export async function abortUnstartedWorkspaceCreation(
  workspaces: Pick<WorkspaceClient, "dismissUnstartedCreateOperation"> | null | undefined,
  storage: Pick<Storage, "getItem" | "removeItem">,
): Promise<boolean> {
  const raw = storage.getItem(WORKSPACE_OPERATION_KEY);
  if (!raw) return false;
  let operationId: string | undefined;
  try {
    const parsed = JSON.parse(raw) as { operationId?: unknown };
    if (typeof parsed?.operationId === "string" && parsed.operationId.length > 0) {
      operationId = parsed.operationId;
    }
  } catch {
    storage.removeItem(WORKSPACE_OPERATION_KEY);
    return false;
  }
  if (!operationId || !workspaces) {
    storage.removeItem(WORKSPACE_OPERATION_KEY);
    return false;
  }
  const outcome = await workspaces.dismissUnstartedCreateOperation(operationId);
  if (outcome !== "in_progress") {
    storage.removeItem(WORKSPACE_OPERATION_KEY);
  }
  return outcome === "dismissed";
}

export async function executeBrowserWorkspaceCreation(
  input: WorkspaceCreationInput,
  deps: {
    mayAuthorize: boolean;
    engine: { workspaces: WorkspaceClient; operator?: OperatorClient } | null;
    storage: Pick<Storage, "getItem" | "setItem" | "removeItem">;
    refreshWorkspaces: () => Promise<WorkspaceDiscovery | undefined>;
    approveAuthority: (req: AuthorityFlowRequest) => Promise<void>;
    onWorkspaceSelected: (workspaceUri: string) => void;
    setStatus: (status: string) => void;
    setError: (error: string) => void;
    setBusy: (busy: boolean) => void;
  },
): Promise<void> {
  let redirecting = false;
  const effectiveJoinPolicy = input.joinPolicy ?? "invite";
  const effectivePublicMeta = input.publicMeta ?? true;
  deps.setBusy(true);
  deps.setError("");
  deps.setStatus("Creating protocol spaces and authority records…");
  try {
    if (!deps.engine?.operator) throw new Error("Connect this browser first.");
    const operationId = workspaceOperationIdFor(
      { name: input.name, account: "", joinPolicy: effectiveJoinPolicy, publicMeta: effectivePublicMeta },
      deps.storage.getItem(WORKSPACE_OPERATION_KEY),
    );
    deps.storage.setItem(
      WORKSPACE_OPERATION_KEY,
      JSON.stringify({
        name: input.name,
        account: "",
        joinPolicy: effectiveJoinPolicy,
        publicMeta: effectivePublicMeta,
        operationId,
      }),
    );
    const result = await deps.engine.workspaces.createWorkspace(
      {
        name: input.name,
        joinPolicy: effectiveJoinPolicy,
        publicMeta: effectivePublicMeta,
      },
      {
        operationId,
        operator: deps.engine.operator,
      },
    );
    const current = await deps.refreshWorkspaces();
    const inDiscovered = Boolean(
      result.workspace && current?.workspaces.some((entry) => entry.uri === result.workspace),
    );
    if (inDiscovered) {
      deps.onWorkspaceSelected(result.workspace);
    }
    if (result.state === "completed" || inDiscovered) {
      deps.storage.removeItem(WORKSPACE_OPERATION_KEY);
      deps.setStatus("Workspace created on AT Protocol.");
    } else {
      deps.setStatus(
        `Setup is pending after ${(result.completedSteps ?? []).length} steps.${result.error ? ` ${result.error}` : ""} Retry to resume.`,
      );
    }
  } catch (caught) {
    deps.setStatus("");
    if (!needsAuthorityApproval(caught)) {
      deps.setError(messageOf(caught));
      return;
    }
    if (!deps.mayAuthorize) {
      await abortUnstartedWorkspaceCreation(deps.engine?.workspaces, deps.storage);
      await deps.refreshWorkspaces().catch(() => undefined);
      deps.setError(
        "Permission was not granted, so the workspace could not be created. Try again and approve every requested permission.",
      );
      return;
    }
    const operationId = workspaceOperationIdFor(
      { name: input.name, account: "", joinPolicy: effectiveJoinPolicy, publicMeta: effectivePublicMeta },
      deps.storage.getItem(WORKSPACE_OPERATION_KEY),
    );
    deps.setStatus("Opening the permission screen. Approve it to finish creating your workspace…");
    deps.storage.setItem("spaces.pendingWorkspaceName", input.name);
    deps.storage.setItem("spaces.pendingJoinPolicy", effectiveJoinPolicy);
    deps.storage.setItem("spaces.pendingPublicMeta", effectivePublicMeta ? "1" : "0");
    deps.storage.setItem("spaces.autoCreateWorkspace", "1");
    try {
      await deps.approveAuthority({
        purpose: "createWorkspace",
        name: input.name,
        joinPolicy: effectiveJoinPolicy,
        publicMeta: effectivePublicMeta,
        creationKey: operationId,
      });
      redirecting = true;
    } catch (grantFailure) {
      deps.storage.removeItem("spaces.pendingWorkspaceName");
      deps.storage.removeItem("spaces.pendingJoinPolicy");
      deps.storage.removeItem("spaces.pendingPublicMeta");
      deps.storage.removeItem("spaces.autoCreateWorkspace");
      await abortUnstartedWorkspaceCreation(deps.engine?.workspaces, deps.storage);
      await deps.refreshWorkspaces().catch(() => undefined);
      deps.setStatus("");
      deps.setError(messageOf(grantFailure));
    }
  } finally {
    if (!redirecting) deps.setBusy(false);
  }
}

export function toPermalinkMessage(found: {
  uri: string;
  cid?: string;
  rkey: string;
  repo: string;
  value: unknown;
  hidden?: boolean;
  labels?: string[];
}): Message {
  return {
    uri: found.uri,
    ...(found.cid !== undefined ? { cid: found.cid } : {}),
    rkey: found.rkey,
    repo: found.repo,
    value: found.value as Message["value"],
    reactions: [],
    ...(found.hidden !== undefined ? { hidden: found.hidden } : {}),
    ...(found.labels !== undefined ? { labels: found.labels } : {}),
  };
}

export function formatReceivedInvitesWarning(error: unknown): string {
  if (error === undefined || error === null) return "";
  return `Cross-PDS invitations could not be loaded completely: ${messageOf(error)}`;
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
  // Sign-in, reads, writes and operator calls all go through the browser session and its engine; the server holds no member
  // session.
  const session = useBrowserSessionContext();
  const { engine, groupOAuth, live, snapshots, status: sessionStatus, error: sessionError, connect: connectSession } = session;
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
  const [joinPolicy, setJoinPolicy] = useState<"invite" | "approval" | "open">("invite");
  const [publicMeta, setPublicMeta] = useState<boolean>(true);
  const [inviteUri, setInviteUri] = useState("");
  const [joinMessage, setJoinMessage] = useState("");
  const [reactivateDid, setReactivateDid] = useState("");
  const [invitedTo, setInvitedTo] = useState<string | null>(null);
  const [groupClientState, setGroupClientState] = useState<{ groupDid: string; client: GroupClient | null } | null>(null);
  const [groupClientSeq, setGroupClientSeq] = useState(0);
  const [rulesByWorkspace, setRulesByWorkspace] = useState<Record<string, ReportRuleOption[]>>({});
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
  const [pendingOperations, setPendingOperations] = useState<PendingOperation[]>([]);
  const pendingOperation = pendingOperations[pendingOperations.length - 1] ?? null;
  const operationInFlightRef = useRef(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const resumedRef = useRef(false);
  const authorityFailedRef = useRef(false);
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
    if (!sessionStorage.getItem("spaces.autoCreateWorkspace")) {
      const rawWorkspaceOp = sessionStorage.getItem(WORKSPACE_OPERATION_KEY);
      if (rawWorkspaceOp) {
        try {
          const parsedOp = JSON.parse(rawWorkspaceOp) as { name?: unknown; operationId?: unknown };
          if (
            typeof parsedOp.operationId === "string" &&
            !discovery.joiningGroups?.some((j) => j.operationId === parsedOp.operationId) &&
            typeof parsedOp.name === "string" &&
            discovery.workspaces.some((w) => w.name === parsedOp.name)
          ) {
            sessionStorage.removeItem(WORKSPACE_OPERATION_KEY);
          }
        } catch {
          sessionStorage.removeItem(WORKSPACE_OPERATION_KEY);
        }
      }
    }
    const waiting = sessionStorage.getItem(INVITE_LINK_KEY);
    if (!waiting || !discovery.workspaces.some((workspace) => workspace.uri === waiting)) return;
    sessionStorage.removeItem(INVITE_LINK_KEY);
    setInvitedTo((current) => current === waiting ? null : current);
  }, []);
  const discoveryChoice = routeWorkspaceUri ?? chosenWorkspace;
  const { discovery: discovered, invites: receivedInvites, workspace: discoveredWorkspace, reload: refreshWorkspaces } = useDiscovery(session, did, discoveryChoice, listed);
  const workspaces = useMemo(() => discovered.value?.workspaces ?? [], [discovered.value]);
  const workspaceCandidates = discovered.value?.candidates ?? [];
  const joiningGroups = discovered.value?.joiningGroups ?? [];
  const leavingGroups = discovered.value?.leavingGroups ?? [];
  const crossPdsInvites = receivedInvites.value ?? [];
  const invitesWarning = formatReceivedInvitesWarning(receivedInvites.error);
  const workspacesLoaded = discovered.value !== undefined;
  const missingRouteWorkspace = Boolean(routeWorkspaceUri && workspacesLoaded && !workspaces.some((workspace) => workspace.uri === routeWorkspaceUri));
  const activeWorkspace = missingRouteWorkspace ? null : discoveredWorkspace;
  const activeUri = activeWorkspace?.uri ?? "";
  const activeGroupDid = activeWorkspace?.groupDid ?? null;
  const activeReportRules = useMemo<readonly ReportRuleOption[]>(
    () => (activeUri ? rulesByWorkspace[activeUri] ?? [] : []),
    [activeUri, rulesByWorkspace],
  );

  const activeGroupClient =
    activeGroupDid && groupClientState?.groupDid === activeGroupDid ? groupClientState.client : null;

  const refreshActiveGroupClient = useCallback(async () => {
    setGroupClientSeq((s) => s + 1);
  }, []);

  useEffect(() => {
    if (!groupOAuth || !activeGroupDid) return;
    let cancelled = false;
    const targetGroupDid = activeGroupDid;
    void groupOAuth.restoreGroupClient(targetGroupDid).then(
      (gc) => {
        if (!cancelled) setGroupClientState({ groupDid: targetGroupDid, client: gc });
      },
      () => {
        if (!cancelled) setGroupClientState({ groupDid: targetGroupDid, client: null });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [groupOAuth, activeGroupDid, groupClientSeq]);
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
        const linked = toPermalinkMessage(found);
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
  const createWorkspaceNamed = useCallback(async (creationInput: WorkspaceCreationInput, options: { mayAuthorize: boolean }) => {
    await executeBrowserWorkspaceCreation(creationInput, {
      mayAuthorize: options.mayAuthorize,
      engine,
      storage: sessionStorage,
      refreshWorkspaces,
      approveAuthority,
      onWorkspaceSelected: (wsUri) => {
        setChosenWorkspace(wsUri);
        resetChannelInput();
      },
      setStatus,
      setError,
      setBusy,
    });
  }, [engine, approveAuthority, resetChannelInput, refreshWorkspaces]);

  useEffect(() => {
    // Back from the permission screen restores this page as it was left. The resume flags must not
    // survive to auto-run later, and the form must be usable again.
    const onPageShow = (event: PageTransitionEvent) => {
      if (!event.persisted) return;
      sessionStorage.removeItem("spaces.autoCreateWorkspace");
      sessionStorage.removeItem("spaces.pendingWorkspaceName");
      sessionStorage.removeItem("spaces.pendingJoinPolicy");
      sessionStorage.removeItem("spaces.pendingPublicMeta");
      sessionStorage.removeItem("spaces.pendingReactivateOp");
      void abortUnstartedWorkspaceCreation(engine?.workspaces, sessionStorage).then(() =>
        refreshWorkspaces().catch(() => undefined),
      );
      setBusy(false);
      setStatus("");
    };
    window.addEventListener("pageshow", onPageShow);
    return () => window.removeEventListener("pageshow", onPageShow);
  }, [engine, refreshWorkspaces]);

  useEffect(() => {
    // What arrives in the URL is taken before the browser session is ready, since connecting it leaves the page.
    const timer = window.setTimeout(() => {
      const search = window.location.search;
      const invitedWorkspace = captureInviteLink(search, sessionStorage) ?? sessionStorage.getItem(INVITE_LINK_KEY);
      const authorityFailed = new URLSearchParams(search).get("authority") === "failed";
      authorityFailedRef.current = authorityFailed;
      if (search.includes("invite=") || search.includes("authority=")) {
        const cleaned = sanitizeReturnTo(window.location.pathname, search);
        window.history.replaceState(null, "", cleaned ?? window.location.pathname);
      }
      if (invitedWorkspace) { setInvitedTo(invitedWorkspace); setInviteUri(invitedWorkspace); }
      // A workspace creation that was waiting on the approval reports the outcome itself when it retries.
      if (authorityFailed && !sessionStorage.getItem("spaces.autoCreateWorkspace")) {
        sessionStorage.removeItem("spaces.pendingReactivateOp");
        sessionStorage.removeItem("spaces.pendingReactivateGroup");
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
      const savedPolicyRaw = sessionStorage.getItem("spaces.pendingJoinPolicy");
      const savedPolicy: "invite" | "approval" | "open" =
        savedPolicyRaw === "open" || savedPolicyRaw === "approval" ? savedPolicyRaw : "invite";
      const savedPublicMeta = sessionStorage.getItem("spaces.pendingPublicMeta") !== "0";
      if (savedName) {
        setWorkspaceName(savedName);
        setJoinPolicy(savedPolicy);
        setPublicMeta(savedPublicMeta);
        sessionStorage.removeItem("spaces.pendingWorkspaceName");
      }
      sessionStorage.removeItem("spaces.pendingJoinPolicy");
      sessionStorage.removeItem("spaces.pendingPublicMeta");
      const hadAutoCreate = Boolean(sessionStorage.getItem("spaces.autoCreateWorkspace"));
      if (hadAutoCreate) {
        sessionStorage.removeItem("spaces.autoCreateWorkspace");
        if (savedName) {
          void createWorkspaceNamed(
            { name: savedName, joinPolicy: savedPolicy, publicMeta: savedPublicMeta },
            { mayAuthorize: false },
          );
        }
      } else if (authorityFailedRef.current) {
        void abortUnstartedWorkspaceCreation(engine.workspaces, sessionStorage).then(() =>
          refreshWorkspaces().catch(() => undefined),
        );
      }
      const rawPendingReactivateOp = sessionStorage.getItem("spaces.pendingReactivateOp");
      const savedReactivateDid = sessionStorage.getItem("spaces.pendingReactivateGroup");
      sessionStorage.removeItem("spaces.pendingReactivateOp");
      sessionStorage.removeItem("spaces.pendingReactivateGroup");
      if (!authorityFailedRef.current) {
        let resumeTarget: { groupDid: string; operationId?: string; mayAuthorize: boolean } | null = null;
        if (rawPendingReactivateOp) {
          try {
            const parsed = JSON.parse(rawPendingReactivateOp) as { groupDid?: unknown; operationId?: unknown };
            if (isDid(parsed.groupDid)) {
              resumeTarget = {
                groupDid: parsed.groupDid,
                ...(typeof parsed.operationId === "string" && parsed.operationId ? { operationId: parsed.operationId } : {}),
                mayAuthorize: false,
              };
            }
          } catch {
            // ignore malformed sessionStorage value
          }
        }
        if (!resumeTarget && savedReactivateDid && isDid(savedReactivateDid)) {
          resumeTarget = { groupDid: savedReactivateDid, mayAuthorize: true };
        }
        if (resumeTarget) {
          const { groupDid: targetGroupDid, operationId: targetOpId, mayAuthorize } = resumeTarget;
          const effectiveOpId = targetOpId ?? makeTid();
          setReactivateDid(targetGroupDid);
          let redirecting = false;
          void engine.workspaces
            .reactivateGroup(targetGroupDid, {
              operationId: effectiveOpId,
              reauthorizeOperator: async (gDid) => {
                if (!mayAuthorize) return;
                sessionStorage.setItem(
                  "spaces.pendingReactivateOp",
                  JSON.stringify({ groupDid: gDid, operationId: effectiveOpId }),
                );
                setStatus("Opening the permission screen to reauthorize Operator for this group…");
                await approveAuthority({ purpose: "reauthorize", authority: gDid });
                redirecting = true;
              },
            })
            .then(async (res) => {
              sessionStorage.removeItem(`spaces.reauthAttempted:${targetGroupDid}`);
              await refreshWorkspaces();
              setChosenWorkspace(res.workspace);
              setReactivateDid("");
              setStatus(`Reactivated group ${targetGroupDid}.`);
            })
            .catch((caught: unknown) => {
              if (redirecting && needsAuthorityApproval(caught)) return;
              setStatus("");
              setError(messageOf(caught));
            });
        }
      }
      setPendingOperations(readPendingOperatorOperations(sessionStorage));
    }, 0);
    return () => window.clearTimeout(timer);
  }, [engine, createWorkspaceNamed, approveAuthority, refreshWorkspaces]);

  const admin = useAdminViews(session, activeWorkspace);
  const inboxView = admin.inbox.value;
  const stalledWork = admin.stalled.value;
  // A view that failed to load in the background (the change feed's or the minute's) is shown like any other failure.
  const backgroundFailure = [discovered.error, admin.inbox.error, admin.stalled.error].find((failure) => failure !== undefined);
  const shownError = error || (backgroundFailure === undefined ? "" : messageOf(backgroundFailure));

  useEffect(() => {
    // A read the account was refused (removed, the channel archived or paused) has the selection follow the workspace now.
    if (contentRefused) void refreshWorkspaces().catch((caught) => setError(messageOf(caught)));
  }, [contentRefused, refreshWorkspaces]);

  async function createWorkspace(event: FormEvent) {
    event.preventDefault();
    await createWorkspaceNamed(
      workspaceCreationFrom({ name: workspaceName, account: "", joinPolicy, publicMeta }, did),
      { mayAuthorize: true },
    );
  }

  async function connectInvitation(rawInput: string) {
    if (busy || !engine) return;
    const parsed = parsePastedGroupOrWorkspace(rawInput);
    if (!parsed) {
      setError(`Paste a Group DID (did:plc:…) or workspace URI in the form at://DID/space/${SPACE_TYPE.workspace}/self.`);
      return;
    }
    const trimmedMessage = joinMessage.trim();
    if (parsePastedWorkspaceUri(rawInput) && !trimmedMessage) {
      // First attempt direct acceptance (for admin-pre-admitted invite links); if not yet admitted, fall through to requestJoin!
      setBusy(true);
      setError("");
      try {
        await engine.workspaces.accept(parsed.workspaceUri);
        setStatus("Workspace invitation accepted. Loading shared records…");
        const current = await refreshWorkspaces();
        if (current?.workspaces.some((entry) => entry.uri === parsed.workspaceUri)) {
          setChosenWorkspace(parsed.workspaceUri);
          resetChannelInput();
          setInviteUri("");
          setInvitedTo((cur) => (cur === parsed.workspaceUri ? null : cur));
          if (sessionStorage.getItem(INVITE_LINK_KEY) === parsed.workspaceUri) sessionStorage.removeItem(INVITE_LINK_KEY);
          setBusy(false);
          return;
        }
      } catch (acceptErr) {
        // Fall through to OpenSocial requestJoin (open / approval group) if not yet in members/self
        if (!isAccessFailure(acceptErr)) {
          setError(acceptFailure(acceptErr)?.error ?? messageOf(acceptErr));
          setBusy(false);
          return;
        }
      }
      setBusy(false);
    }

    setBusy(true);
    setError("");
    try {
      const profile = await engine.workspaces.tryReadPublicGroupProfile(parsed.groupDid);
      const mode = profile?.joinPolicy === "approval" || trimmedMessage ? "approval" : "open";
      const joined = await engine.workspaces.joinGroup({
        groupDid: parsed.groupDid,
        mode,
        ...(trimmedMessage ? { message: trimmedMessage } : {}),
      });
      await refreshWorkspaces();
      if (joined.status === "admitted") {
        setChosenWorkspace(joined.workspace);
        resetChannelInput();
        setInviteUri("");
        setJoinMessage("");
        setInvitedTo((cur) => (cur === joined.workspace ? null : cur));
        if (sessionStorage.getItem(INVITE_LINK_KEY) === joined.workspace) sessionStorage.removeItem(INVITE_LINK_KEY);
        setStatus("Joined group on AT Protocol.");
      } else {
        setJoinMessage("");
        setStatus("Join request submitted — awaiting moderator approval.");
      }
    } catch (caught) {
      setError(acceptFailure(caught)?.error ?? messageOf(caught));
    } finally {
      setBusy(false);
    }
  }

  async function acceptCrossPdsInvite(invite: ReceivedGroupInvite) {
    if (busy || !engine) return;
    setBusy(true);
    setError("");
    try {
      const res = await engine.workspaces.joinGroup({
        groupDid: invite.groupDid,
        mode: "invite",
        inviteUri: invite.uri,
      });
      await refreshWorkspaces();
      setChosenWorkspace(res.workspace);
      resetChannelInput();
      setStatus(`Accepted invitation to ${invite.groupName ?? invite.groupDid}.`);
    } catch (caught) {
      setError(messageOf(caught));
    } finally {
      setBusy(false);
    }
  }

  async function startReactivateGroup(targetDid: string) {
    const cleaned = targetDid.trim();
    if (!isDid(cleaned)) {
      setError("Enter a valid Group DID (did:plc:… or did:web:…).");
      return;
    }
    if (!engine || !groupOAuth) return;
    let redirecting = false;
    setBusy(true);
    setError("");
    sessionStorage.removeItem(`spaces.reauthAttempted:${cleaned}`);
    try {
      const existingClient = await groupOAuth.restoreGroupClient(cleaned);
      if (!existingClient) {
        sessionStorage.setItem("spaces.pendingReactivateGroup", cleaned);
        const url = await groupOAuth.authorizeGroup({
          groupOrHost: cleaned,
          roleScope: "admin",
          prompt: "login",
          appState: {
            returnTo: window.location.pathname,
            purpose: "recovery",
            groupDid: cleaned,
          },
        });
        window.location.assign(url.toString());
        redirecting = true;
        return;
      }
      const operationId = makeTid();
      const res = await engine.workspaces.reactivateGroup(cleaned, {
        operationId,
        reauthorizeOperator: async (gDid) => {
          sessionStorage.setItem(
            "spaces.pendingReactivateOp",
            JSON.stringify({ groupDid: gDid, operationId }),
          );
          setStatus("Opening the permission screen to reauthorize Operator for this group…");
          await approveAuthority({ purpose: "reauthorize", authority: gDid });
          redirecting = true;
        },
      });
      sessionStorage.removeItem("spaces.pendingReactivateOp");
      sessionStorage.removeItem(`spaces.reauthAttempted:${cleaned}`);
      await refreshWorkspaces();
      setChosenWorkspace(res.workspace);
      setReactivateDid("");
      setStatus(`Reactivated group ${cleaned}.`);
    } catch (caught) {
      if (redirecting && needsAuthorityApproval(caught)) return;
      sessionStorage.removeItem("spaces.pendingReactivateOp");
      setStatus("");
      setError(messageOf(caught));
    } finally {
      if (!redirecting) setBusy(false);
    }
  }

  async function beginReactivate(event: FormEvent) {
    event.preventDefault();
    await startReactivateGroup(reactivateDid);
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
    if (!workspace || operationInFlightRef.current) return false;
    if (activeWorkspace?.uri === workspace && activeWorkspace.degradedReasons.length) {
      setError(`Workspace mutations are paused in degraded mode. ${activeWorkspace.degradedReasons.join(" ")}`);
      return false;
    }
    operationInFlightRef.current = true;
    const pending = { workspace, operationId, request };
    setPendingOperations(upsertPendingOperatorOperation(sessionStorage, pending));
    setBusy(true); setError(""); setStatus("Submitting workspace operation…");
    try {
      if (!engine?.operator) throw new Error("Connect this browser first.");
      const { operation } = await engine.operator.execute(pending);
      setStatus(request.kind === "inviteMember" && operation.state === "completed"
        ? `Added ${String(request.subject)}. Send them an invite link (use “Copy invite link”) so they can find and join the workspace.`
        : `Operation ${operation.state}; ${operation.completedSteps.length} steps recorded.${operation.error ? ` ${operation.error}` : ""}`);
      if (
        operation.state === "completed" ||
        operation.state === "failed" ||
        operation.state === "aborted_actor_revoked"
      ) {
        setPendingOperations(clearPendingOperatorOperation(sessionStorage, operationId));
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
    } finally {
      operationInFlightRef.current = false;
      setBusy(false);
    }
  }

  async function toggleExtension(extId: ExtensionId, enable: boolean): Promise<ExtensionToggleOutcome> {
    if (!activeWorkspace || operationInFlightRef.current) return { kind: "failed" };
    if (activeWorkspace.degradedReasons.length) {
      setError(`Workspace mutations are paused in degraded mode. ${activeWorkspace.degradedReasons.join(" ")}`);
      return { kind: "failed" };
    }
    operationInFlightRef.current = true;
    const workspace = activeWorkspace.uri;
    const operationId = makeTid();
    const request = { kind: enable ? "enableExtension" : "disableExtension", extId } as const;
    const pending = { workspace, operationId, request };
    setPendingOperations(upsertPendingOperatorOperation(sessionStorage, pending));
    setBusy(true);
    setError("");
    setStatus(enable ? `Enabling ${extId} extension…` : `Disabling ${extId} extension…`);
    try {
      if (!engine?.operator) throw new Error("Connect this browser first.");
      const { operation } = enable
        ? await engine.operator.enableExtension(workspace, extId, operationId)
        : await engine.operator.disableExtension(workspace, extId, operationId);
      setStatus(`Operation ${operation.state}; ${operation.completedSteps.length} steps recorded.${operation.error ? ` ${operation.error}` : ""}`);
      if (
        operation.state === "completed" ||
        operation.state === "failed" ||
        operation.state === "aborted_actor_revoked"
      ) {
        setPendingOperations(clearPendingOperatorOperation(sessionStorage, operationId));
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
      operationInFlightRef.current = false;
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
    if (!engine || !activeWorkspace || did === activeWorkspace.authorityDid) return;
    setBusy(true);
    setError("");
    setStatus("Leaving workspace…");
    try {
      await engine.workspaces.leaveGroup(activeWorkspace.groupDid);
      await refreshWorkspaces();
      setStatus("Left workspace.");
      const liveRoute = typeof window === "undefined" ? parsedRoute : parseRoute(window.location.pathname, window.location.search);
      if (liveRoute && liveRoute.kind !== "home" && "workspaceUri" in liveRoute && liveRoute.workspaceUri === activeWorkspace.uri) {
        navigateTo(homeRoute());
      }
    } catch (caught) {
      setStatus("");
      setError(messageOf(caught));
    } finally {
      setBusy(false);
    }
  }

  async function submitModerationReport(input: {
    subject: string;
    cid?: string;
    reasonType: string;
    rule?: string;
    reason?: string;
  }) {
    if (!engine || !activeWorkspace) return;
    await engine.workspaces.createReport({
      groupDid: activeWorkspace.groupDid,
      ...input,
    });
  }

  function handleRulesChanged(loadedRules: GroupRule[]) {
    if (!activeUri) return;
    setRulesByWorkspace((prev) => ({
      ...prev,
      [activeUri]: loadedRules.map((r) => ({ uri: r.uri, title: r.title })),
    }));
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
          {invitesWarning && <div className="operation-alert" role="status"><strong>{invitesWarning}</strong></div>}
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
              {crossPdsInvites.length > 0 && (
                <section className="starter-card" aria-label="Cross-PDS invitations">
                  <span className="eyebrow">GROUP INVITATIONS</span>
                  <h3>Pending cross-PDS invitations ({crossPdsInvites.length})</h3>
                  <div className="roster-list">
                    {crossPdsInvites.map((inv) => (
                      <div className="roster-row" key={inv.uri}>
                        <span>
                          <strong>{inv.groupName ?? inv.groupDid}</strong>
                          {inv.groupDescription ? ` — ${inv.groupDescription}` : ""}
                          {inv.message ? ` · “${inv.message}”` : ""}
                          {inv.expiresAt ? ` · expires ${inv.expiresAt}` : ""}
                        </span>
                        <button
                          type="button"
                          className="primary-button"
                          disabled={busy}
                          onClick={() => void acceptCrossPdsInvite(inv)}
                        >
                          Accept invite
                        </button>
                      </div>
                    ))}
                  </div>
                </section>
              )}
              {joiningGroups.length > 0 && engine && (
                <section className="starter-card" aria-label="Pending group join operations">
                  <span className="eyebrow">GROUP JOIN STATUS</span>
                  <div className="roster-list">
                    {joiningGroups.map((entry) => (
                      <div className="roster-row" key={entry.operationId}>
                        <span>
                          <code>{entry.groupDid ?? entry.operationId}</code> ·{" "}
                          {entry.mode === "create"
                            ? `Creating workspace${entry.createParams?.name ? ` "${entry.createParams.name}"` : ""} (${entry.phase})`
                            : entry.phase === "pending_approval"
                              ? "Awaiting moderator approval"
                              : entry.phase === "orphaned_by_migration"
                                ? "Group moved hosts — re-request to join"
                                : entry.phase === "expired_unknown"
                                  ? "Join request expired — re-request to join"
                                  : entry.phase === "unsupported_status"
                                    ? `Unsupported join status (${entry.rawStatus ?? "unknown"})`
                                    : entry.phase === "quota_exceeded"
                                      ? "Join request rate limit reached (429)"
                                      : entry.phase}
                        </span>
                        <div>
                          {entry.mode === "create" && entry.createParams && (
                            <button
                              type="button"
                              className="primary-button"
                              disabled={busy}
                              onClick={() => {
                                sessionStorage.setItem(
                                  WORKSPACE_OPERATION_KEY,
                                  JSON.stringify({
                                    name: entry.createParams!.name,
                                    account: "",
                                    joinPolicy: entry.createParams!.joinPolicy ?? "invite",
                                    publicMeta: entry.createParams!.publicMeta ?? true,
                                    operationId: entry.operationId,
                                  }),
                                );
                                void createWorkspaceNamed(entry.createParams!, { mayAuthorize: true });
                              }}
                            >
                              Retry
                            </button>
                          )}
                          {entry.mode === "create" && entry.phase === "submitting" && !entry.groupDid && (
                            <button
                              type="button"
                              className="text-button"
                              disabled={busy}
                              onClick={() =>
                                void engine.workspaces
                                  .dismissUnstartedCreateOperation(entry.operationId)
                                  .then((outcome) => {
                                    if (outcome !== "in_progress") {
                                      const raw = sessionStorage.getItem(WORKSPACE_OPERATION_KEY);
                                      if (raw && raw.includes(entry.operationId)) {
                                        sessionStorage.removeItem(WORKSPACE_OPERATION_KEY);
                                      }
                                    }
                                    return refreshWorkspaces();
                                  })
                                  .catch((err: unknown) => setError(messageOf(err)))
                              }
                            >
                              Dismiss
                            </button>
                          )}
                          {entry.phase === "pending_approval" && entry.groupDid && (
                            <button
                              type="button"
                              className="text-button danger"
                              disabled={busy}
                              onClick={() =>
                                void engine.workspaces
                                  .cancelJoinRequest(entry.groupDid!)
                                  .then(() => refreshWorkspaces())
                                  .catch((err: unknown) => setError(messageOf(err)))
                              }
                            >
                              Cancel request
                            </button>
                          )}
                          {(entry.phase === "orphaned_by_migration" ||
                            entry.phase === "expired_unknown" ||
                            entry.phase === "quota_exceeded") && (
                            <button
                              type="button"
                              className="primary-button"
                              disabled={busy}
                              onClick={() =>
                                void engine.workspaces
                                  .retryJoinOperation(entry.operationId)
                                  .then(() => refreshWorkspaces())
                                  .catch((err: unknown) => setError(messageOf(err)))
                              }
                            >
                              {entry.phase === "quota_exceeded" ? "Retry" : "Re-request"}
                            </button>
                          )}
                          {(entry.phase === "orphaned_by_migration" ||
                            entry.phase === "expired_unknown" ||
                            entry.phase === "unsupported_status" ||
                            entry.phase === "quota_exceeded") && (
                            <button
                              type="button"
                              className="text-button"
                              disabled={busy}
                              onClick={() =>
                                void engine.workspaces
                                  .dismissJoinOperation(entry.operationId)
                                  .then(() => refreshWorkspaces())
                                  .catch((err: unknown) => setError(messageOf(err)))
                              }
                            >
                              Dismiss
                            </button>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                </section>
              )}
              {leavingGroups.filter((l) => l.phase === "blocked_deactivated").map((leaveEntry) => (
                <div className="starter-card lifecycle-card" key={leaveEntry.groupDid}>
                  <p>
                    Leaving <code>{leaveEntry.groupDid}</code> is paused while the group is deactivated.
                  </p>
                  <button
                    type="button"
                    className="text-button"
                    disabled={busy}
                    onClick={() => void startReactivateGroup(leaveEntry.groupDid)}
                  >
                    Reactivate group →
                  </button>
                </div>
              ))}
              {missingRouteWorkspace ? (
                <div className="starter-card">
                  <p className="form-error" role="alert">Workspace not found or you do not have access to it.</p>
                  <button type="button" className="text-button" onClick={() => navigateTo(homeRoute())}>Back to your spaces →</button>
                </div>
              ) : !activeWorkspace ? (
                workspacesLoaded || parsedRoute.kind === "home" ? (
                  <WorkspaceOnboarding
                    busy={busy}
                    workspaceName={workspaceName}
                    setWorkspaceName={setWorkspaceName}
                    joinPolicy={joinPolicy}
                    setJoinPolicy={setJoinPolicy}
                    publicMeta={publicMeta}
                    setPublicMeta={setPublicMeta}
                    inviteUri={inviteUri}
                    setInviteUri={setInviteUri}
                    joinMessage={joinMessage}
                    setJoinMessage={setJoinMessage}
                    reactivateDid={reactivateDid}
                    setReactivateDid={setReactivateDid}
                    createWorkspace={createWorkspace}
                    beginAccept={beginAccept}
                    beginReactivate={beginReactivate}
                  />
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
                  onReportSubject={submitModerationReport}
                  reportRules={activeReportRules}
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
                  onReportSubject={submitModerationReport}
                  reportRules={activeReportRules}
                  onReported={() => setStatus("Report submitted to group moderators.")}
                  setError={setError}
                />
              ) : (
                <WorkspaceHome
                  did={did}
                  engine={engine}
                  groupClient={activeGroupClient}
                  groupOAuth={groupOAuth}
                  returnTo={routeKey}
                  apps={appDirectory}
                  activeWorkspace={activeWorkspace}
                  declarations={activeDeclarations}
                  busy={busy}
                  workspaceDegraded={workspaceDegraded}
                  inbox={inboxView?.requests ?? []}
                  inboxLoaded={inboxView !== undefined && !inboxView.refused}
                  inboxPermissionMissing={inboxView?.refused === true}
                  reportRules={activeReportRules}
                  onRulesChanged={handleRulesChanged}
                  onReportSubject={submitModerationReport}
                  onGroupClientChanged={refreshActiveGroupClient}
                  onWorkspaceMutated={async () => {
                    await refreshWorkspaces();
                  }}
                  onGroupDeleted={() => {
                    void refreshWorkspaces();
                    navigateTo(homeRoute());
                  }}
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
