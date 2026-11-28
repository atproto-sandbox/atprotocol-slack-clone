import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { GroupClient } from "@flock/client/group-client";
import { OperatorRemoteError, type AuthorityFlowRequest, type OperatorClient } from "@flock/client/operator-client";
import type { CreatedGroupWorkspace, DiscoveredWorkspace, WorkspaceClient } from "@flock/client/workspace-client";
import type { WorkspaceSummary } from "@flock/protocol/workspace-summary";
import { ATGRP_MOD_EVENT_TYPE, ATGRP_MOD_REASON } from "@flock/protocol/nsids";
import {
  parsePersistedGroupMigrationState,
  serializePersistedGroupMigrationState,
} from "../../browser/group-session";
import { runBrowserOperatorReauthorization } from "../../browser/use-browser-session";
import {
  clearPendingOperatorOperation,
  PENDING_OPERATOR_OPERATION_KEY,
  readPendingOperatorOperations,
  upsertPendingOperatorOperation,
  WORKSPACE_OPERATION_KEY,
} from "./client-api";
import {
  fetchGovernanceSnapshot,
  GroupGovernancePanel,
  mergeInviteDeliveryPage,
  mergeJoinRequestPage,
  MIGRATION_MODE_OPTIONS,
  safeWebsiteUrl,
  saveGroupProfileChanges,
} from "./group-governance-panel";
import { fetchModerationSnapshot, mergeModHistoryPage, mergeModSubjectsPage } from "./moderation-panel";
import { REPORT_REASON_TYPES } from "./report-subject-modal";
import { channelWatchedSpaces } from "./use-channel-content";
import { buildVisibleWorkspaceRoster } from "./workspace-home";
import {
  abortUnstartedWorkspaceCreation,
  executeBrowserWorkspaceCreation,
  formatReceivedInvitesWarning,
  toPermalinkMessage,
} from "./workspace-manager";

const GROUP_DID = "did:plc:groupwebhardenaaaaaaaaaa";
const ALICE = "did:plc:aliceaaaaaaaaaaaaaaaaaaa";
const BOB = "did:plc:bob2aaaaaaaaaaaaaaaaaaaa";
const CAROL = "did:plc:carolaaaaaaaaaaaaaaaaaaa";

function makeWorkspace(overrides: Partial<WorkspaceSummary> = {}): WorkspaceSummary {
  return {
    uri: `at:space/${GROUP_DID}/new.flock.workspace/self`,
    authorityDid: GROUP_DID,
    groupDid: GROUP_DID,
    skey: "self",
    name: "Private Team",
    description: "Confidential group",
    joinPolicy: "invite",
    publicMeta: false,
    isAdmin: true,
    isModerator: false,
    admins: [ALICE],
    moderators: [],
    members: [
      { did: ALICE, active: true, roles: ["admin", "member"] },
      { did: BOB, active: true, roles: ["member"] },
    ],
    pendingMembers: [{ did: CAROL, roles: ["member"] }],
    roles: [{ rkey: "admin", displayName: "Admin", default: false, canAssign: ["admin", "member"], permissions: [] }],
    channels: [],
    installs: [],
    degradedReasons: [],
    ...overrides,
  };
}

test("REPORT_REASON_TYPES uses canonical Atmosphere Groups reason tokens (org.atgrp.mod.defs#reason*)", () => {
  assert.equal(REPORT_REASON_TYPES.some((r) => r.value === ATGRP_MOD_REASON.nsfw), true);
  assert.equal(
    REPORT_REASON_TYPES.find((r) => r.value === ATGRP_MOD_REASON.nsfw)?.label,
    "Unwanted sexual / NSFW content",
  );
  assert.equal(REPORT_REASON_TYPES.some((r) => (r.value as string) === "sexual"), false);
  assert.equal(REPORT_REASON_TYPES.some((r) => (r.value as string) === "nsfw"), false);
});

test("safeWebsiteUrl enforces http/https allowlist and rejects javascript:/data: XSS schemes", () => {
  assert.equal(safeWebsiteUrl("https://example.org/group"), "https://example.org/group");
  assert.equal(safeWebsiteUrl("http://127.0.0.1:8080/team"), "http://127.0.0.1:8080/team");
  assert.equal(safeWebsiteUrl("javascript:alert(1)"), null);
  assert.equal(safeWebsiteUrl("data:text/html,<script>alert(1)</script>"), null);
  assert.equal(safeWebsiteUrl("vbscript:msgbox(1)"), null);
  assert.equal(safeWebsiteUrl("not-a-url"), null);
});

test("channelWatchedSpaces watches both the channel space and members/self for live account labels", () => {
  const channelSpace = `at:space/${GROUP_DID}/new.flock.channel/general`;
  assert.deepEqual(channelWatchedSpaces(channelSpace, GROUP_DID), [
    channelSpace,
    `at:space/${GROUP_DID}/org.atgrp.members/self`,
  ]);
  assert.deepEqual(channelWatchedSpaces(null, GROUP_DID), []);
  assert.deepEqual(channelWatchedSpaces(channelSpace, undefined), []);
});

test("buildVisibleWorkspaceRoster withholds takendownMembers from active and pending roster rows", () => {
  const ws = makeWorkspace({ takendownMembers: [BOB, CAROL] });
  assert.deepEqual(buildVisibleWorkspaceRoster(ws), [
    { did: ALICE, roles: ["admin", "member"], pending: false },
  ]);
});

test("toPermalinkMessage preserves cid, hidden, and labels on out-of-window permalink messages", () => {
  const linked = toPermalinkMessage({
    uri: `at:space/${GROUP_DID}/new.flock.channel/general/${BOB}/new.flock.channel.message/3lbl111111111`,
    cid: "bafyreipermalinkcid123",
    rkey: "3lbl111111111",
    repo: BOB,
    value: { text: "moderated message", createdAt: "2026-11-10T12:00:00.000Z" },
    hidden: true,
    labels: ["!hide", "nsfw"],
  });
  assert.equal(linked.cid, "bafyreipermalinkcid123");
  assert.equal(linked.hidden, true);
  assert.deepEqual(linked.labels, ["!hide", "nsfw"]);
});

test("GroupGovernancePanel initializes publicMeta from workspace.publicMeta, only calls setPublicMeta when changed, and renders accurate migration modes", async () => {
  assert.deepEqual(MIGRATION_MODE_OPTIONS, [
    { value: "auto", label: "Auto (prefer coordinated)" },
    { value: "coordinated", label: "Coordinated atomic" },
    { value: "standard", label: "Standard ATProto" },
  ]);

  const setPublicMetaCalls: boolean[] = [];
  let updateProfileCalls = 0;
  const mockGroupClient = {
    updateProfile: async () => {
      updateProfileCalls += 1;
      return { displayName: "Private Team", joinPolicy: "approval" };
    },
    setPublicMeta: async (val: boolean) => {
      setPublicMetaCalls.push(val);
    },
    listRoles: async () => [],
    listJoinRequests: async () => ({ requests: [] }),
    listInviteDeliveries: async () => ({ deliveries: [] }),
    getPublicMeta: async () => false,
  };

  // Editing description/joinPolicy on a private group (`publicMeta: false, loadedPublicMeta: false`) NEVER calls `setPublicMeta`!
  const unchangedLoaded = await saveGroupProfileChanges(mockGroupClient, {
    displayName: "Private Team",
    description: "Updated description",
    joinPolicy: "approval",
    publicMeta: false,
    loadedPublicMeta: false,
  });
  assert.equal(updateProfileCalls, 1);
  assert.deepEqual(setPublicMetaCalls, [], "setPublicMeta must not be called when publicMeta did not change");
  assert.equal(unchangedLoaded, false);

  // Explicitly flipping `publicMeta` from `false` to `true` calls `setPublicMeta(true)` once.
  const flippedLoaded = await saveGroupProfileChanges(mockGroupClient, {
    displayName: "Private Team",
    description: "Updated description",
    joinPolicy: "approval",
    publicMeta: true,
    loadedPublicMeta: false,
  });
  assert.deepEqual(setPublicMetaCalls, [true]);
  assert.equal(flippedLoaded, true);

  // Repairing out-of-sync declaration (`publicMetaConsistent: false`) calls `setPublicMeta` even when `publicMeta === loadedPublicMeta`!
  const repairedLoaded = await saveGroupProfileChanges(mockGroupClient, {
    displayName: "Private Team",
    description: "Repair declaration",
    joinPolicy: "approval",
    publicMeta: false,
    loadedPublicMeta: false,
    publicMetaConsistent: false,
  });
  assert.deepEqual(setPublicMetaCalls, [true, false], "repairs inconsistent declaration even when checkbox matches loadedPublicMeta");
  assert.equal(repairedLoaded, false);

  // Rendered panel for a `publicMeta: false` group renders the checkbox UNCHECKED and exact migration mode labels!
  const html = renderToStaticMarkup(
    React.createElement(GroupGovernancePanel, {
      activeWorkspace: makeWorkspace({ publicMeta: false }),
      engine: null,
      groupClient: mockGroupClient as unknown as GroupClient,
      groupOAuth: null,
      returnTo: "/",
      onGroupClientChanged: async () => {},
      onWorkspaceMutated: async () => {},
      onGroupDeleted: () => {},
      setStatus: () => {},
      setError: () => {},
    }),
  );
  assert.ok(html.includes("Auto (prefer coordinated)"));
  assert.ok(html.includes("Coordinated atomic"));
  assert.ok(html.includes("Standard ATProto"));
  assert.equal(/<input type="checkbox" checked=""[^>]*\/>\s*Public group metadata/.test(html), false);
});

test("runBrowserOperatorReauthorization starts Operator reauth once, records pending reactivation, and skips ?authority=failed loops", async () => {
  const storageMap = new Map<string, string>();
  const storage = {
    getItem: (k: string) => storageMap.get(k) ?? null,
    setItem: (k: string, v: string) => {
      storageMap.set(k, v);
    },
  };
  const navigated: string[] = [];
  const operator = {
    startAuthorityFlow: async (req: { purpose: "reauthorize"; authority: string }) => ({
      url: `https://operator.example/authority/start?ticket=t1&authority=${encodeURIComponent(req.authority)}`,
    }),
  };

  // Declined callback (`?authority=failed`) does not redirect again.
  assert.equal(
    await runBrowserOperatorReauthorization({
      groupDid: GROUP_DID,
      operator,
      locationSearch: "?authority=failed",
      storage,
      navigate: (u) => navigated.push(u),
    }),
    false,
  );
  assert.equal(navigated.length, 0);

  // Normal invocation redirects once and guards against same-session loop.
  assert.equal(
    await runBrowserOperatorReauthorization({
      groupDid: GROUP_DID,
      operator,
      locationSearch: "",
      storage,
      navigate: (u) => {
        navigated.push(u);
      },
    }),
    true,
  );
  assert.equal(navigated.length, 1);
  assert.equal(storageMap.get("spaces.pendingReactivateGroup"), GROUP_DID);

  assert.equal(
    await runBrowserOperatorReauthorization({
      groupDid: GROUP_DID,
      operator,
      locationSearch: "",
      storage,
      navigate: (u) => {
        navigated.push(u);
      },
    }),
    false,
    "one-shot session guard prevents background discover() redirect loops",
  );
  assert.equal(navigated.length, 1);
});

test("fetchGovernanceSnapshot isolates independent governance requests via Promise.allSettled, gates admin-only queues, and preserves loaded queues on partial failure", async () => {
  let deliveriesCalls = 0;
  let joinReqCalls = 0;

  // 1. Non-admin moderator (`isAdmin: false`): does NOT call admin-only listInviteDeliveries() or listJoinRequests(), detects publicMeta drift!
  const modSnap = await fetchGovernanceSnapshot(
    {
      listRoles: async () => [],
      listJoinRequests: async () => {
        joinReqCalls += 1;
        return {
          requests: [{ member: BOB, createdAt: "2026-11-10T00:00:00.000Z" }],
          cursor: "jr-cur-1",
        };
      },
      listInviteDeliveries: async () => {
        deliveriesCalls += 1;
        return { deliveries: [] };
      },
      getPublicMetaStatus: async () => ({
        publicRead: false,
        hasDeclaration: true,
        consistent: false,
      }),
    },
    { isAdmin: false },
  );
  assert.equal(deliveriesCalls, 0, "non-admin moderator must not call admin-only listInviteDeliveries");
  assert.equal(joinReqCalls, 0, "non-admin moderator must not call admin-only listJoinRequests");
  assert.equal(modSnap.joinRequests.length, 0);
  assert.equal(modSnap.joinRequestsError, "");
  assert.equal(modSnap.rolesError, "");
  assert.equal(modSnap.publicMetaError, "");
  assert.deepEqual(modSnap.publicMetaStatus, {
    publicRead: false,
    hasDeclaration: true,
    consistent: false,
  });

  // 2. Admin (`isAdmin: true`) with failing listJoinRequests & listInviteDeliveries records explicit per-section errors!
  const errSnap = await fetchGovernanceSnapshot(
    {
      listRoles: async () => [],
      listJoinRequests: async () => {
        throw new Error("Join queue read forbidden");
      },
      listInviteDeliveries: async () => {
        deliveriesCalls += 1;
        throw new Error("Delivery table unavailable");
      },
      getPublicMetaStatus: async () => ({
        publicRead: true,
        hasDeclaration: true,
        consistent: true,
      }),
    },
    { isAdmin: true },
  );
  assert.equal(deliveriesCalls, 1);
  assert.equal(errSnap.joinRequestsError, "Join queue read forbidden");
  assert.equal(errSnap.deliveriesError, "Delivery table unavailable");
  assert.equal(errSnap.rolesError, "");
  assert.equal(errSnap.publicMetaError, "");

  // 3. Failing `getPublicMetaStatus()` OR `listRoles()` NEVER discards successfully loaded join requests or invite deliveries!
  const pendingReq = { member: BOB, createdAt: "2026-11-10T00:00:00.000Z", message: "Let me in" };
  const pendingDelivery = {
    inviteUri: "at://u1/inv/1",
    spaceUri: "at:space/u1/org.atgrp.inbox/self",
    inviteeDid: CAROL,
    rkey: "3lbl111111111",
    repoRev: "rev1",
    status: "pending" as const,
    attempts: 1,
    createdAt: "2026-11-10T00:00:00.000Z",
    updatedAt: "2026-11-10T00:00:00.000Z",
  };

  const metaErrSnap = await fetchGovernanceSnapshot(
    {
      listRoles: async () => [
        {
          rkey: "moderator",
          uri: `at:space/${GROUP_DID}/org.atgrp.members/self/${GROUP_DID}/org.atgrp.role/moderator`,
          displayName: "Moderator",
          default: false,
          permissions: [],
          canAssign: [],
        },
      ],
      listJoinRequests: async () => ({ requests: [pendingReq], cursor: "jr-next" }),
      listInviteDeliveries: async () => ({ deliveries: [pendingDelivery], cursor: "deliv-next" }),
      getPublicMetaStatus: async () => {
        throw new Error("Meta space unreachable");
      },
    },
    { isAdmin: true },
  );
  assert.equal(metaErrSnap.publicMetaError, "Meta space unreachable");
  assert.equal(metaErrSnap.publicMetaStatus, undefined);
  assert.equal(metaErrSnap.rolesError, "");
  assert.equal(metaErrSnap.roles?.length, 1);
  assert.deepEqual(metaErrSnap.joinRequests, [pendingReq]);
  assert.equal(metaErrSnap.joinRequestsCursor, "jr-next");
  assert.equal(metaErrSnap.joinRequestsError, "");
  assert.deepEqual(metaErrSnap.deliveries, [pendingDelivery]);
  assert.equal(metaErrSnap.deliveriesCursor, "deliv-next");
  assert.equal(metaErrSnap.deliveriesError, "");

  const rolesErrSnap = await fetchGovernanceSnapshot(
    {
      listRoles: async () => {
        throw new Error("Roles read timed out");
      },
      listJoinRequests: async () => ({ requests: [pendingReq] }),
      listInviteDeliveries: async () => ({ deliveries: [pendingDelivery] }),
      getPublicMetaStatus: async () => ({
        publicRead: true,
        hasDeclaration: true,
        consistent: true,
      }),
    },
    { isAdmin: true },
  );
  assert.equal(rolesErrSnap.roles, undefined);
  assert.equal(rolesErrSnap.rolesError, "Roles read timed out");
  assert.equal(rolesErrSnap.publicMetaError, "");
  assert.deepEqual(rolesErrSnap.publicMetaStatus, {
    publicRead: true,
    hasDeclaration: true,
    consistent: true,
  });
  assert.deepEqual(rolesErrSnap.joinRequests, [pendingReq]);
  assert.equal(rolesErrSnap.joinRequestsError, "");
  assert.deepEqual(rolesErrSnap.deliveries, [pendingDelivery]);
  assert.equal(rolesErrSnap.deliveriesError, "");
});

test("governance & moderation cursor pagination helpers deduplicate and append pages, and formatReceivedInvitesWarning surfaces invite scan truncation", () => {
  const mergedJoins = mergeJoinRequestPage(
    [{ member: BOB, createdAt: "2026-11-10T00:00:00.000Z" }],
    [
      { member: BOB, createdAt: "2026-11-10T00:00:00.000Z", message: "updated" },
      { member: CAROL, createdAt: "2026-11-10T01:00:00.000Z" },
    ],
  );
  assert.deepEqual(mergedJoins, [
    { member: BOB, createdAt: "2026-11-10T00:00:00.000Z", message: "updated" },
    { member: CAROL, createdAt: "2026-11-10T01:00:00.000Z" },
  ]);

  const mergedDeliveries = mergeInviteDeliveryPage(
    [
      {
        inviteUri: "at://u1/inv/1",
        spaceUri: "at:space/u1/org.atgrp.inbox/self",
        inviteeDid: BOB,
        rkey: "1",
        repoRev: "rev1",
        status: "pending",
        attempts: 1,
        createdAt: "2026-11-10T00:00:00.000Z",
        updatedAt: "2026-11-10T00:00:00.000Z",
      },
    ],
    [
      {
        inviteUri: "at://u1/inv/1",
        spaceUri: "at:space/u1/org.atgrp.inbox/self",
        inviteeDid: BOB,
        rkey: "1",
        repoRev: "rev1",
        status: "delivered",
        attempts: 2,
        createdAt: "2026-11-10T00:00:00.000Z",
        updatedAt: "2026-11-10T00:01:00.000Z",
      },
      {
        inviteUri: "at://u2/inv/2",
        spaceUri: "at:space/u2/org.atgrp.inbox/self",
        inviteeDid: CAROL,
        rkey: "2",
        repoRev: "rev2",
        status: "failed",
        attempts: 3,
        lastError: "timeout",
        createdAt: "2026-11-10T00:02:00.000Z",
        updatedAt: "2026-11-10T00:03:00.000Z",
      },
    ],
  );
  assert.equal(mergedDeliveries.length, 2);
  assert.equal(mergedDeliveries[0]?.status, "delivered");
  assert.equal(mergedDeliveries[1]?.inviteeDid, CAROL);

  const mergedSubjects = mergeModSubjectsPage(
    [{ subject: BOB, status: "open", createdAt: "t1", updatedAt: "t1", reportCount: 1 }],
    [
      { subject: BOB, status: "open", createdAt: "t1", updatedAt: "t2", reportCount: 2 },
      { subject: CAROL, cid: "bafy1", status: "open", createdAt: "t3", updatedAt: "t3", reportCount: 1 },
    ],
  );
  assert.equal(mergedSubjects.length, 2);
  assert.equal(mergedSubjects[0]?.reportCount, 2);
  assert.equal(mergedSubjects[1]?.subject, CAROL);

  const mergedHistory = mergeModHistoryPage(
    [{ eventId: "1", subject: BOB, createdAt: "t1", event: { $type: ATGRP_MOD_EVENT_TYPE.report } }],
    [
      { eventId: "1", subject: BOB, createdAt: "t1", event: { $type: ATGRP_MOD_EVENT_TYPE.report } },
      { eventId: "2", subject: BOB, createdAt: "t2", event: { $type: ATGRP_MOD_EVENT_TYPE.status, status: "resolved" } },
    ],
  );
  assert.deepEqual(mergedHistory.map((e) => e.eventId), ["1", "2"]);

  assert.equal(formatReceivedInvitesWarning(undefined), "");
  assert.equal(
    formatReceivedInvitesWarning(
      new Error("Personal invites space exceeded bounded scan limits; invitation list is incomplete."),
    ),
    "Cross-PDS invitations could not be loaded completely: Personal invites space exceeded bounded scan limits; invitation list is incomplete.",
  );
});

test("fetchModerationSnapshot isolates listRules and queryModSubjects via Promise.allSettled in both failure directions", async () => {
  const sampleRule = {
    rkey: "3lblrule00001",
    uri: `at:space/${GROUP_DID}/org.atgrp.members/self/${GROUP_DID}/org.atgrp.rule/3lblrule00001`,
    title: "Be respectful",
    text: "No harassment or spam.",
    order: 1,
  };
  const sampleSubject = {
    subject: `at:space/${GROUP_DID}/new.flock.channel/general/${BOB}/new.flock.channel.message/3lblmsg00001`,
    cid: "bafyreimodsub1",
    status: "open" as const,
    createdAt: "2026-11-10T00:00:00.000Z",
    updatedAt: "2026-11-10T00:05:00.000Z",
    reportCount: 3,
    tags: ["escalated"],
  };

  // 1. `listRules()` rejects while `queryModSubjects()` fulfills -> moderation queue & cursor are preserved, `subjectsError === ""`!
  const rulesFailedSnap = await fetchModerationSnapshot(
    {
      listRules: async () => {
        throw new Error("Members rules space read timed out");
      },
      queryModSubjects: async (opts) => {
        assert.equal(opts?.status, "open");
        assert.deepEqual(opts?.tags, ["escalated"]);
        return { subjects: [sampleSubject], cursor: "mod-cur-2" };
      },
    },
    { canModerate: true, status: "open", tags: ["escalated"] },
  );
  assert.equal(rulesFailedSnap.rules, undefined);
  assert.equal(rulesFailedSnap.rulesError, "Members rules space read timed out");
  assert.deepEqual(rulesFailedSnap.subjects, [sampleSubject]);
  assert.equal(rulesFailedSnap.subjectsCursor, "mod-cur-2");
  assert.equal(rulesFailedSnap.subjectsError, "");

  // 2. `queryModSubjects()` rejects while `listRules()` fulfills -> rules are preserved, `rulesError === ""`!
  const subjectsFailedSnap = await fetchModerationSnapshot(
    {
      listRules: async () => [sampleRule],
      queryModSubjects: async () => {
        throw new Error("Moderation subject queue unavailable");
      },
    },
    { canModerate: true, status: "open" },
  );
  assert.deepEqual(subjectsFailedSnap.rules, [sampleRule]);
  assert.equal(subjectsFailedSnap.rulesError, "");
  assert.equal(subjectsFailedSnap.subjects, undefined);
  assert.equal(subjectsFailedSnap.subjectsCursor, undefined);
  assert.equal(subjectsFailedSnap.subjectsError, "Moderation subject queue unavailable");

  // 3. `canModerate: false` skips `queryModSubjects()` while loading rules cleanly.
  let queryModSubjectsCalled = false;
  const memberSnap = await fetchModerationSnapshot(
    {
      listRules: async () => [sampleRule],
      queryModSubjects: async () => {
        queryModSubjectsCalled = true;
        return { subjects: [] };
      },
    },
    { canModerate: false, status: "open" },
  );
  assert.equal(queryModSubjectsCalled, false);
  assert.deepEqual(memberSnap.rules, [sampleRule]);
  assert.equal(memberSnap.rulesError, "");
  assert.deepEqual(memberSnap.subjects, []);
  assert.equal(memberSnap.subjectsError, "");
});

test("Round 9 Finding #4: executeBrowserWorkspaceCreation routes through durable workspaces.createWorkspace, handles pending state, and cleans up unstarted cancelled OAuth entries", async () => {
  const storageMap = new Map<string, string>();
  const storage = {
    getItem: (k: string) => storageMap.get(k) ?? null,
    setItem: (k: string, v: string) => {
      storageMap.set(k, v);
    },
    removeItem: (k: string) => {
      storageMap.delete(k);
    },
  };

  type JournalState = { operationId: string; hasGroupDid: boolean } | null;
  let journalState: JournalState = null;
  const currentJournal = (): JournalState => journalState;
  let nextMode: "auth_required" | "pending" | "completed" = "auth_required";
  const createCalls: Array<{ name: string; operationId?: string }> = [];
  const authFlows: AuthorityFlowRequest[] = [];
  const selectedWorkspaces: string[] = [];
  let lastStatus = "";
  let lastError = "";
  let busy = false;

  const mockWorkspaces = {
    createWorkspace: async (
      params: { name: string; joinPolicy?: "open" | "approval" | "invite"; publicMeta?: boolean },
      opts?: { operationId?: string },
    ): Promise<CreatedGroupWorkspace> => {
      createCalls.push({ name: params.name, ...(opts?.operationId ? { operationId: opts.operationId } : {}) });
      if (nextMode === "auth_required") {
        journalState = { operationId: opts?.operationId ?? "", hasGroupDid: false };
        throw new OperatorRemoteError(403, "AuthorizationRequired", "Authority grant required");
      }
      if (nextMode === "pending") {
        journalState = { operationId: opts?.operationId ?? "", hasGroupDid: true };
        return {
          operationId: opts?.operationId ?? "",
          groupDid: GROUP_DID,
          workspace: `at:space/${GROUP_DID}/new.flock.workspace/self`,
          state: "pending",
          completedSteps: ["workspace-space", "inbox-space"],
          error: "Temporary outage",
        };
      }
      journalState = null;
      return {
        operationId: opts?.operationId ?? "",
        groupDid: GROUP_DID,
        workspace: `at:space/${GROUP_DID}/new.flock.workspace/self`,
        state: "completed",
        completedSteps: ["workspace-space", "creator-admin", "general-directory"],
      };
    },
    dismissUnstartedCreateOperation: async (opId: string): Promise<"dismissed" | "not_found" | "in_progress"> => {
      if (!journalState || journalState.operationId !== opId) return "not_found";
      if (journalState.hasGroupDid) return "in_progress";
      journalState = null;
      return "dismissed";
    },
  } as unknown as WorkspaceClient;

  const mockEngine = {
    workspaces: mockWorkspaces,
    operator: {} as OperatorClient,
  };

  // 1. First attempt (`mayAuthorize: true`) keeps durable unstarted journal + operationId across OAuth redirect!
  await executeBrowserWorkspaceCreation(
    { name: "Crash-Safe Team", joinPolicy: "open", publicMeta: true },
    {
      mayAuthorize: true,
      engine: mockEngine,
      storage,
      refreshWorkspaces: async () => ({ workspaces: [], candidates: [] }),
      approveAuthority: async (req) => {
        authFlows.push(req);
      },
      onWorkspaceSelected: (ws) => selectedWorkspaces.push(ws),
      setStatus: (s) => {
        lastStatus = s;
      },
      setError: (e) => {
        lastError = e;
      },
      setBusy: (b) => {
        busy = b;
      },
    },
  );
  assert.equal(authFlows.length, 1);
  assert.equal(busy, true, "remains busy while navigating to OAuth consent screen");
  const afterRedirectJournal = currentJournal();
  assert.ok(afterRedirectJournal !== null, "durable joiningGroups journal preserved across OAuth redirect");
  const mintedOpId = afterRedirectJournal.operationId;
  assert.equal(authFlows[0]?.purpose === "createWorkspace" ? authFlows[0].creationKey : "", mintedOpId);
  assert.equal(storageMap.get("spaces.autoCreateWorkspace"), "1");

  // 2. Declined OAuth on return (`mayAuthorize: false` + `AuthorizationRequired`) dismisses unstarted journal & clears WORKSPACE_OPERATION_KEY!
  storageMap.delete("spaces.autoCreateWorkspace");
  await executeBrowserWorkspaceCreation(
    { name: "Crash-Safe Team", joinPolicy: "open", publicMeta: true },
    {
      mayAuthorize: false,
      engine: mockEngine,
      storage,
      refreshWorkspaces: async () => ({ workspaces: [], candidates: [] }),
      approveAuthority: async (req) => {
        authFlows.push(req);
      },
      onWorkspaceSelected: (ws) => selectedWorkspaces.push(ws),
      setStatus: (s) => {
        lastStatus = s;
      },
      setError: (e) => {
        lastError = e;
      },
      setBusy: (b) => {
        busy = b;
      },
    },
  );
  assert.equal(createCalls[1]?.operationId, mintedOpId, "reuses exact operationId from pre-redirect attempt");
  assert.equal(journalState, null, "unstarted create journal dismissed when permission was declined");
  assert.equal(storageMap.has(WORKSPACE_OPERATION_KEY), false, "WORKSPACE_OPERATION_KEY cleared on declined OAuth");
  assert.match(lastError, /Permission was not granted/);
  assert.equal(busy, false);

  // 3. Operator `state: "pending"` keeps `WORKSPACE_OPERATION_KEY` and refuses `abortUnstartedWorkspaceCreation` once `groupDid` is bound;
  //    retry reuses same `operationId` and completes!
  nextMode = "pending";
  await executeBrowserWorkspaceCreation(
    { name: "Crash-Safe Team", joinPolicy: "open", publicMeta: true },
    {
      mayAuthorize: true,
      engine: mockEngine,
      storage,
      refreshWorkspaces: async () => ({ workspaces: [], candidates: [] }),
      approveAuthority: async () => {},
      onWorkspaceSelected: (ws) => selectedWorkspaces.push(ws),
      setStatus: (s) => {
        lastStatus = s;
      },
      setError: (e) => {
        lastError = e;
      },
      setBusy: (b) => {
        busy = b;
      },
    },
  );
  assert.match(lastStatus, /Setup is pending after 2 steps\. Temporary outage Retry to resume\./);
  const pendingOpId = createCalls.at(-1)!.operationId!;
  assert.equal(storageMap.has(WORKSPACE_OPERATION_KEY), true);
  assert.equal(
    await abortUnstartedWorkspaceCreation(mockWorkspaces, storage),
    false,
    "started create journal with groupDid must never be aborted",
  );
  assert.equal(storageMap.has(WORKSPACE_OPERATION_KEY), true);

  nextMode = "completed";
  const createdSummary: DiscoveredWorkspace = {
    ...makeWorkspace({ name: "Crash-Safe Team" }),
    rosterComplete: true,
    extensionsComplete: true,
    invalidRosterRecords: 0,
    invalidExtInstallRecords: 0,
  };
  await executeBrowserWorkspaceCreation(
    { name: "Crash-Safe Team", joinPolicy: "open", publicMeta: true },
    {
      mayAuthorize: true,
      engine: mockEngine,
      storage,
      refreshWorkspaces: async () => ({ workspaces: [createdSummary], candidates: [] }),
      approveAuthority: async () => {},
      onWorkspaceSelected: (ws) => selectedWorkspaces.push(ws),
      setStatus: (s) => {
        lastStatus = s;
      },
      setError: (e) => {
        lastError = e;
      },
      setBusy: (b) => {
        busy = b;
      },
    },
  );
  assert.equal(createCalls.at(-1)?.operationId, pendingOpId, "retry resumes exact pending operationId");
  assert.equal(lastStatus, "Workspace created on AT Protocol.");
  assert.deepEqual(selectedWorkspaces, [createdSummary.uri]);
  assert.equal(storageMap.has(WORKSPACE_OPERATION_KEY), false);

  // 4. Round 15 Fix #3: Pending Operator operations preserve uncompleted retry payloads across multiple operations
  //    and clear strictly by `operationId` compare-and-swap (never erasing another operation's retry pointer)!
  const opA = {
    workspace: createdSummary.uri,
    operationId: "3kopaaaaaaa01",
    request: {
      kind: "transitionChannel",
      skey: "general",
      visibility: "private",
      members: ["did:plc:alice0000000000000000000"],
    },
  };
  const opB = {
    workspace: createdSummary.uri,
    operationId: "3kopbbbbbbb02",
    request: { kind: "inviteMember", subject: "did:plc:bob000000000000000000000" },
  };
  const afterA = upsertPendingOperatorOperation(storage, opA);
  assert.deepEqual(afterA, [opA]);

  // Submitting `opB` while `opA` is pending promotes `opB` to top-of-stack WITHOUT erasing `opA`!
  const afterB = upsertPendingOperatorOperation(storage, opB);
  assert.deepEqual(afterB, [opA, opB]);
  assert.deepEqual(readPendingOperatorOperations(storage), [opA, opB]);

  // Terminal completion/failure of `opB` clears ONLY `opB`, restoring `opA` with its full `request` payload intact!
  const afterClearB = clearPendingOperatorOperation(storage, opB.operationId);
  assert.deepEqual(afterClearB, [opA]);
  assert.equal(storageMap.has(PENDING_OPERATOR_OPERATION_KEY), true);

  // Terminal completion of `opA` clears `opA` and removes `spaces.pendingOperatorOperation` cleanly!
  const afterClearA = clearPendingOperatorOperation(storage, opA.operationId);
  assert.deepEqual(afterClearA, []);
  assert.equal(storageMap.has(PENDING_OPERATOR_OPERATION_KEY), false);

  // Legacy single-object `sessionStorage` values still deserialize cleanly!
  storage.setItem(PENDING_OPERATOR_OPERATION_KEY, JSON.stringify(opA));
  assert.deepEqual(readPendingOperatorOperations(storage), [opA]);
  clearPendingOperatorOperation(storage, opA.operationId);
  assert.equal(storageMap.has(PENDING_OPERATOR_OPERATION_KEY), false);

  // 5. Round 17 Fix #1: Browser IndexedDB migration state codec (`serializePersistedGroupMigrationState` / `parsePersistedGroupMigrationState`)
  //    round-trips `pendingRefreshKey` cleanly and rejects malformed `pendingRefreshKey` values!
  const migStateWithRefreshKey = serializePersistedGroupMigrationState({
    revision: 3,
    operationId: "3lblr17mig0001",
    targetOrigin: "https://groups2.example.com",
    handle: "team.groups2.example.com",
    mode: "coordinated",
    negotiatedMode: "coordinated",
    targetServiceDid: "did:web:groups2.example.com",
    migrationTicket: "v1.ticket-1.secret-1",
    ticketId: "ticket-1",
    phase: "account_created",
    accessJwt: "eyJhbGciOiJFUzI1NiJ9.eyJzdWIiOiJkaWQ6cGxjOmdycCJ9.sig",
    refreshJwt: "refresh-tok-1",
    pendingRefreshKey: "migref-550e8400-e29b-41d4-a716-446655440000",
  });
  assert.equal(migStateWithRefreshKey.pendingRefreshKey, "migref-550e8400-e29b-41d4-a716-446655440000");
  const reparsedMigState = parsePersistedGroupMigrationState(migStateWithRefreshKey);
  assert.equal(reparsedMigState?.pendingRefreshKey, "migref-550e8400-e29b-41d4-a716-446655440000");
  const clearedMigState = serializePersistedGroupMigrationState({
    ...migStateWithRefreshKey,
    pendingRefreshKey: null,
  });
  assert.equal(clearedMigState.pendingRefreshKey, null);
  assert.equal(
    parsePersistedGroupMigrationState({ ...migStateWithRefreshKey, pendingRefreshKey: "bad space key!" }),
    null,
    "malformed pendingRefreshKey must fail validation",
  );
});
