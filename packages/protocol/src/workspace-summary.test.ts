import assert from "node:assert/strict";
import test from "node:test";
import { extSpaceUriFor } from "./extensions";
import { appRoleKey, groupMembersUri, groupMetaUri, subjectKey, workspaceUri } from "./keys";
import {
  ATPROTO_SPACE_COLLECTION,
  COLLECTION,
  FLOCK_EXTENSION_FIELD,
  OPENSOCIAL_COLLECTION,
  OPENSOCIAL_POLICY,
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
        $type: OPENSOCIAL_COLLECTION.role,
        displayName: "Admin",
        scopes: groupAdminScopes(GROUP_DID).filter((s) => s !== "atproto"),
        assignable: ["*"],
      },
    },
    {
      rkey: "moderator",
      value: {
        $type: OPENSOCIAL_COLLECTION.role,
        displayName: "Moderator",
        scopes: groupModeratorScopes().filter((s) => s !== "atproto"),
        assignable: ["member"],
      },
    },
    {
      rkey: "member",
      value: {
        $type: OPENSOCIAL_COLLECTION.role,
        displayName: "Member",
        default: true,
      },
    },
    {
      rkey: appRoleKey(BOT),
      value: {
        $type: OPENSOCIAL_COLLECTION.role,
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

test("bidirectional membership + acceptance pairing, non-gating admin/moderator authorization, <groupDid> & app exclusion", () => {
  const summary = summarizeWorkspace(WORKSPACE, ALICE, {
    profiles: scanned([
      {
        rkey: "self",
        value: {
          $type: OPENSOCIAL_COLLECTION.profile,
          displayName: "Acme",
          joinPolicy: "approval",
          url: "https://acme.example/",
        },
      },
    ]),
    roles: defaultRoles(),
    memberships: scanned([
      // Alice: admin WITHOUT acceptance/self yet -> still holds isAdmin=true and admins=[ALICE], appears in pendingMembers!
      {
        rkey: ALICE,
        value: {
          $type: OPENSOCIAL_COLLECTION.membership,
          roles: ["admin", "member"],
          createdAt: NOW,
          [FLOCK_EXTENSION_FIELD.incarnation]: "inc-alice-1",
          [FLOCK_EXTENSION_FIELD.generation]: 1,
        },
      },
      // Bob: moderator WITH matching acceptance/self -> appears in members AND moderators!
      {
        rkey: BOB,
        value: {
          $type: OPENSOCIAL_COLLECTION.membership,
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
          $type: OPENSOCIAL_COLLECTION.membership,
          roles: [appRoleKey(BOT)],
          createdAt: NOW,
        },
      },
    ]),
    acceptances: [
      {
        repoDid: BOB,
        value: {
          $type: OPENSOCIAL_COLLECTION.acceptance,
          createdAt: NOW,
          [FLOCK_EXTENSION_FIELD.incarnation]: "inc-bob-1",
        },
      },
      // Carol: acceptance-only (ejected / no membership) -> excluded completely!
      {
        repoDid: CAROL,
        value: {
          $type: OPENSOCIAL_COLLECTION.acceptance,
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
  assert.equal(summary.joinPolicy, "approval");
  // Authorization is NEVER gated on acceptance/self!
  assert.equal(summary.isAdmin, true);
  assert.deepEqual(summary.admins, [ALICE]);
  assert.deepEqual(summary.moderators, [ALICE, BOB]);
  // Bidirectional roster display: Bob confirmed, Alice pending, Carol & bots excluded!
  assert.deepEqual(summary.members, [{ did: BOB, active: true, roles: ["moderator", "member"] }]);
  assert.deepEqual(summary.pendingMembers, [{ did: ALICE, roles: ["admin", "member"] }]);
  assert.deepEqual(summary.installs, [{ did: BOT, channels: [{ skey: "acme-general", write: true }] }]);
  assert.deepEqual(summary.degradedReasons, []);
});

test("rejects 2099 future-dated pre-ejection unversioned acceptance, wrong extension types, and leading k..z invalid TIDs", () => {
  // Bob was ejected at writerRev 2222222222225 and re-admitted at admittedSpaceRev 2222222222228 (generation: 2).
  // Bob left a future-dated 2099 unversioned acceptance/self on his personal PDS at repoRev 2222222222225!
  const makeSummary = (
    bobWriter: { repoRev: string; spaceRev: string } | undefined,
    daveMembershipExtra: Record<string, unknown>,
  ) =>
    summarizeWorkspace(WORKSPACE, ALICE, {
      profiles: scanned([{ rkey: "self", value: { $type: OPENSOCIAL_COLLECTION.profile, displayName: "Acme", joinPolicy: "invite" } }]),
      roles: defaultRoles(),
      memberships: scanned([
        {
          rkey: BOB,
          value: {
            $type: OPENSOCIAL_COLLECTION.membership,
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
            $type: OPENSOCIAL_COLLECTION.membership,
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
            $type: OPENSOCIAL_COLLECTION.membership,
            roles: ["member"],
            createdAt: NOW,
            ...daveMembershipExtra,
          },
        },
      ]),
      acceptances: [
        {
          repoDid: BOB,
          // Self-reported 2099 timestamp without incarnation stamp!
          value: { $type: OPENSOCIAL_COLLECTION.acceptance, createdAt: "2099-01-01T00:00:00.000Z" },
        },
        {
          repoDid: CAROL,
          // Self-reported 2099 timestamp when afterWriterRev === null on gen >= 2 -> must NOT restore!
          value: { $type: OPENSOCIAL_COLLECTION.acceptance, createdAt: "2099-01-01T00:00:00.000Z" },
        },
        {
          repoDid: DAVE,
          value: { $type: OPENSOCIAL_COLLECTION.acceptance, createdAt: NOW },
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

  // 1. Pre-ejection writerRev (<= afterWriterRev) + leading-'k' invalid TID on Dave -> BOTH excluded from members!
  const stale = makeSummary(
    { repoRev: "2222222222225", spaceRev: "222222222222b" },
    { [FLOCK_EXTENSION_FIELD.admittedSpaceRev]: "k222222222222" },
  );
  assert.deepEqual(stale?.members, []);
  assert.deepEqual(stale?.pendingMembers.map((m) => m.did), [BOB, CAROL], "Dave's invalid leading-'k' TID record is rejected fail-closed");

  // 2. Wrong extension type on Dave (`generation: "2"`) -> rejected fail-closed;
  //    Genuinely new post-readmission commit by Bob (`repoRev > afterWriterRev && spaceRev > admittedSpaceRev`) -> Bob enters members, Carol (afterWriterRev === null without incarnation) stays pending!
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
    profiles: scanned([{ rkey: "self", value: { $type: OPENSOCIAL_COLLECTION.profile, displayName: "Acme", joinPolicy: "open" } }]),
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
    profiles: scanned([{ rkey: "self", value: { $type: OPENSOCIAL_COLLECTION.profile, displayName: "ModTeam", joinPolicy: "invite" } }]),
    roles: defaultRoles(),
    memberships: scanned([
      {
        rkey: ALICE,
        value: {
          $type: OPENSOCIAL_COLLECTION.membership,
          roles: ["admin", "member"],
          createdAt: NOW,
          [FLOCK_EXTENSION_FIELD.incarnation]: "inc-a",
          [FLOCK_EXTENSION_FIELD.generation]: 1,
        },
      },
      {
        rkey: BOB,
        value: {
          $type: OPENSOCIAL_COLLECTION.membership,
          roles: ["member"],
          createdAt: NOW,
          [FLOCK_EXTENSION_FIELD.incarnation]: "inc-b",
          [FLOCK_EXTENSION_FIELD.generation]: 1,
        },
      },
      {
        rkey: CAROL,
        value: {
          $type: OPENSOCIAL_COLLECTION.membership,
          roles: ["member"],
          createdAt: NOW,
          [FLOCK_EXTENSION_FIELD.incarnation]: "inc-c",
          [FLOCK_EXTENSION_FIELD.generation]: 1,
        },
      },
    ]),
    acceptances: [
      { repoDid: ALICE, value: { $type: OPENSOCIAL_COLLECTION.acceptance, createdAt: NOW, [FLOCK_EXTENSION_FIELD.incarnation]: "inc-a" } },
      { repoDid: BOB, value: { $type: OPENSOCIAL_COLLECTION.acceptance, createdAt: NOW, [FLOCK_EXTENSION_FIELD.incarnation]: "inc-b" } },
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

test("summarizeWorkspace matches legacy-cid:<cid> bilateral acceptances on imported unversioned memberships while rejecting mismatched CIDs or missing CIDs", () => {
  const aliceCid = "bafyreiimportedalicecid00001";
  const bobCid = "bafyreiimportedbobcid000002";
  const daveCid = "bafyreiversioneddavecid0003";

  const summary = summarizeWorkspace(WORKSPACE, ALICE, {
    profiles: scanned([
      {
        rkey: "self",
        value: { $type: OPENSOCIAL_COLLECTION.profile, displayName: "ImportedGroup", joinPolicy: "invite" },
      },
    ]),
    roles: defaultRoles(),
    memberships: scanned([
      // Alice: imported unversioned membership + matching `legacy-cid:<aliceCid>` acceptance -> confirmed in `members`!
      {
        rkey: ALICE,
        cid: aliceCid,
        value: {
          $type: OPENSOCIAL_COLLECTION.membership,
          roles: ["admin", "member"],
          createdAt: NOW,
        },
      },
      // Bob: imported unversioned membership + stale `legacy-cid:<other>` acceptance -> stays in `pendingMembers`!
      {
        rkey: BOB,
        cid: bobCid,
        value: {
          $type: OPENSOCIAL_COLLECTION.membership,
          roles: ["member"],
          createdAt: NOW,
        },
      },
      // Carol: unversioned membership WITHOUT `cid` + `legacy-cid:...` acceptance -> stays in `pendingMembers`!
      {
        rkey: CAROL,
        value: {
          $type: OPENSOCIAL_COLLECTION.membership,
          roles: ["member"],
          createdAt: NOW,
        },
      },
      // Dave: explicit `new.flock.incarnation` on membership + `legacy-cid:<daveCid>` acceptance -> never falls back to `legacy-cid:`, stays in `pendingMembers`!
      {
        rkey: DAVE,
        cid: daveCid,
        value: {
          $type: OPENSOCIAL_COLLECTION.membership,
          roles: ["member"],
          createdAt: NOW,
          [FLOCK_EXTENSION_FIELD.incarnation]: "inc-dave-explicit",
          [FLOCK_EXTENSION_FIELD.generation]: 1,
        },
      },
    ]),
    acceptances: [
      {
        repoDid: ALICE,
        value: {
          $type: OPENSOCIAL_COLLECTION.acceptance,
          createdAt: NOW,
          [FLOCK_EXTENSION_FIELD.incarnation]: `legacy-cid:${aliceCid}`,
        },
      },
      {
        repoDid: BOB,
        value: {
          $type: OPENSOCIAL_COLLECTION.acceptance,
          createdAt: NOW,
          [FLOCK_EXTENSION_FIELD.incarnation]: "legacy-cid:bafyreistaleoldcid999999",
        },
      },
      {
        repoDid: CAROL,
        value: {
          $type: OPENSOCIAL_COLLECTION.acceptance,
          createdAt: NOW,
          [FLOCK_EXTENSION_FIELD.incarnation]: "legacy-cid:bafyreicarolcid",
        },
      },
      {
        repoDid: DAVE,
        value: {
          $type: OPENSOCIAL_COLLECTION.acceptance,
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

test("extractGroupSpacePolicyRecord requires explicit outer com.atproto.space.policy $type and inner group.opensocial.policy $type", () => {
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
            $type: OPENSOCIAL_POLICY,
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

  // Wrapper missing outer `$type` MUST be rejected fail-closed!
  const missingOuterType = extractGroupSpacePolicyRecord(
    GROUP_DID,
    metaSpace,
    scanned([
      {
        rkey: "self",
        value: {
          policy: {
            $type: OPENSOCIAL_POLICY,
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
