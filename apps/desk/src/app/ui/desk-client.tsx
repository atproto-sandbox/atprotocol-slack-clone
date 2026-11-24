"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Badge, Banner, Button, Card, Divider, Heading, HStack, Text, TextInput, VStack } from "@astryxdesign/core";
import {
  listIndependentWorkspaces,
  readIndependentChannelPage,
  readIndependentInvites,
  readIndependentPrivateRoster,
  readIndependentWorkspace,
  type IndependentChannelPage,
  type IndependentInvite,
  type IndependentWorkspace,
} from "@flock/reader/independent";
import {
  cancelPendingJoin,
  createBrowserSpaceCredentialDeps,
  dismissJoinOperation,
  ensureInvitesSpace,
  IncompatibleInvitesSpacePolicyError,
  IndexedDbLifecycleStore,
  joinGroup,
  leaveGroup,
  PASSIVE_JOIN_PHASES,
  readGroupModerationConfig,
  reconcileLifecycle,
  restoreDeskSession,
  retryJoinOperation,
  signInDesk,
  signOutDesk,
  type DeskJoiningGroupEntry,
  type DeskLeavingGroupEntry,
  type DeskSessionConfig,
  type DeskShellDeps,
  type GroupModerationConfig,
} from "@flock/shell";
import { DeskChannelView } from "./desk-channel-view";
import { DeskReportPanel, type ReportTarget } from "./desk-report-panel";
import {
  clearPendingInvite,
  loadPendingInvite,
  parseInviteTarget,
  savePendingInvite,
} from "./pending-invite";

export type DeskPublicConfig = DeskSessionConfig;

export function DeskClient({
  config,
  initialInviteUri,
}: {
  config: DeskPublicConfig;
  initialInviteUri?: string | null;
}) {
  const [authState, setAuthState] = useState<"checking" | "signed_out" | "signed_in">("checking");
  const [handleInput, setHandleInput] = useState("");
  const [signingIn, setSigningIn] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [syncError, setSyncError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [pendingInviteUri, setPendingInviteUri] = useState<string | null>(() => {
    const parsed = parseInviteTarget(initialInviteUri);
    return parsed ? parsed.workspaceUri : null;
  });

  const depsRef = useRef<DeskShellDeps | null>(null);
  const storeRef = useRef<IndexedDbLifecycleStore | null>(null);
  const generationRef = useRef(0);
  const refreshSeqRef = useRef(0);
  const activeSelectionRef = useRef<{ wsUri: string | null; channelSkey: string | null }>({
    wsUri: null,
    channelSkey: null,
  });
  const invitesProvisionedRef = useRef(false);
  const [depsState, setDepsState] = useState<DeskShellDeps | null>(null);

  const [viewerDid, setViewerDid] = useState<string | null>(null);
  const [workspaces, setWorkspaces] = useState<IndependentWorkspace[]>([]);
  const [invites, setInvites] = useState<IndependentInvite[]>([]);
  const [invitesStatus, setInvitesStatus] = useState<"loading" | "ready" | "incompatible" | "error">("loading");
  const [invitesError, setInvitesError] = useState<string | null>(null);
  const [joiningOps, setJoiningOps] = useState<DeskJoiningGroupEntry[]>([]);
  const [leavingOps, setLeavingOps] = useState<DeskLeavingGroupEntry[]>([]);

  const [selectedWorkspaceUri, setSelectedWorkspaceUri] = useState<string | null>(null);
  const [activeWorkspace, setActiveWorkspace] = useState<IndependentWorkspace | null>(null);
  const [selectedChannelSkey, setSelectedChannelSkey] = useState<string | null>(null);
  const [channelPage, setChannelPage] = useState<IndependentChannelPage | null>(null);
  const [privateRoster, setPrivateRoster] = useState<string[] | null>(null);
  const [moderationConfig, setModerationConfig] = useState<GroupModerationConfig | null>(null);
  const [moderationError, setModerationError] = useState<string | null>(null);

  const [joinTargetInput, setJoinTargetInput] = useState("");
  const [joinMessageInput, setJoinMessageInput] = useState("");
  const [accountReportTarget, setAccountReportTarget] = useState<ReportTarget | null>(null);

  const [refreshing, setRefreshing] = useState(false);
  const [channelLoading, setChannelLoading] = useState(false);
  const [actionBusy, setActionBusy] = useState(false);

  // Sync URL invite parameter into sessionStorage so it survives the PDS OAuth redirect.
  useEffect(() => {
    const fromProp = parseInviteTarget(initialInviteUri);
    if (fromProp) {
      savePendingInvite(fromProp.workspaceUri);
    }
  }, [initialInviteUri]);

  const loadWorkspaceDetail = useCallback(
    async (wsUri: string, channelSkey: string | null, expectedGen?: number) => {
      const deps = depsRef.current;
      if (!deps) return;
      const gen = expectedGen ?? ++generationRef.current;
      if (channelSkey) {
        setChannelLoading(true);
      }
      try {
        const detail = await readIndependentWorkspace(deps, wsUri);
        if (gen !== generationRef.current) return;
        setActiveWorkspace(detail);
        if (!detail) {
          setChannelPage(null);
          setPrivateRoster(null);
          setModerationConfig(null);
          setModerationError(null);
          return;
        }
        try {
          const modCfg = await readGroupModerationConfig(deps, detail.groupDid);
          if (gen !== generationRef.current) return;
          setModerationConfig(modCfg);
          setModerationError(null);
        } catch (modErr) {
          if (gen !== generationRef.current) return;
          setModerationConfig(null);
          setModerationError(
            modErr instanceof Error
              ? `Moderation configuration unavailable (${modErr.message}); reporting is disabled until it loads.`
              : "Moderation configuration unavailable; reporting is disabled until it loads.",
          );
        }

        if (channelSkey) {
          const channel = detail.channels.find((c) => c.skey === channelSkey);
          if (channel) {
            const [page, roster] = await Promise.all([
              readIndependentChannelPage(deps, wsUri, channel.skey),
              channel.visibility === "private"
                ? readIndependentPrivateRoster(deps, wsUri, channel.skey)
                : Promise.resolve(null),
            ]);
            if (gen !== generationRef.current) return;
            setChannelPage(page);
            setPrivateRoster(roster);
            return;
          }
        }
        setChannelPage(null);
        setPrivateRoster(null);
      } catch (caught) {
        if (gen !== generationRef.current) return;
        setActiveWorkspace(null);
        setChannelPage(null);
        setPrivateRoster(null);
        setModerationConfig(null);
        setModerationError(null);
        setSyncError(caught instanceof Error ? caught.message : "Failed to load workspace details.");
      } finally {
        if (gen === generationRef.current) {
          setChannelLoading(false);
        }
      }
    },
    [],
  );

  const ensureInvitesReady = useCallback(async (deps: DeskShellDeps, gen: number): Promise<boolean> => {
    if (invitesProvisionedRef.current) return true;
    try {
      await ensureInvitesSpace(deps);
      if (gen !== generationRef.current) return false;
      invitesProvisionedRef.current = true;
      return true;
    } catch (invErr) {
      if (gen !== generationRef.current) return false;
      if (invErr instanceof IncompatibleInvitesSpacePolicyError) {
        setInvitesStatus("incompatible");
        setInvitesError(invErr.message);
      } else {
        setInvitesStatus("error");
        setInvitesError(
          invErr instanceof Error ? invErr.message : "Could not verify personal invites space.",
        );
      }
      return false;
    }
  }, []);

  const refreshAll = useCallback(
    async (preferWorkspaceUri?: string | null) => {
      const deps = depsRef.current;
      const store = storeRef.current;
      if (!deps || !store) return;
      const gen = ++generationRef.current;
      const refreshSeq = ++refreshSeqRef.current;
      setRefreshing(true);
      setSyncError(null);
      try {
        const reconcileResult = await reconcileLifecycle(deps, store);
        if (gen !== generationRef.current) return;

        const invitesReady = await ensureInvitesReady(deps, gen);
        if (gen !== generationRef.current) return;

        const [wsList, joins, leaves, invitesOutcome] = await Promise.all([
          listIndependentWorkspaces(deps),
          store.listJoiningGroups(),
          store.listLeavingGroups(),
          invitesReady
            ? readIndependentInvites(deps, deps.did).then(
                (items) => ({ ok: true as const, items }),
                (err: unknown) => ({ ok: false as const, err }),
              )
            : Promise.resolve(null),
        ]);
        if (gen !== generationRef.current) return;

        setWorkspaces(wsList);
        setJoiningOps(joins);
        setLeavingOps(leaves);

        if (invitesOutcome !== null) {
          if (invitesOutcome.ok) {
            setInvites(invitesOutcome.items);
            setInvitesStatus("ready");
            setInvitesError(null);
          } else {
            // Preserve last-known invites on transient read error so expiring invites never vanish silently.
            setInvitesStatus("error");
            setInvitesError(
              invitesOutcome.err instanceof Error
                ? invitesOutcome.err.message
                : "Failed to read personal invites.",
            );
          }
        }

        const reconcileMessages = [
          ...reconcileResult.leaveErrors.map(
            (entry) =>
              `leave ${entry.groupDid}: ${entry.error instanceof Error ? entry.error.message : String(entry.error)}`,
          ),
          ...reconcileResult.joinErrors.map(
            (entry) =>
              `join ${entry.operationId}: ${entry.error instanceof Error ? entry.error.message : String(entry.error)}`,
          ),
        ];
        if (reconcileMessages.length > 0) {
          setSyncError(reconcileMessages.join(" · "));
        }

        const storedInvite = loadPendingInvite();
        if (storedInvite && wsList.some((w) => w.uri === storedInvite)) {
          clearPendingInvite();
          setPendingInviteUri(null);
        }

        const nextWsUri =
          preferWorkspaceUri && wsList.some((w) => w.uri === preferWorkspaceUri)
            ? preferWorkspaceUri
            : selectedWorkspaceUri && wsList.some((w) => w.uri === selectedWorkspaceUri)
              ? selectedWorkspaceUri
              : storedInvite && wsList.some((w) => w.uri === storedInvite)
                ? storedInvite
                : (wsList[0]?.uri ?? null);

        setSelectedWorkspaceUri(nextWsUri);
        if (nextWsUri) {
          const switchedWorkspace = nextWsUri !== selectedWorkspaceUri;
          const nextChannel = switchedWorkspace ? null : selectedChannelSkey;
          activeSelectionRef.current = { wsUri: nextWsUri, channelSkey: nextChannel };
          setSelectedChannelSkey(nextChannel);
          if (switchedWorkspace) {
            setActiveWorkspace(null);
            setChannelPage(null);
            setPrivateRoster(null);
            setModerationConfig(null);
            setModerationError(null);
            setAccountReportTarget(null);
          }
          await loadWorkspaceDetail(nextWsUri, nextChannel, gen);
        } else {
          activeSelectionRef.current = { wsUri: null, channelSkey: null };
          setActiveWorkspace(null);
          setSelectedChannelSkey(null);
          setChannelPage(null);
          setPrivateRoster(null);
          setModerationConfig(null);
          setModerationError(null);
        }
      } catch (caught) {
        if (gen !== generationRef.current) return;
        setSyncError(caught instanceof Error ? caught.message : "Failed to refresh workspaces.");
      } finally {
        if (refreshSeq === refreshSeqRef.current) {
          setRefreshing(false);
        }
      }
    },
    [ensureInvitesReady, loadWorkspaceDetail, selectedChannelSkey, selectedWorkspaceUri],
  );

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const storedInvite = loadPendingInvite();
        if (!cancelled && storedInvite && !parseInviteTarget(initialInviteUri)) {
          setPendingInviteUri(storedInvite);
        }
        const session = await restoreDeskSession(config);
        if (cancelled) return;
        if (!session) {
          setAuthState("signed_out");
          return;
        }
        const loopbackAllowed = new URL(config.appUrl).protocol === "http:";
        const deps = createBrowserSpaceCredentialDeps(session, {
          plcUrl: config.plcUrl,
          loopbackAllowed,
        });
        await IndexedDbLifecycleStore.deleteOtherAccounts(session.did).catch(() => undefined);
        const store = await IndexedDbLifecycleStore.open(session.did);
        if (cancelled) {
          store.close();
          return;
        }
        depsRef.current = deps;
        storeRef.current = store;
        invitesProvisionedRef.current = false;
        setDepsState(deps);
        setViewerDid(session.did);
        setAuthState("signed_in");

        await refreshAll();
      } catch (caught) {
        if (cancelled) return;
        setError(caught instanceof Error ? caught.message : "Could not restore session.");
        setAuthState("signed_out");
      }
    })();
    return () => {
      cancelled = true;
      generationRef.current += 1;
      storeRef.current?.close();
      storeRef.current = null;
    };
    // Run once on mount for the page's config
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config.appUrl, config.plcUrl, config.scope]);

  async function handleSignIn(event: React.FormEvent) {
    event.preventDefault();
    const target = handleInput.trim();
    if (!target) return;
    setSigningIn(true);
    setError(null);
    if (pendingInviteUri) {
      savePendingInvite(pendingInviteUri);
    }
    try {
      await signInDesk(target, config);
    } catch (caught) {
      setSigningIn(false);
      setError(caught instanceof Error ? caught.message : "Sign-in failed.");
    }
  }

  async function handleSignOut() {
    setActionBusy(true);
    setError(null);
    setSyncError(null);
    generationRef.current += 1;
    refreshSeqRef.current += 1;
    activeSelectionRef.current = { wsUri: null, channelSkey: null };
    setRefreshing(false);
    try {
      await signOutDesk(config, {
        lifecycleStore: storeRef.current,
        ...(viewerDid ? { viewerDid } : {}),
      });
      generationRef.current += 1;
      storeRef.current = null;
      depsRef.current = null;
      invitesProvisionedRef.current = false;
      setDepsState(null);
      setViewerDid(null);
      setWorkspaces([]);
      setInvites([]);
      setInvitesStatus("loading");
      setInvitesError(null);
      setJoiningOps([]);
      setLeavingOps([]);
      setSelectedWorkspaceUri(null);
      setActiveWorkspace(null);
      setSelectedChannelSkey(null);
      setChannelPage(null);
      setPrivateRoster(null);
      setModerationConfig(null);
      setModerationError(null);
      setPendingInviteUri(null);
      setAuthState("signed_out");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Sign-out failed.");
    } finally {
      setActionBusy(false);
    }
  }

  async function handleJoinGroup(input: { groupDid: string; inviteUri?: string; message?: string }): Promise<boolean> {
    const deps = depsRef.current;
    const store = storeRef.current;
    if (!deps || !store) return false;
    setActionBusy(true);
    setError(null);
    setNotice(null);
    try {
      const result = await joinGroup(deps, store, input);
      clearPendingInvite();
      setPendingInviteUri(null);
      if (result.status === "admitted") {
        setNotice(`Joined workspace ${result.workspaceUri}.`);
        await refreshAll(result.workspaceUri);
      } else if (result.status === "pending") {
        setNotice(`Join request submitted for ${input.groupDid} (awaiting approval).`);
        await refreshAll();
      } else {
        setNotice(`Join request status: ${result.status}.`);
        await refreshAll();
      }
      return true;
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not join group.");
      await refreshAll();
      return false;
    } finally {
      setActionBusy(false);
    }
  }

  async function handleManualJoinSubmit(event: React.FormEvent) {
    event.preventDefault();
    const parsed = parseInviteTarget(joinTargetInput, { allowBareDid: true });
    if (!parsed) {
      setError("Enter a valid workspace URI or group DID.");
      return;
    }
    const msg = joinMessageInput.trim();
    const ok = await handleJoinGroup({
      groupDid: parsed.groupDid,
      ...(msg.length > 0 ? { message: msg } : {}),
    });
    if (ok) {
      setJoinTargetInput("");
      setJoinMessageInput("");
    }
  }

  async function handleLeaveWorkspace(groupDid: string) {
    const deps = depsRef.current;
    const store = storeRef.current;
    if (!deps || !store) return;
    setActionBusy(true);
    setError(null);
    setNotice(null);
    try {
      await leaveGroup(deps, store, { groupDid });
      setNotice(`Left group ${groupDid}.`);
      await refreshAll(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not leave group.");
      await refreshAll();
    } finally {
      setActionBusy(false);
    }
  }

  async function handleCancelPending(groupDid: string) {
    const deps = depsRef.current;
    const store = storeRef.current;
    if (!deps || !store) return;
    setActionBusy(true);
    setError(null);
    try {
      await cancelPendingJoin(deps, store, { groupDid });
      setNotice(`Cancelled join request for ${groupDid}.`);
      await refreshAll();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not cancel join request.");
      await refreshAll();
    } finally {
      setActionBusy(false);
    }
  }

  async function handleRetryJoin(operationId: string) {
    const deps = depsRef.current;
    const store = storeRef.current;
    if (!deps || !store) return;
    setActionBusy(true);
    setError(null);
    try {
      const res = await retryJoinOperation(deps, store, operationId);
      setNotice(res.status === "admitted" ? `Joined ${res.workspaceUri}.` : `Join retry status: ${res.status}.`);
      await refreshAll(res.status === "admitted" ? res.workspaceUri : undefined);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Retry failed.");
      await refreshAll();
    } finally {
      setActionBusy(false);
    }
  }

  async function handleDismissJoin(operationId: string) {
    const deps = depsRef.current;
    const store = storeRef.current;
    if (!deps || !store) return;
    setActionBusy(true);
    setError(null);
    try {
      await dismissJoinOperation(deps, store, operationId);
      await refreshAll();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Dismiss failed.");
    } finally {
      setActionBusy(false);
    }
  }

  async function handleSelectWorkspace(wsUri: string) {
    activeSelectionRef.current = { wsUri, channelSkey: null };
    if (wsUri !== selectedWorkspaceUri) {
      setActiveWorkspace(null);
    }
    setSelectedWorkspaceUri(wsUri);
    setSelectedChannelSkey(null);
    setChannelPage(null);
    setPrivateRoster(null);
    setModerationConfig(null);
    setModerationError(null);
    setAccountReportTarget(null);
    await loadWorkspaceDetail(wsUri, null);
  }

  async function handleSelectChannel(skey: string) {
    if (!selectedWorkspaceUri) return;
    activeSelectionRef.current = { wsUri: selectedWorkspaceUri, channelSkey: skey };
    setSelectedChannelSkey(skey);
    setChannelPage(null);
    setPrivateRoster(null);
    setChannelLoading(true);
    setAccountReportTarget(null);
    await loadWorkspaceDetail(selectedWorkspaceUri, skey);
  }

  if (authState !== "signed_in") {
    const parsedInvite = parseInviteTarget(pendingInviteUri);
    return (
      <main className="desk-signin-stage" data-testid="desk-signin-stage">
        <Card maxWidth={500} width="100%" padding={6}>
          <VStack gap={4}>
            <HStack gap={2} align="center">
              <Heading level={1}>Flock Desk</Heading>
              <Badge label="Independent Client" variant="neutral" />
            </HStack>
            <Text color="secondary">
              Standalone OpenSocial &amp; ATProto Spaces client. Talks directly to your personal PDS and each Group Host with zero Operator server.
            </Text>

            {parsedInvite ? (
              <section
                role="region"
                aria-label="Workspace invitation"
                data-testid="desk-invite-banner"
              >
                <Banner
                  status="info"
                  title="Workspace invitation ready"
                  description={`Sign in to join ${parsedInvite.workspaceUri}`}
                />
              </section>
            ) : null}

            {error ? (
              <Banner status="error" title={error} role="alert" data-testid="desk-signin-error" />
            ) : null}

            <form onSubmit={handleSignIn}>
              <VStack gap={3}>
                <TextInput
                  label="ATProto handle or DID"
                  placeholder="alice.test or did:plc:..."
                  value={handleInput}
                  onChange={setHandleInput}
                  width="100%"
                  data-testid="desk-handle-input"
                />
                <Button
                  type="submit"
                  variant="primary"
                  label={
                    signingIn
                      ? "Redirecting to PDS…"
                      : authState === "checking"
                        ? "Checking session…"
                        : "Sign in with ATProto"
                  }
                  isDisabled={signingIn || authState === "checking"}
                  width="100%"
                  data-testid="desk-signin-button"
                />
              </VStack>
            </form>
          </VStack>
        </Card>
      </main>
    );
  }

  const parsedPendingInvite = parseInviteTarget(pendingInviteUri);
  const activeChannel =
    activeWorkspace && selectedChannelSkey
      ? activeWorkspace.channels.find((c) => c.skey === selectedChannelSkey) ?? null
      : null;
  const allowsAccountReports =
    moderationConfig !== null &&
    (!moderationConfig.labeler?.subjectTypes || moderationConfig.labeler.subjectTypes.includes("account")) &&
    (moderationConfig.labeler?.reasonTypes === undefined || moderationConfig.labeler.reasonTypes.length > 0);

  return (
    <div className="desk-workspace-grid" data-testid="desk-shell">
      <aside className="desk-rail" aria-label="Flock Desk navigation">
        <HStack justify="between" align="center">
          <Heading level={2}>Flock Desk</Heading>
          <Badge label="Direct" variant="neutral" />
        </HStack>
        <div className="desk-mono" data-testid="desk-viewer-did">
          {viewerDid}
        </div>
        <HStack gap={2}>
          <Button
            label={refreshing ? "Syncing…" : "Refresh"}
            variant="secondary"
            size="sm"
            isDisabled={refreshing}
            onClick={() => void refreshAll()}
            data-testid="desk-refresh-button"
          />
          <Button
            label="Sign out"
            variant="ghost"
            size="sm"
            isDisabled={actionBusy}
            onClick={() => void handleSignOut()}
            data-testid="desk-signout-button"
          />
        </HStack>

        <Divider />

        <div>
          <p className="desk-section-label">Workspaces</p>
          <nav aria-label="Workspaces" data-testid="desk-workspace-list">
            <VStack gap={1}>
              {workspaces.length === 0 ? (
                <Text color="secondary">No joined workspaces yet.</Text>
              ) : (
                workspaces.map((ws) => (
                  <button
                    key={ws.uri}
                    type="button"
                    className="desk-nav-button"
                    data-testid="desk-workspace-item"
                    data-active={ws.uri === selectedWorkspaceUri ? "true" : "false"}
                    onClick={() => void handleSelectWorkspace(ws.uri)}
                  >
                    <span>{ws.name}</span>
                  </button>
                ))
              )}
            </VStack>
          </nav>
        </div>

        {activeWorkspace ? (
          <div>
            <p className="desk-section-label">Channels</p>
            <nav aria-label="Channels" data-testid="desk-channel-nav">
              <VStack gap={1}>
                <button
                  type="button"
                  className="desk-nav-button"
                  data-testid="desk-home-nav-button"
                  data-active={selectedChannelSkey === null ? "true" : "false"}
                  onClick={() => void handleSelectWorkspace(activeWorkspace.uri)}
                >
                  <span>Workspace overview</span>
                </button>
                {activeWorkspace.channels.map((ch) => (
                  <button
                    key={ch.uri}
                    type="button"
                    className="desk-nav-button"
                    data-testid="desk-channel-item"
                    data-channel-name={ch.name}
                    data-channel-visibility={ch.visibility}
                    data-channel-skey={ch.skey}
                    aria-current={selectedChannelSkey === ch.skey ? "page" : undefined}
                    onClick={() => void handleSelectChannel(ch.skey)}
                  >
                    <span>
                      {ch.visibility === "private" ? "🔒 " : "# "}
                      {ch.name}
                    </span>
                  </button>
                ))}
              </VStack>
            </nav>
          </div>
        ) : null}

        <Divider />

        <section aria-label="Join workspace" data-testid="desk-join-form">
          <p className="desk-section-label">Join workspace</p>
          <form onSubmit={handleManualJoinSubmit}>
            <VStack gap={2}>
              <TextInput
                label="Workspace URI or Group DID"
                isLabelHidden
                placeholder="at://did:.../space/... or did:plc:..."
                value={joinTargetInput}
                onChange={setJoinTargetInput}
                width="100%"
                data-testid="desk-join-uri-input"
              />
              <TextInput
                label="Join note (optional)"
                isLabelHidden
                placeholder="Optional note for approval groups"
                value={joinMessageInput}
                onChange={setJoinMessageInput}
                width="100%"
                data-testid="desk-join-message-input"
              />
              <Button
                type="submit"
                variant="primary"
                size="sm"
                label="Join group"
                isDisabled={actionBusy || joinTargetInput.trim().length === 0}
                width="100%"
                data-testid="desk-join-submit"
              />
            </VStack>
          </form>
        </section>

        <section aria-label="Invites inbox" data-testid="desk-invites-inbox" data-invites-status={invitesStatus}>
          <p className="desk-section-label">Invites ({invites.length})</p>
          <VStack gap={2}>
            {invitesError ? (
              <Banner
                status={invitesStatus === "incompatible" ? "warning" : "error"}
                title={
                  invitesStatus === "incompatible"
                    ? "Incompatible invites space policy"
                    : "Invites inbox unavailable"
                }
                description={invitesError}
                data-testid="desk-invites-error"
              />
            ) : null}
            {invitesStatus === "loading" ? (
              <Text color="secondary">Checking personal invites space…</Text>
            ) : invites.length === 0 ? (
              invitesStatus === "ready" ? (
                <Text color="secondary">No pending invites.</Text>
              ) : null
            ) : (
              invites.map((inv) => (
                <Card key={inv.uri} padding={2} data-testid="desk-invite-card">
                  <VStack gap={1}>
                    <span className="desk-mono">{inv.groupDid}</span>
                    {inv.message ? <Text color="secondary">{inv.message}</Text> : null}
                    <Button
                      label="Accept invite"
                      variant="primary"
                      size="sm"
                      isDisabled={actionBusy}
                      onClick={() =>
                        void handleJoinGroup({ groupDid: inv.groupDid, inviteUri: inv.uri })
                      }
                      data-testid="desk-accept-invite-button"
                    />
                  </VStack>
                </Card>
              ))
            )}
          </VStack>
        </section>

        {joiningOps.length > 0 || leavingOps.length > 0 ? (
          <section aria-label="Pending operations" data-testid="desk-pending-joins">
            <p className="desk-section-label">Lifecycle queue</p>
            <VStack gap={2}>
              {joiningOps.map((op) => {
                const isPassive = PASSIVE_JOIN_PHASES.has(op.phase);
                return (
                  <Card key={op.operationId} padding={2} data-testid="desk-join-op-card">
                    <VStack gap={1}>
                      <span className="desk-mono">{op.groupDid}</span>
                      <Badge label={op.phase} variant={isPassive ? "warning" : "neutral"} />
                      <HStack gap={1}>
                        {op.phase === "pending_approval" ? (
                          <Button
                            label="Cancel request"
                            variant="secondary"
                            size="sm"
                            isDisabled={actionBusy}
                            onClick={() => void handleCancelPending(op.groupDid)}
                            data-testid="desk-cancel-join-button"
                          />
                        ) : null}
                        {isPassive ? (
                          <>
                            <Button
                              label="Retry"
                              variant="primary"
                              size="sm"
                              isDisabled={actionBusy}
                              onClick={() => void handleRetryJoin(op.operationId)}
                              data-testid="desk-retry-join-button"
                            />
                            <Button
                              label="Dismiss"
                              variant="ghost"
                              size="sm"
                              isDisabled={actionBusy}
                              onClick={() => void handleDismissJoin(op.operationId)}
                              data-testid="desk-dismiss-join-button"
                            />
                          </>
                        ) : null}
                      </HStack>
                    </VStack>
                  </Card>
                );
              })}
              {leavingOps.map((op) => (
                <Card key={op.groupDid} padding={2} data-testid="desk-leave-op-card">
                  <VStack gap={1}>
                    <span className="desk-mono">{op.groupDid}</span>
                    <Badge label={op.phase} variant="warning" />
                    {op.phase === "blocked_deactivated" ? (
                      <Button
                        label="Retry leave"
                        variant="secondary"
                        size="sm"
                        isDisabled={actionBusy}
                        onClick={() => void handleLeaveWorkspace(op.groupDid)}
                      />
                    ) : null}
                  </VStack>
                </Card>
              ))}
            </VStack>
          </section>
        ) : null}
      </aside>

      <main className="desk-main">
        {error ? (
          <Banner
            status="error"
            title={error}
            role="alert"
            isDismissable
            onDismiss={() => setError(null)}
            data-testid="desk-action-error"
          />
        ) : null}
        {syncError ? (
          <Banner
            status="warning"
            title="Sync warning"
            description={syncError}
            isDismissable
            onDismiss={() => setSyncError(null)}
            data-testid="desk-sync-error"
          />
        ) : null}
        {moderationError ? (
          <Banner
            status="warning"
            title={moderationError}
            data-testid="desk-moderation-error"
          />
        ) : null}
        {notice ? <Banner status="success" title={notice} isDismissable onDismiss={() => setNotice(null)} /> : null}

        {parsedPendingInvite ? (
          <section role="region" aria-label="Workspace invitation" data-testid="desk-invite-banner">
            <Card padding={4}>
              <VStack gap={3}>
                <Heading level={2}>Workspace invitation</Heading>
                <Text color="secondary" className="desk-mono">
                  {parsedPendingInvite.workspaceUri}
                </Text>
                <HStack gap={2}>
                  <Button
                    label="Join workspace"
                    variant="primary"
                    isDisabled={actionBusy}
                    onClick={() => void handleJoinGroup({ groupDid: parsedPendingInvite.groupDid })}
                    data-testid="desk-join-button"
                  />
                  <Button
                    label="Dismiss"
                    variant="ghost"
                    onClick={() => {
                      clearPendingInvite();
                      setPendingInviteUri(null);
                    }}
                  />
                </HStack>
              </VStack>
            </Card>
          </section>
        ) : null}

        {activeWorkspace && activeChannel && depsState ? (
          <DeskChannelView
            key={activeChannel.uri}
            deps={depsState}
            groupDid={activeWorkspace.groupDid}
            channel={activeChannel}
            page={channelPage}
            privateRoster={privateRoster}
            moderationConfig={moderationConfig}
            loading={channelLoading}
            onRefresh={async () => {
              const targetWs = activeWorkspace.uri;
              const targetChannel = activeChannel.skey;
              if (
                activeSelectionRef.current.wsUri !== targetWs ||
                activeSelectionRef.current.channelSkey !== targetChannel
              ) {
                return;
              }
              await loadWorkspaceDetail(targetWs, targetChannel);
            }}
          />
        ) : activeWorkspace ? (
          <VStack gap={4} data-testid="desk-workspace-home">
            <Card padding={5}>
              <VStack gap={3}>
                <HStack justify="between" align="center">
                  <Heading level={1}>{activeWorkspace.name}</Heading>
                  <Button
                    label="Leave workspace"
                    variant="secondary"
                    size="sm"
                    isDisabled={actionBusy}
                    onClick={() => void handleLeaveWorkspace(activeWorkspace.groupDid)}
                    data-testid="desk-leave-button"
                  />
                </HStack>
                <p data-testid="desk-workspace-summary">
                  {`${activeWorkspace.members.length} active members · ${activeWorkspace.channels.length} channels · join policy: ${activeWorkspace.joinPolicy}`}
                </p>
                <p className="desk-mono" data-testid="desk-workspace-uri">
                  {activeWorkspace.uri}
                </p>
              </VStack>
            </Card>

            {accountReportTarget && moderationConfig && depsState ? (
              <DeskReportPanel
                key={accountReportTarget.subject}
                deps={depsState}
                groupDid={activeWorkspace.groupDid}
                config={moderationConfig}
                target={accountReportTarget}
                onClose={() => setAccountReportTarget(null)}
                onSubmitted={(id) => {
                  setAccountReportTarget(null);
                  setNotice(`Account report #${id || "submitted"} sent to group moderators.`);
                }}
              />
            ) : null}

            <Card padding={4}>
              <VStack gap={2}>
                <Heading level={2}>Active members</Heading>
                <ul data-testid="desk-member-roster">
                  {activeWorkspace.members.map((did) => (
                    <li key={did}>
                      <HStack justify="between" align="center">
                        <span className="desk-mono">{did}</span>
                        {allowsAccountReports && moderationConfig && did !== viewerDid ? (
                          <Button
                            label="Report account"
                            variant="ghost"
                            size="sm"
                            onClick={() =>
                              setAccountReportTarget({
                                subject: did,
                                subjectType: "account",
                                label: `Account ${did}`,
                              })
                            }
                            data-testid="desk-report-account-button"
                          />
                        ) : null}
                      </HStack>
                    </li>
                  ))}
                </ul>
              </VStack>
            </Card>

            <Card padding={4}>
              <VStack gap={2}>
                <Heading level={2}>Workspace admins</Heading>
                <ul data-testid="desk-admin-list">
                  {activeWorkspace.admins.map((did) => (
                    <li key={did} className="desk-mono">
                      {did}
                    </li>
                  ))}
                </ul>
              </VStack>
            </Card>
          </VStack>
        ) : (
          <Card padding={6}>
            <VStack gap={2}>
              <Heading level={2}>Welcome to Flock Desk</Heading>
              <Text color="secondary">
                Accept an invite from the sidebar or paste a workspace URI / group DID to join directly on its Group Host.
              </Text>
            </VStack>
          </Card>
        )}
      </main>
    </div>
  );
}
