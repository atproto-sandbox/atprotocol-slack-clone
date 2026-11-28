"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import type { Engine } from "@flock/client/engine";
import type {
  GroupClient,
  GroupInviteDelivery,
  GroupJoinRequestItem,
  GroupRoleEntry,
  PublicMetaStatus,
} from "@flock/client/group-client";
import type { WorkspaceSummary } from "@flock/protocol/workspace-summary";
import {
  claimedActionTokenKey,
  type GroupBrowserOAuthClient,
  type GroupClaimPurpose,
} from "../../browser/group-session";
import { messageOf, splitDids } from "./client-api";

export const MIGRATION_MODE_OPTIONS = [
  { value: "auto", label: "Auto (prefer coordinated)" },
  { value: "coordinated", label: "Coordinated atomic" },
  { value: "standard", label: "Standard ATProto" },
] as const;

export function safeWebsiteUrl(raw: string | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol === "https:" || parsed.protocol === "http:") {
      return parsed.toString();
    }
    return null;
  } catch {
    return null;
  }
}

export async function saveGroupProfileChanges(
  groupClient: Pick<GroupClient, "updateProfile" | "setPublicMeta">,
  input: {
    displayName: string;
    description: string;
    website?: string;
    joinPolicy: "invite" | "approval" | "open";
    publicMeta: boolean;
    loadedPublicMeta: boolean;
    publicMetaConsistent?: boolean;
  },
): Promise<boolean> {
  const trimmedWebsite = input.website?.trim() ?? "";
  if (trimmedWebsite.length > 0 && !safeWebsiteUrl(trimmedWebsite)) {
    throw new Error("Group website URL must use http:// or https://.");
  }
  await groupClient.updateProfile({
    displayName: input.displayName.trim(),
    description: input.description.trim() ? input.description.trim() : null,
    ...(input.website !== undefined ? { website: trimmedWebsite ? trimmedWebsite : null } : {}),
    joinPolicy: input.joinPolicy,
  });
  if (input.publicMeta !== input.loadedPublicMeta || input.publicMetaConsistent === false) {
    await groupClient.setPublicMeta(input.publicMeta);
    return input.publicMeta;
  }
  return input.loadedPublicMeta;
}

export function mergeJoinRequestPage(
  existing: readonly GroupJoinRequestItem[],
  incoming: readonly GroupJoinRequestItem[],
): GroupJoinRequestItem[] {
  const byMember = new Map<string, GroupJoinRequestItem>();
  for (const item of existing) byMember.set(item.member, item);
  for (const item of incoming) byMember.set(item.member, item);
  return [...byMember.values()];
}

export function mergeInviteDeliveryPage(
  existing: readonly GroupInviteDelivery[],
  incoming: readonly GroupInviteDelivery[],
): GroupInviteDelivery[] {
  const byUri = new Map<string, GroupInviteDelivery>();
  for (const item of existing) byUri.set(item.inviteUri, item);
  for (const item of incoming) byUri.set(item.inviteUri, item);
  return [...byUri.values()];
}

export type GovernanceSnapshot = {
  roles?: GroupRoleEntry[];
  rolesError: string;
  joinRequests: GroupJoinRequestItem[];
  joinRequestsCursor?: string;
  joinRequestsError: string;
  deliveries: GroupInviteDelivery[];
  deliveriesCursor?: string;
  deliveriesError: string;
  publicMetaStatus?: PublicMetaStatus;
  publicMetaError: string;
};

export async function fetchGovernanceSnapshot(
  groupClient: Pick<
    GroupClient,
    "listRoles" | "listJoinRequests" | "listInviteDeliveries"
  > &
    Partial<Pick<GroupClient, "getPublicMetaStatus" | "getPublicMeta">>,
  options: { isAdmin: boolean },
): Promise<GovernanceSnapshot> {
  const readPublicMetaStatus = (): Promise<PublicMetaStatus | undefined> => {
    if (typeof groupClient.getPublicMetaStatus === "function") {
      return groupClient.getPublicMetaStatus();
    }
    if (typeof groupClient.getPublicMeta === "function") {
      return groupClient.getPublicMeta().then((val) => ({
        publicRead: val,
        hasDeclaration: val,
        consistent: true,
      }));
    }
    return Promise.resolve(undefined);
  };

  const [rolesSettled, joinSettled, deliveriesSettled, publicMetaSettled] = await Promise.allSettled([
    (async () => groupClient.listRoles())(),
    options.isAdmin ? (async () => groupClient.listJoinRequests())() : Promise.resolve({ requests: [] as GroupJoinRequestItem[], cursor: undefined as string | undefined }),
    options.isAdmin ? (async () => groupClient.listInviteDeliveries())() : Promise.resolve(undefined),
    (async () => readPublicMetaStatus())(),
  ]);

  const roles = rolesSettled.status === "fulfilled" ? rolesSettled.value : undefined;
  const rolesError = rolesSettled.status === "rejected" ? messageOf(rolesSettled.reason) : "";

  const joinRequests = joinSettled.status === "fulfilled" ? joinSettled.value.requests : [];
  const joinRequestsCursor = joinSettled.status === "fulfilled" ? joinSettled.value.cursor : undefined;
  const joinRequestsError = joinSettled.status === "rejected" ? messageOf(joinSettled.reason) : "";

  const deliveries =
    deliveriesSettled.status === "fulfilled" && deliveriesSettled.value !== undefined
      ? deliveriesSettled.value.deliveries
      : [];
  const deliveriesCursor =
    deliveriesSettled.status === "fulfilled" && deliveriesSettled.value !== undefined
      ? deliveriesSettled.value.cursor
      : undefined;
  const deliveriesError = deliveriesSettled.status === "rejected" ? messageOf(deliveriesSettled.reason) : "";

  const publicMetaStatus = publicMetaSettled.status === "fulfilled" ? publicMetaSettled.value : undefined;
  const publicMetaError = publicMetaSettled.status === "rejected" ? messageOf(publicMetaSettled.reason) : "";

  return {
    ...(roles !== undefined ? { roles } : {}),
    rolesError,
    joinRequests,
    ...(joinRequestsCursor ? { joinRequestsCursor } : {}),
    joinRequestsError,
    deliveries,
    ...(deliveriesCursor ? { deliveriesCursor } : {}),
    deliveriesError,
    ...(publicMetaStatus !== undefined ? { publicMetaStatus } : {}),
    publicMetaError,
  };
}

type GroupGovernancePanelProps = {
  activeWorkspace: WorkspaceSummary;
  engine: Engine | null;
  groupClient: GroupClient | null;
  groupOAuth: GroupBrowserOAuthClient | null;
  returnTo: string;
  onGroupClientChanged: () => Promise<void>;
  onWorkspaceMutated: () => Promise<void>;
  onGroupDeleted: () => void;
  setStatus: (message: string) => void;
  setError: (message: string) => void;
};

/**
 * Per-user Atmosphere Groups Governance panel (`org.atgrp.*`):
 * - Group-DID OAuth connect/disconnect (`admin` / `members` / `moderator` / `basic`)
 * - Profile (`displayName`, `description`, `website`, `joinPolicy`: `open` | `approval` | `invite`) & `publicMeta` editor
 * - Role & `canAssign` / `permissions` editor (`org.atgrp.role/*`) + direct member role assignment (`putMembership`)
 * - Pending group join requests (`listJoinRequests` -> `decideGroupJoinRequest` / `approveJoinRequest` / `denyJoinRequest`)
 * - Cross-PDS invitations (`createInvite`) + live delivery status badges (`pending` / `delivered` / `failed`) + `"Retry Delivery"`
 * - Group Host migration (`Standard` / `Coordinated` `migrateToHost`)
 * - 2-step `prompt=login` permanent group deletion (`requestAccountDelete` -> `claimActionToken` -> `deleteAccount`)
 */
export function GroupGovernancePanel({
  activeWorkspace,
  engine,
  groupClient,
  groupOAuth,
  returnTo,
  onGroupClientChanged,
  onWorkspaceMutated,
  onGroupDeleted,
  setStatus,
  setError,
}: GroupGovernancePanelProps) {
  const { groupDid } = activeWorkspace;
  const [busy, setBusy] = useState(false);

  // About & Config state
  const [displayName, setDisplayName] = useState(activeWorkspace.name);
  const [description, setDescription] = useState(activeWorkspace.description ?? "");
  const [website, setWebsite] = useState(activeWorkspace.website ?? "");
  const [joinPolicy, setJoinPolicy] = useState<"invite" | "approval" | "open">(
    activeWorkspace.joinPolicy === "open" || activeWorkspace.joinPolicy === "approval"
      ? activeWorkspace.joinPolicy
      : "invite",
  );
  const [selectedRoleScope, setSelectedRoleScope] = useState<"admin" | "members" | "moderator" | "basic">(
    activeWorkspace.isAdmin ? "admin" : "moderator",
  );
  const [publicMeta, setPublicMeta] = useState(activeWorkspace.publicMeta === true);
  const [loadedPublicMeta, setLoadedPublicMeta] = useState(activeWorkspace.publicMeta === true);
  const [publicMetaConsistent, setPublicMetaConsistent] = useState(true);
  const [publicMetaError, setPublicMetaError] = useState("");

  // Roles state
  const [roles, setRoles] = useState<GroupRoleEntry[]>([]);
  const [rolesError, setRolesError] = useState("");
  const [newRoleKey, setNewRoleKey] = useState("");
  const [newRoleName, setNewRoleName] = useState("");
  const [newRoleDefault, setNewRoleDefault] = useState(false);
  const [newRoleAssignable, setNewRoleAssignable] = useState("");
  const [newRoleScopes, setNewRoleScopes] = useState("");

  // Member role assignment state
  const [targetMemberDid, setTargetMemberDid] = useState("");
  const [targetMemberRoles, setTargetMemberRoles] = useState("member");

  // Join requests & cross-PDS invite deliveries
  const [joinRequests, setJoinRequests] = useState<GroupJoinRequestItem[]>([]);
  const [joinRequestsCursor, setJoinRequestsCursor] = useState<string | undefined>(undefined);
  const [joinRequestsError, setJoinRequestsError] = useState("");
  const [crossInviteDid, setCrossInviteDid] = useState("");
  const [deliveries, setDeliveries] = useState<GroupInviteDelivery[]>([]);
  const [deliveriesCursor, setDeliveriesCursor] = useState<string | undefined>(undefined);
  const [deliveriesError, setDeliveriesError] = useState("");

  // Migration & step-up deletion
  const [migrationEndpoint, setMigrationEndpoint] = useState("");
  const [migrationHandle, setMigrationHandle] = useState("");
  const [migrationMode, setMigrationMode] = useState<"auto" | "coordinated" | "standard">("auto");
  const [deleteToken, setDeleteToken] = useState<string>(() => {
    if (typeof sessionStorage === "undefined") return "";
    return sessionStorage.getItem(claimedActionTokenKey(groupDid, "delete_account")) ?? "";
  });

  const applyGovernanceSnapshot = useCallback(
    (snap: GovernanceSnapshot) => {
      if (snap.roles !== undefined) {
        setRoles(snap.roles);
      }
      setRolesError(snap.rolesError);
      setJoinRequests(snap.joinRequests);
      setJoinRequestsCursor(snap.joinRequestsCursor);
      setJoinRequestsError(snap.joinRequestsError);
      setDeliveries(snap.deliveries);
      setDeliveriesCursor(snap.deliveriesCursor);
      setDeliveriesError(snap.deliveriesError);
      setPublicMetaError(snap.publicMetaError);
      if (snap.publicMetaStatus !== undefined) {
        setPublicMeta(snap.publicMetaStatus.publicRead);
        setLoadedPublicMeta(snap.publicMetaStatus.publicRead);
        setPublicMetaConsistent(snap.publicMetaStatus.consistent);
      }
      const combinedError = [snap.rolesError, snap.publicMetaError].filter(Boolean).join(" · ");
      if (combinedError) {
        setError(combinedError);
      }
      if (typeof sessionStorage !== "undefined") {
        const storedToken = sessionStorage.getItem(claimedActionTokenKey(groupDid, "delete_account"));
        if (storedToken) setDeleteToken(storedToken);
      }
    },
    [groupDid, setError],
  );

  const loadGovernanceData = useCallback(async () => {
    if (!groupClient) return;
    try {
      const snap = await fetchGovernanceSnapshot(groupClient, { isAdmin: activeWorkspace.isAdmin });
      applyGovernanceSnapshot(snap);
    } catch (caught) {
      setError(messageOf(caught));
    }
  }, [groupClient, activeWorkspace.isAdmin, applyGovernanceSnapshot, setError]);

  useEffect(() => {
    if (!groupClient) return;
    let cancelled = false;
    void fetchGovernanceSnapshot(groupClient, { isAdmin: activeWorkspace.isAdmin }).then(
      (snap) => {
        if (!cancelled) applyGovernanceSnapshot(snap);
      },
      (caught: unknown) => {
        if (!cancelled) setError(messageOf(caught));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [groupClient, activeWorkspace.isAdmin, applyGovernanceSnapshot, setError]);

  async function startGroupSignIn(options: {
    roleScope: "admin" | "members" | "moderator" | "basic";
    prompt?: "login";
    claimPurpose?: GroupClaimPurpose;
  }) {
    if (!groupOAuth) return;
    setBusy(true);
    setError("");
    try {
      const url = await groupOAuth.authorizeGroup({
        groupOrHost: groupDid,
        roleScope: options.roleScope,
        ...(options.prompt ? { prompt: options.prompt } : {}),
        appState: {
          returnTo,
          purpose: options.prompt === "login" ? "step_up" : options.roleScope,
          groupDid,
          ...(options.claimPurpose ? { claimPurpose: options.claimPurpose } : {}),
        },
      });
      window.location.assign(url.toString());
    } catch (caught) {
      setError(messageOf(caught));
      setBusy(false);
    }
  }

  async function disconnectGroupSession() {
    if (!groupOAuth) return;
    setBusy(true);
    setError("");
    try {
      await groupOAuth.revokeGroupSession(groupDid);
      await onGroupClientChanged();
      setStatus("Disconnected per-user Group OAuth session.");
    } catch (caught) {
      setError(messageOf(caught));
    } finally {
      setBusy(false);
    }
  }

  async function handleSaveProfile(event: FormEvent) {
    event.preventDefault();
    if (!groupClient) return;
    setBusy(true);
    setError("");
    try {
      const nextLoaded = await saveGroupProfileChanges(groupClient, {
        displayName,
        description,
        website,
        joinPolicy,
        publicMeta,
        loadedPublicMeta,
        publicMetaConsistent,
      });
      setLoadedPublicMeta(nextLoaded);
      setPublicMetaConsistent(true);
      setPublicMetaError("");
      setStatus("Updated group profile, join policy, and public discovery settings.");
      await onWorkspaceMutated();
    } catch (caught) {
      setError(messageOf(caught));
    } finally {
      setBusy(false);
    }
  }

  async function handleSaveRole(event: FormEvent) {
    event.preventDefault();
    if (!groupClient || !newRoleKey.trim() || !newRoleName.trim()) return;
    setBusy(true);
    setError("");
    try {
      await groupClient.putRole(newRoleKey.trim(), {
        ...(newRoleName.trim() ? { displayName: newRoleName.trim() } : {}),
        default: newRoleDefault,
        canAssign: splitDids(newRoleAssignable),
        permissions: newRoleScopes
          .split(/[\s,]+/)
          .map((s) => s.trim())
          .filter(Boolean),
      });
      setNewRoleKey("");
      setNewRoleName("");
      setNewRoleDefault(false);
      setNewRoleAssignable("");
      setNewRoleScopes("");
      setStatus("Saved group role.");
      await loadGovernanceData();
      await onWorkspaceMutated();
    } catch (caught) {
      setError(messageOf(caught));
    } finally {
      setBusy(false);
    }
  }

  async function handleDeleteRole(rkey: string) {
    if (!groupClient) return;
    setBusy(true);
    setError("");
    try {
      await groupClient.deleteRole(rkey);
      setStatus(`Deleted role ${rkey}.`);
      await loadGovernanceData();
      await onWorkspaceMutated();
    } catch (caught) {
      setError(messageOf(caught));
    } finally {
      setBusy(false);
    }
  }

  async function handleAssignMemberRoles(event: FormEvent) {
    event.preventDefault();
    if (!groupClient || !targetMemberDid.trim()) return;
    const parsedRoles = splitDids(targetMemberRoles);
    if (parsedRoles.length === 0) {
      setError("Assign at least one role.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      await groupClient.putMembership(targetMemberDid.trim(), parsedRoles);
      setTargetMemberDid("");
      setStatus("Updated member roles on Group Host.");
      await loadGovernanceData();
      await onWorkspaceMutated();
    } catch (caught) {
      setError(messageOf(caught));
    } finally {
      setBusy(false);
    }
  }

  async function handleSendCrossPdsInvite(event: FormEvent) {
    event.preventDefault();
    if (!groupClient || !crossInviteDid.trim()) return;
    setBusy(true);
    setError("");
    try {
      await groupClient.createInvite(crossInviteDid.trim());
      setCrossInviteDid("");
      setStatus("Cross-PDS invitation written and queued for delivery.");
      await loadGovernanceData();
    } catch (caught) {
      setError(messageOf(caught));
    } finally {
      setBusy(false);
    }
  }

  async function handleRetryDelivery(inviteUri: string) {
    if (!groupClient) return;
    setBusy(true);
    setError("");
    try {
      await groupClient.retryInviteDelivery(inviteUri);
      setStatus("Retried invite delivery.");
      await loadGovernanceData();
    } catch (caught) {
      setError(messageOf(caught));
    } finally {
      setBusy(false);
    }
  }

  async function handleRevokeInvite(inviteeDid: string, rkey: string) {
    if (!groupClient) return;
    setBusy(true);
    setError("");
    try {
      await groupClient.revokeInvite(inviteeDid, rkey);
      setStatus(`Revoked invitation for ${inviteeDid}.`);
      await loadGovernanceData();
    } catch (caught) {
      setError(messageOf(caught));
    } finally {
      setBusy(false);
    }
  }

  async function handleLoadMoreJoinRequests() {
    if (!groupClient || !joinRequestsCursor) return;
    setBusy(true);
    setError("");
    try {
      const page = await groupClient.listJoinRequests({ cursor: joinRequestsCursor });
      setJoinRequests((prev) => mergeJoinRequestPage(prev, page.requests));
      setJoinRequestsCursor(page.cursor || undefined);
      setJoinRequestsError("");
    } catch (caught) {
      const msg = messageOf(caught);
      setJoinRequestsError(msg);
      setError(msg);
    } finally {
      setBusy(false);
    }
  }

  async function handleLoadMoreDeliveries() {
    if (!groupClient || !deliveriesCursor) return;
    setBusy(true);
    setError("");
    try {
      const page = await groupClient.listInviteDeliveries({ cursor: deliveriesCursor });
      setDeliveries((prev) => mergeInviteDeliveryPage(prev, page.deliveries));
      setDeliveriesCursor(page.cursor || undefined);
      setDeliveriesError("");
    } catch (caught) {
      const msg = messageOf(caught);
      setDeliveriesError(msg);
      setError(msg);
    } finally {
      setBusy(false);
    }
  }

  async function handleJoinDecision(memberDid: string, decision: "approve" | "deny") {
    setBusy(true);
    setError("");
    try {
      if (engine?.operator) {
        await engine.workspaces.decideGroupJoinRequest(activeWorkspace.uri, engine.operator, {
          member: memberDid,
          decision,
        });
      } else if (groupClient) {
        if (decision === "approve") {
          await groupClient.approveJoinRequest(memberDid);
        } else {
          await groupClient.denyJoinRequest(memberDid);
        }
      }
      setStatus(decision === "approve" ? `Approved join request from ${memberDid}.` : `Denied join request from ${memberDid}.`);
      await loadGovernanceData();
      await onWorkspaceMutated();
    } catch (caught) {
      setError(messageOf(caught));
    } finally {
      setBusy(false);
    }
  }

  async function handleRequestDeleteStepUp() {
    if (!groupClient) return;
    setBusy(true);
    setError("");
    try {
      await groupClient.requestAccountDelete();
      const claimed = await groupClient.claimActionToken("delete_account");
      setDeleteToken(claimed.token);
      if (typeof sessionStorage !== "undefined") {
        sessionStorage.setItem(claimedActionTokenKey(groupDid, "delete_account"), claimed.token);
      }
      setStatus("Deletion confirmation token claimed. Click Permanently delete group to confirm.");
      setBusy(false);
    } catch {
      // Fresh prompt=login step-up required (< 5 min): redirect through Group Host OAuth with prompt=login & claimPurpose
      await startGroupSignIn({ roleScope: "admin", prompt: "login", claimPurpose: "delete_account" });
    }
  }

  async function handleConfirmDeleteGroup() {
    if (!groupClient || !deleteToken.trim()) return;
    setBusy(true);
    setError("");
    try {
      await groupClient.deleteAccount(deleteToken.trim());
      if (typeof sessionStorage !== "undefined") {
        sessionStorage.removeItem(claimedActionTokenKey(groupDid, "delete_account"));
      }
      setDeleteToken("");
      setStatus("Group permanently deleted and tombstoned on PLC.");
      onGroupDeleted();
    } catch (caught) {
      setError(messageOf(caught));
    } finally {
      setBusy(false);
    }
  }

  async function handleMigrateHost(event: FormEvent) {
    event.preventDefault();
    if (!groupClient || !migrationEndpoint.trim() || !migrationHandle.trim()) return;
    setBusy(true);
    setError("");
    try {
      const result = await groupClient.migrateToHost(migrationEndpoint.trim(), {
        handle: migrationHandle.trim(),
        mode: migrationMode,
      });
      setStatus(`Group migrated (${result.mode}) to ${result.targetEndpoint} as ${result.handle}.`);
      await onWorkspaceMutated();
    } catch (caught) {
      const msg = messageOf(caught);
      if (/step-up|prompt=login|FreshLoginRequired/i.test(msg)) {
        await startGroupSignIn({ roleScope: "admin", prompt: "login", claimPurpose: "plc_operation" });
        return;
      }
      setError(msg);
    } finally {
      setBusy(false);
    }
  }

  if (!activeWorkspace.isAdmin && !activeWorkspace.isModerator) {
    return null;
  }

  return (
    <section aria-label="Atmosphere group governance">
      <div className="section-heading">
        <div>
          <span className="eyebrow">ATMOSPHERE GROUP GOVERNANCE</span>
          <h2>Group settings, roles &amp; invitations</h2>
        </div>
        <div>
          {groupClient ? (
            <>
              <button type="button" className="text-button" disabled={busy} onClick={() => void loadGovernanceData()}>
                Sync group ↻
              </button>
              <button type="button" className="text-button danger" disabled={busy} onClick={() => void disconnectGroupSession()}>
                Disconnect group session
              </button>
            </>
          ) : (
            <div className="inline-form">
              <select
                aria-label="Group OAuth permission set"
                value={selectedRoleScope}
                onChange={(e) => setSelectedRoleScope(e.target.value as "admin" | "members" | "moderator" | "basic")}
                disabled={busy}
              >
                <option value="admin">Admin (authManageAdmin)</option>
                <option value="members">Members (authManageMembers)</option>
                <option value="moderator">Moderator (authModerate)</option>
                <option value="basic">Basic (authManageBasic)</option>
              </select>
              <button
                type="button"
                className="primary-button"
                disabled={busy}
                onClick={() => void startGroupSignIn({ roleScope: selectedRoleScope })}
              >
                Sign in as group {selectedRoleScope} →
              </button>
            </div>
          )}
        </div>
      </div>

      {!groupClient ? (
        <div className="starter-card permission-box">
          <p>
            Group DID: <code>{groupDid}</code> · Join policy: <b>{activeWorkspace.joinPolicy}</b>
            {safeWebsiteUrl(activeWorkspace.website) ? (
              <>
                {" · "}
                <a href={safeWebsiteUrl(activeWorkspace.website)!} target="_blank" rel="noopener noreferrer">
                  {safeWebsiteUrl(activeWorkspace.website)}
                </a>
              </>
            ) : null}
            . Connect a per-user Group OAuth session to edit group metadata, roles, cross-PDS invitations, join requests,
            migration, or lifecycle settings.
          </p>
        </div>
      ) : (
        <>
          {activeWorkspace.isAdmin && (
            <div className="starter-grid">
              <article className="starter-card">
                <h3>Group about &amp; config</h3>
                <form className="inline-form" onSubmit={(e) => void handleSaveProfile(e)}>
                  <label>
                    Display name
                    <input
                      aria-label="Group display name"
                      value={displayName}
                      onChange={(e) => setDisplayName(e.target.value)}
                      maxLength={64}
                      required
                      disabled={busy}
                    />
                  </label>
                  <label>
                    Description
                    <input
                      aria-label="Group description"
                      value={description}
                      onChange={(e) => setDescription(e.target.value)}
                      maxLength={300}
                      disabled={busy}
                    />
                  </label>
                  <label>
                    Website (https://)
                    <input
                      aria-label="Group website"
                      placeholder="https://example.org"
                      value={website}
                      onChange={(e) => setWebsite(e.target.value)}
                      maxLength={500}
                      disabled={busy}
                    />
                  </label>
                  <label>
                    Join policy
                    <select
                      aria-label="Group join policy"
                      value={joinPolicy}
                      onChange={(e) => setJoinPolicy(e.target.value as "invite" | "approval" | "open")}
                      disabled={busy}
                    >
                      <option value="invite">Invite only</option>
                      <option value="approval">Approval required</option>
                      <option value="open">Open to anyone</option>
                    </select>
                  </label>
                  <label>
                    <input
                      type="checkbox"
                      checked={publicMeta}
                      onChange={(e) => setPublicMeta(e.target.checked)}
                      disabled={busy}
                    />{" "}
                    Public group metadata &amp; declaration
                  </label>
                  {publicMetaError && (
                    <p className="form-error" role="alert">
                      Failed to load public metadata status: {publicMetaError}
                    </p>
                  )}
                  {!publicMetaConsistent && (
                    <p className="form-error" role="alert">
                      Public discovery declaration is out of sync with metadata policy — save profile to repair.
                    </p>
                  )}
                  <button type="submit" className="primary-button" disabled={busy}>
                    Save profile
                  </button>
                </form>
              </article>

              <article className="starter-card">
                <h3>Send cross-PDS invite</h3>
                <p>Writes a signed <code>org.atgrp.invite</code> into the invitee&rsquo;s personal inbox space.</p>
                <form className="inline-form" onSubmit={(e) => void handleSendCrossPdsInvite(e)}>
                  <input
                    aria-label="Cross-PDS invitee DID"
                    placeholder="did:plc:…"
                    value={crossInviteDid}
                    onChange={(e) => setCrossInviteDid(e.target.value)}
                    required
                    disabled={busy}
                  />
                  <button type="submit" className="primary-button" disabled={busy}>
                    Send cross-PDS invite →
                  </button>
                </form>

                {deliveriesError && (
                  <p className="form-error" role="alert">
                    Failed to load invite deliveries: {deliveriesError}
                  </p>
                )}

                {deliveries.length > 0 && (
                  <div className="roster-list" aria-label="Invite delivery status">
                    {deliveries.map((d) => (
                      <div className="roster-row" key={d.inviteUri}>
                        <span>
                          <code>{d.inviteeDid}</code> · badge: <b>{d.status}</b>
                          {d.lastError ? ` (${d.lastError})` : ""}
                        </span>
                        <div>
                          {d.status !== "delivered" && (
                            <button
                              type="button"
                              className="text-button"
                              disabled={busy}
                              onClick={() => void handleRetryDelivery(d.inviteUri)}
                            >
                              Retry Delivery
                            </button>
                          )}
                          <button
                            type="button"
                            className="text-button danger"
                            disabled={busy}
                            onClick={() => void handleRevokeInvite(d.inviteeDid, d.rkey)}
                          >
                            Revoke
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}

                {deliveriesCursor && (
                  <button
                    type="button"
                    className="text-button"
                    disabled={busy}
                    onClick={() => void handleLoadMoreDeliveries()}
                  >
                    Load more invite deliveries
                  </button>
                )}
              </article>
            </div>
          )}

          {activeWorkspace.isAdmin && (
            <div className="starter-card">
              <h3>Group join requests (approval policy)</h3>
              {joinRequestsError ? (
                <p className="form-error" role="alert">
                  Failed to load join requests: {joinRequestsError}
                </p>
              ) : joinRequests.length === 0 ? (
                <p>No pending group join requests.</p>
              ) : (
                <div className="roster-list">
                  {joinRequests.map((req) => (
                    <div className="roster-row" key={req.member}>
                      <span>
                        <code>{req.member}</code>
                        {req.message ? ` — “${req.message}”` : ""} · {req.createdAt}
                      </span>
                      <div>
                        <button
                          type="button"
                          className="primary-button"
                          disabled={busy}
                          onClick={() => void handleJoinDecision(req.member, "approve")}
                        >
                          Approve join
                        </button>
                        <button
                          type="button"
                          className="text-button danger"
                          disabled={busy}
                          onClick={() => void handleJoinDecision(req.member, "deny")}
                        >
                          Deny join
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
              {joinRequestsCursor && (
                <button
                  type="button"
                  className="text-button"
                  disabled={busy}
                  onClick={() => void handleLoadMoreJoinRequests()}
                >
                  Load more join requests
                </button>
              )}
            </div>
          )}

          {activeWorkspace.isAdmin && (
            <>
              <div className="starter-card">
                <h3>Group roles &amp; assignable hierarchy</h3>
                {rolesError && (
                  <p className="form-error" role="alert">
                    Failed to load group roles: {rolesError}
                  </p>
                )}
                <div className="roster-list">
                  {(roles.length > 0 ? roles : activeWorkspace.roles).map((role) => (
                    <div className="roster-row" key={role.rkey}>
                      <span>
                        <strong>{role.displayName}</strong> (<code>{role.rkey}</code>)
                        {role.default ? " · default" : ""}
                        {role.canAssign.length > 0 ? ` · canAssign: ${role.canAssign.join(", ")}` : ""}
                      </span>
                      {!["admin", "moderator", "member"].includes(role.rkey) && (
                        <button
                          type="button"
                          className="text-button danger"
                          disabled={busy}
                          onClick={() => void handleDeleteRole(role.rkey)}
                        >
                          Delete role
                        </button>
                      )}
                    </div>
                  ))}
                </div>

                <form className="inline-form" onSubmit={(e) => void handleSaveRole(e)}>
                  <input
                    aria-label="Role key"
                    placeholder="Role key (e.g. triager)"
                    value={newRoleKey}
                    onChange={(e) => setNewRoleKey(e.target.value)}
                    required
                    disabled={busy}
                  />
                  <input
                    aria-label="Role display name"
                    placeholder="Display name"
                    value={newRoleName}
                    onChange={(e) => setNewRoleName(e.target.value)}
                    required
                    disabled={busy}
                  />
                  <input
                    aria-label="Assignable roles"
                    placeholder="Assignable roles (comma-separated)"
                    value={newRoleAssignable}
                    onChange={(e) => setNewRoleAssignable(e.target.value)}
                    disabled={busy}
                  />
                  <input
                    aria-label="Role scopes"
                    placeholder="OAuth scopes (space/comma-separated)"
                    value={newRoleScopes}
                    onChange={(e) => setNewRoleScopes(e.target.value)}
                    disabled={busy}
                  />
                  <label>
                    <input
                      type="checkbox"
                      checked={newRoleDefault}
                      onChange={(e) => setNewRoleDefault(e.target.checked)}
                      disabled={busy}
                    />{" "}
                    Default on join
                  </label>
                  <button type="submit" className="text-button" disabled={busy}>
                    Save role →
                  </button>
                </form>

                <form className="inline-form" onSubmit={(e) => void handleAssignMemberRoles(e)}>
                  <input
                    aria-label="Assign roles member DID"
                    placeholder="Member DID"
                    value={targetMemberDid}
                    onChange={(e) => setTargetMemberDid(e.target.value)}
                    required
                    disabled={busy}
                  />
                  <input
                    aria-label="Assigned role keys"
                    placeholder="Roles (e.g. moderator, member)"
                    value={targetMemberRoles}
                    onChange={(e) => setTargetMemberRoles(e.target.value)}
                    required
                    disabled={busy}
                  />
                  <button type="submit" className="text-button" disabled={busy}>
                    Update member roles →
                  </button>
                </form>
              </div>

              <div className="starter-grid">
                <article className="starter-card">
                  <h3>Migrate Group Host</h3>
                  <form className="inline-form" onSubmit={(e) => void handleMigrateHost(e)}>
                    <input
                      aria-label="Target Group Host URL"
                      placeholder="https://groups2.example.com"
                      value={migrationEndpoint}
                      onChange={(e) => setMigrationEndpoint(e.target.value)}
                      required
                      disabled={busy}
                    />
                    <input
                      aria-label="Target group handle"
                      placeholder="team.groups2.example.com"
                      value={migrationHandle}
                      onChange={(e) => setMigrationHandle(e.target.value)}
                      required
                      disabled={busy}
                    />
                    <select
                      aria-label="Migration mode"
                      value={migrationMode}
                      onChange={(e) => setMigrationMode(e.target.value as "auto" | "coordinated" | "standard")}
                      disabled={busy}
                    >
                      {MIGRATION_MODE_OPTIONS.map((opt) => (
                        <option key={opt.value} value={opt.value}>
                          {opt.label}
                        </option>
                      ))}
                    </select>
                    <button type="submit" className="text-button" disabled={busy}>
                      Migrate group →
                    </button>
                  </form>
                </article>

                <article className="starter-card lifecycle-card">
                  <h3>Permanent group deletion</h3>
                  <p>Requires fresh <code>prompt=login</code> step-up authentication and tombstones the group DID on PLC.</p>
                  {!deleteToken ? (
                    <button
                      type="button"
                      className="text-button danger"
                      disabled={busy}
                      onClick={() => void handleRequestDeleteStepUp()}
                    >
                      Request group deletion (step-up) →
                    </button>
                  ) : (
                    <div>
                      <p className="mono-note">Action token ready.</p>
                      <button
                        type="button"
                        className="primary-button danger"
                        disabled={busy}
                        onClick={() => void handleConfirmDeleteGroup()}
                      >
                        Permanently delete group
                      </button>
                    </div>
                  )}
                </article>
              </div>
            </>
          )}
        </>
      )}
    </section>
  );
}
