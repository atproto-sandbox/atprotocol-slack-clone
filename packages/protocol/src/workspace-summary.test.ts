import assert from "node:assert/strict";
import test from "node:test";
import { extSpaceUriFor } from "./extensions";
import { appRoleKey, groupMembersUri, groupMetaUri, subjectKey, workspaceUri } from "./keys";
import {
  ATGRP_COLLECTION,
  ATGRP_POLICY,
  ATPROTO_SPACE_COLLECTION,
  COLLECTION,
  FLOCK_EXTENSION_FIELD,
} from "./nsids";
import { groupAdminScopes, groupModeratorScopes } from "./scopes";
import {
  assertWorkspaceWithinEnvelope,
  extractGroupSpacePolicyRecord,
  summarizeWorkspace,
  WORKSPACE_ENVELOPE,
  WorkspaceEnvelopeError,
  type ScannedRecords,
} from "./workspace-summary";

const GROUP_DID = "did:plc:abcdefghijklmnopqrstuvwx";
const ALICE = "did:plc:aliceabcdefghijklmnopqrs";
const BOB = "did:plc:bobabcdefghijklmnopqrstu";
const CAROL = "did:plc:carolabcdefghijklmnopqrs";
const DAVE = "did:plc:daveabcdefghijklmnopqrst";
const BOT = "did:plc:botabcdefghijklmnopqrstu";
const UNINSTALLED_BOT = "did:plc:oldbotabcdefghijklmnopqr";
const WORKSPACE = workspaceUri(GROUP_DID);
const NOW = "2026-11-11T12:00:00.000Z";

const scanned = (
  records: Array<{ rkey: string; cid?: string; value: Record<string, unknown> }>,
  truncated = false,
): ScannedRecords => ({
  records,
  truncated,
});

const defaultRoles = () =>
  scanned([
    {
      rkey: "admin",
      value: {
        $type: ATGRP_COLLECTION.role,
        displayName: "Admin",
        permissions: groupAdminScopes(GROUP_DID).filter((s) => s !== "atproto"),
        canAssign: ["*"],
      },
    },
    {
      rkey: "moderator",
      value: {
        $type: ATGRP_COLLECTION.role,
        displayName: "Moderator",
        permissions: groupModeratorScopes().filter((s) => s !== "atproto"),
        canAssign: ["member"],
      },
    },
    {
      rkey: "member",
      value: {
        $type: ATGRP_COLLECTION.role,
        // Omit optional displayName to verify it defaults to role ID ("member")
        default: true,
      },
    },
    {
      rkey: appRoleKey(BOT),
      value: {
        $type: ATGRP_COLLECTION.role,
        displayName: `App: ${BOT}`,
      },
    },
  ]);

const install = (did: string, active: boolean, channels = [{ skey: "acme-general", write: true }]) => ({
  rkey: subjectKey(did),
  value: {
    $type: COLLECTION.appInstall,
    subject: did,
    active,
    channels,
    installedBy: ALICE,
    installedAt: NOW,
    updatedAt: NOW,
  },
});

const directoryEntry = (skey: string, visibility: string) => ({
  rkey: skey,
  value: { $type: COLLECTION.directory, skey, name: skey, visibility },
});

test("workspace envelope checks reject degraded state for operator mutations", () => {
  assert.doesNotThrow(() => assertWorkspaceWithinEnvelope({ degradedReasons: [] }));
  assert.throws(
    () => assertWorkspaceWithinEnvelope({ degradedReasons: ["The active channel count exceeds 100 channels."] }),
    (error: unknown) => error instanceof WorkspaceEnvelopeError && error.status === 409 && /degraded mode/.test(error.message),
  );
  assert.equal(WORKSPACE_ENVELOPE.maxRolesPerMember, 100);
  assert.equal(WORKSPACE_ENVELOPE.maxPolicyGrantsPerSpace, 100);
  assert.equal(WORKSPACE_ENVELOPE.maxPrivateChannelsPerMember, 90);
});

test("bidirectional membership + confirmation pairing, non-gating admin/moderator authorization, <groupDid> & app exclusion, and website scheme filtering", () => {
  const summary = summarizeWorkspace(WORKSPACE, ALICE, {
    abouts: scanned([
      {
        rkey: "self",
        value: {
          $type: ATGRP_COLLECTION.about,
          displayName: "Acme",
          website: "https://acme.example/",
        },
      },
    ]),
    configs: scanned([
      {
        rkey: "self",
        value: {
          $type: ATGRP_COLLECTION.config,
          joinPolicy: "approval",
        },
      },
    ]),
    roles: defaultRoles(),
    memberships: scanned([
      // Alice: admin WITHOUT confirmation/self yet -> still holds isAdmin=true and admins=[ALICE], appears in pendingMembers!
      {
        rkey: ALICE,
        value: {
          $type: ATGRP_COLLECTION.membership,
          roles: ["admin", "member"],
          createdAt: NOW,
          [FLOCK_EXTENSION_FIELD.incarnation]: "inc-alice-1",
          [FLOCK_EXTENSION_FIELD.generation]: 1,
        },
      },
      // Bob: moderator WITH matching confirmation/self -> appears in members AND moderators!
      {
        rkey: BOB,
        value: {
          $type: ATGRP_COLLECTION.membership,
          roles: ["moderator", "member"],
          createdAt: NOW,
          [FLOCK_EXTENSION_FIELD.incarnation]: "inc-bob-1",
          [FLOCK_EXTENSION_FIELD.generation]: 1,
        },
      },
      // Active bot & uninstalled bot tombstone -> excluded from human members, pendingMembers, admins, moderators!
      {
        rkey: BOT,
        value: {
          $type: ATGRP_COLLECTION.membership,
          roles: [appRoleKey(BOT)],
          createdAt: NOW,
        },
      },
    ]),
    confirmations: [
      {
        repoDid: BOB,
        value: {
          $type: ATGRP_COLLECTION.confirmation,
          createdAt: NOW,
          [FLOCK_EXTENSION_FIELD.incarnation]: "inc-bob-1",
        },
      },
      // Carol: confirmation-only (ejected / no membership) -> excluded completely!
      {
        repoDid: CAROL,
        value: {
          $type: ATGRP_COLLECTION.confirmation,
          createdAt: NOW,
          [FLOCK_EXTENSION_FIELD.incarnation]: "inc-carol-old",
        },
      },
    ],
    directory: scanned([
      directoryEntry("acme-general", "public"),
      directoryEntry("acme-secret", "private"),
      directoryEntry("acme-old", "archived"),
    ]),
    installs: scanned([
      install(BOT, true, [
        { skey: "acme-general", write: true },
        { skey: "acme-old", write: true },
      ]),
      install(UNINSTALLED_BOT, false, []),
    ]),
  });

  assert.ok(summary);
  assert.equal(summary.name, "Acme");
  assert.equal(summary.website, "https://acme.example/");
  assert.equal(summary.joinPolicy, "approval");
  assert.equal(summary.roles.find((r) => r.rkey === "member")?.displayName, "member");
  // Authorization is NEVER gated on confirmation/self!
  assert.equal(summary.isAdmin, true);
  assert.deepEqual(summary.admins, [ALICE]);
  assert.deepEqual(summary.moderators, [ALICE, BOB]);
  // Bidirectional roster display: Bob confirmed, Alice pending, Carol & bots excluded!
  assert.deepEqual(summary.members, [{ did: BOB, active: true, roles: ["moderator", "member"] }]);
  assert.deepEqual(summary.pendingMembers, [{ did: ALICE, roles: ["admin", "member"] }]);
  assert.deepEqual(summary.installs, [{ did: BOT, channels: [{ skey: "acme-general", write: true }] }]);
  assert.deepEqual(summary.degradedReasons, []);

  // javascript: website stripped to undefined in summary
  const unsafeSite = summarizeWorkspace(WORKSPACE, ALICE, {
    abouts: scanned([{ rkey: "self", value: { $type: ATGRP_COLLECTION.about, displayName: "XSS", website: "javascript:alert(1)" } }]),
    configs: scanned([{ rkey: "self", value: { $type: ATGRP_COLLECTION.config, joinPolicy: "open" } }]),
    roles: defaultRoles(),
    memberships: scanned([]),
    directory: scanned([]),
    installs: scanned([]),
  });
  assert.equal(unsafeSite?.website, undefined);
});

test("rejects 2099 future-dated pre-ejection unversioned confirmation, wrong extension types, and leading k..z invalid TIDs", () => {
  const makeSummary = (
    bobWriter: { repoRev: string; spaceRev: string } | undefined,
    daveMembershipExtra: Record<string, unknown>,
  ) =>
    summarizeWorkspace(WORKSPACE, ALICE, {
      abouts: scanned([{ rkey: "self", value: { $type: ATGRP_COLLECTION.about, displayName: "Acme" } }]),
      configs: scanned([{ rkey: "self", value: { $type: ATGRP_COLLECTION.config, joinPolicy: "invite" } }]),
      roles: defaultRoles(),
      memberships: scanned([
        {
          rkey: BOB,
          value: {
            $type: ATGRP_COLLECTION.membership,
            roles: ["member"],
            createdAt: NOW,
            [FLOCK_EXTENSION_FIELD.incarnation]: "inc-bob-2",
            [FLOCK_EXTENSION_FIELD.generation]: 2,
            [FLOCK_EXTENSION_FIELD.admittedSpaceRev]: "222222222222a",
            [FLOCK_EXTENSION_FIELD.afterWriterRev]: "2222222222225",
          },
        },
        {
          rkey: CAROL,
          value: {
            $type: ATGRP_COLLECTION.membership,
            roles: ["member"],
            createdAt: NOW,
            [FLOCK_EXTENSION_FIELD.incarnation]: "inc-carol-2",
            [FLOCK_EXTENSION_FIELD.generation]: 2,
            [FLOCK_EXTENSION_FIELD.admittedSpaceRev]: "222222222222a",
            [FLOCK_EXTENSION_FIELD.afterWriterRev]: null,
          },
        },
        {
          rkey: DAVE,
          value: {
            $type: ATGRP_COLLECTION.membership,
            roles: ["member"],
            createdAt: NOW,
            ...daveMembershipExtra,
          },
        },
      ]),
      confirmations: [
        {
          repoDid: BOB,
          value: { $type: ATGRP_COLLECTION.confirmation, createdAt: "2099-01-01T00:00:00.000Z" },
        },
        {
          repoDid: CAROL,
          value: { $type: ATGRP_COLLECTION.confirmation, createdAt: "2099-01-01T00:00:00.000Z" },
        },
        {
          repoDid: DAVE,
          value: { $type: ATGRP_COLLECTION.confirmation, createdAt: NOW },
        },
      ],
      memberWriters: new Map([
        ...(bobWriter ? [[BOB, bobWriter] as const] : []),
        [CAROL, { repoRev: "222222222222b", spaceRev: "222222222222b" }],
        [DAVE, { repoRev: "222222222222b", spaceRev: "222222222222b" }],
      ]),
      directory: scanned([]),
      installs: scanned([]),
    });

  const stale = makeSummary(
    { repoRev: "2222222222225", spaceRev: "222222222222b" },
    { [FLOCK_EXTENSION_FIELD.admittedSpaceRev]: "k222222222222" },
  );
  assert.deepEqual(stale?.members, []);
  assert.deepEqual(stale?.pendingMembers.map((m) => m.did), [BOB, CAROL], "Dave's invalid leading-'k' TID record is rejected fail-closed");

  const advanced = makeSummary(
    { repoRev: "222222222222b", spaceRev: "222222222222b" },
    { [FLOCK_EXTENSION_FIELD.generation]: "2" },
  );
  assert.deepEqual(advanced?.members, [{ did: BOB, active: true, roles: ["member"] }]);
  assert.deepEqual(advanced?.pendingMembers.map((m) => m.did), [CAROL]);
});

test("summarizeWorkspace parses ext.install records and flags truncated or over-envelope scans", () => {
  const tasksSpace = extSpaceUriFor(GROUP_DID, "self", "tasks");
  const validActive = {
    rkey: "tasks",
    value: {
      $type: COLLECTION.extInstall,
      extId: "tasks",
      active: true,
      space: tasksSpace,
      cleanupComplete: false,
      enabledBy: ALICE,
      enabledAt: NOW,
      updatedAt: NOW,
    },
  };
  const summary = summarizeWorkspace(WORKSPACE, ALICE, {
    abouts: scanned([{ rkey: "self", value: { $type: ATGRP_COLLECTION.about, displayName: "Acme" } }]),
    configs: scanned([{ rkey: "self", value: { $type: ATGRP_COLLECTION.config, joinPolicy: "open" } }]),
    roles: defaultRoles(),
    memberships: scanned([]),
    directory: scanned([directoryEntry("acme-general", "public")]),
    installs: scanned([]),
    extInstalls: scanned([validActive]),
    spacePolicies: new Map([
      [groupMembersUri(GROUP_DID), { grants: [{ role: "admin", read: true, write: true }] }],
      [groupMetaUri(GROUP_DID), { grants: [{ role: "admin", read: true }] }],
    ]),
  });
  assert.equal(summary?.extensions?.length, 1);
  assert.equal(summary?.publicMeta, false, "meta/self policy without publicRead: true sets publicMeta: false");
  assert.deepEqual(summary?.degradedReasons, []);
});

test("summarizeWorkspace derives publicMeta from meta/self policy and withholds !takedown-labeled members from roster while preserving governance roles", () => {
  const summary = summarizeWorkspace(WORKSPACE, ALICE, {
    abouts: scanned([{ rkey: "self", value: { $type: ATGRP_COLLECTION.about, displayName: "ModTeam" } }]),
    configs: scanned([{ rkey: "self", value: { $type: ATGRP_COLLECTION.config, joinPolicy: "invite" } }]),
    roles: defaultRoles(),
    memberships: scanned([
      {
        rkey: ALICE,
        value: {
          $type: ATGRP_COLLECTION.membership,
          roles: ["admin", "member"],
          createdAt: NOW,
          [FLOCK_EXTENSION_FIELD.incarnation]: "inc-a",
          [FLOCK_EXTENSION_FIELD.generation]: 1,
        },
      },
      {
        rkey: BOB,
        value: {
          $type: ATGRP_COLLECTION.membership,
          roles: ["member"],
          createdAt: NOW,
          [FLOCK_EXTENSION_FIELD.incarnation]: "inc-b",
          [FLOCK_EXTENSION_FIELD.generation]: 1,
        },
      },
      {
        rkey: CAROL,
        value: {
          $type: ATGRP_COLLECTION.membership,
          roles: ["member"],
          createdAt: NOW,
          [FLOCK_EXTENSION_FIELD.incarnation]: "inc-c",
          [FLOCK_EXTENSION_FIELD.generation]: 1,
        },
      },
    ]),
    confirmations: [
      { repoDid: ALICE, value: { $type: ATGRP_COLLECTION.confirmation, createdAt: NOW, [FLOCK_EXTENSION_FIELD.incarnation]: "inc-a" } },
      { repoDid: BOB, value: { $type: ATGRP_COLLECTION.confirmation, createdAt: NOW, [FLOCK_EXTENSION_FIELD.incarnation]: "inc-b" } },
    ],
    directory: scanned([]),
    installs: scanned([]),
    spacePolicies: new Map([
      [groupMembersUri(GROUP_DID), { grants: [{ role: "admin", read: true, write: true }, { role: "member", read: true, write: true }] }],
      [groupMetaUri(GROUP_DID), { publicRead: true, grants: [{ role: "member", read: true }] }],
    ]),
    accountLabels: [
      { rkey: "2222222222222", uri: BOB, val: "!takedown", cts: NOW, ctsMs: Date.parse(NOW) },
      { rkey: "2222222222223", uri: CAROL, val: "!takedown", cts: NOW, ctsMs: Date.parse(NOW) },
    ],
  });

  assert.ok(summary);
  assert.equal(summary.publicMeta, true);
  assert.deepEqual(summary.members.map((m) => m.did), [ALICE]);
  assert.deepEqual(summary.pendingMembers, []);
  assert.deepEqual(summary.takendownMembers, [BOB, CAROL]);
  assert.deepEqual(summary.admins, [ALICE]);
});

test("summarizeWorkspace matches legacy-cid:<cid> bilateral confirmations on imported unversioned memberships while rejecting mismatched CIDs or missing CIDs", () => {
  const aliceCid = "bafyreiimportedalicecid00001";
  const bobCid = "bafyreiimportedbobcid000002";
  const daveCid = "bafyreiversioneddavecid0003";

  const summary = summarizeWorkspace(WORKSPACE, ALICE, {
    abouts: scanned([{ rkey: "self", value: { $type: ATGRP_COLLECTION.about, displayName: "ImportedGroup" } }]),
    configs: scanned([{ rkey: "self", value: { $type: ATGRP_COLLECTION.config, joinPolicy: "invite" } }]),
    roles: defaultRoles(),
    memberships: scanned([
      {
        rkey: ALICE,
        cid: aliceCid,
        value: {
          $type: ATGRP_COLLECTION.membership,
          roles: ["admin", "member"],
          createdAt: NOW,
        },
      },
      {
        rkey: BOB,
        cid: bobCid,
        value: {
          $type: ATGRP_COLLECTION.membership,
          roles: ["member"],
          createdAt: NOW,
        },
      },
      {
        rkey: CAROL,
        value: {
          $type: ATGRP_COLLECTION.membership,
          roles: ["member"],
          createdAt: NOW,
        },
      },
      {
        rkey: DAVE,
        cid: daveCid,
        value: {
          $type: ATGRP_COLLECTION.membership,
          roles: ["member"],
          createdAt: NOW,
          [FLOCK_EXTENSION_FIELD.incarnation]: "inc-dave-explicit",
          [FLOCK_EXTENSION_FIELD.generation]: 1,
        },
      },
    ]),
    confirmations: [
      {
        repoDid: ALICE,
        value: {
          $type: ATGRP_COLLECTION.confirmation,
          createdAt: NOW,
          [FLOCK_EXTENSION_FIELD.incarnation]: `legacy-cid:${aliceCid}`,
        },
      },
      {
        repoDid: BOB,
        value: {
          $type: ATGRP_COLLECTION.confirmation,
          createdAt: NOW,
          [FLOCK_EXTENSION_FIELD.incarnation]: "legacy-cid:bafyreistaleoldcid999999",
        },
      },
      {
        repoDid: CAROL,
        value: {
          $type: ATGRP_COLLECTION.confirmation,
          createdAt: NOW,
          [FLOCK_EXTENSION_FIELD.incarnation]: "legacy-cid:bafyreicarolcid",
        },
      },
      {
        repoDid: DAVE,
        value: {
          $type: ATGRP_COLLECTION.confirmation,
          createdAt: NOW,
          [FLOCK_EXTENSION_FIELD.incarnation]: `legacy-cid:${daveCid}`,
        },
      },
    ],
    directory: scanned([]),
    installs: scanned([]),
  });

  assert.ok(summary);
  assert.deepEqual(summary.members, [{ did: ALICE, active: true, roles: ["admin", "member"] }]);
  assert.deepEqual(
    summary.pendingMembers.map((m) => m.did),
    [BOB, CAROL, DAVE].sort(),
  );
});

test("extractGroupSpacePolicyRecord requires explicit outer com.atproto.space.policy $type and inner org.atgrp.policy $type", () => {
  const metaSpace = groupMetaUri(GROUP_DID);
  const valid = extractGroupSpacePolicyRecord(
    GROUP_DID,
    metaSpace,
    scanned([
      {
        rkey: "self",
        value: {
          $type: ATPROTO_SPACE_COLLECTION.spacePolicy,
          policy: {
            $type: ATGRP_POLICY,
            publicRead: true,
            unlisted: false,
            grants: [{ role: "admin", read: true }],
          },
        },
      },
    ]),
  );
  assert.equal(valid.valid, true);
  assert.equal(valid.policy?.publicRead, true);

  const missingOuterType = extractGroupSpacePolicyRecord(
    GROUP_DID,
    metaSpace,
    scanned([
      {
        rkey: "self",
        value: {
          policy: {
            $type: ATGRP_POLICY,
            publicRead: true,
            unlisted: false,
            grants: [{ role: "admin", read: true }],
          },
        },
      },
    ]),
  );
  assert.deepEqual(missingOuterType, { policy: null, valid: false });
});
