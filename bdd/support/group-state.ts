import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { channelRoleKey, groupMembersUri, parseSpaceUri, parseWorkspaceUri } from "@flock/protocol/keys";
import { COLLECTION, OPENSOCIAL_COLLECTION } from "@flock/protocol/nsids";
import {
  effectiveHumanAdmins,
  type EffectiveGovernanceState,
  type GroupMembershipRecord,
  type GroupOpenSocialPolicy,
  type GroupRoleRecord,
} from "@flock/protocol/scopes";
import type { AppWorld } from "./world";

export type GroupSpaceMember = { did: string; read: boolean; write: boolean };

export type StoredGroupSpaceRecord = {
  rkey: string;
  cid: string;
  uri: string;
  value: Record<string, unknown>;
};

export function groupDidOf(world: AppWorld): string {
  const parsed = parseWorkspaceUri(world.workspaceUri);
  assert.ok(parsed, `expected a valid workspace URI, got "${world.workspaceUri}"`);
  return parsed.authorityDid;
}

/** Resolves a DID's PDS or Group Host origin within this scenario's fixture network. */
export function resolvePdsOrigin(world: AppWorld, did: string): string {
  const knownActor = [...world.actors.values()].find((actor) => actor.did === did);
  if (knownActor) return knownActor.pdsUrl;
  return world.fixture.groupHostUrl.origin;
}

function withGroupDb<T>(world: AppWorld, read: (db: Database.Database) => T): T {
  const db = new Database(world.fixture.groupHostDatabasePath, { readonly: true, fileMustExist: true });
  try {
    db.pragma("busy_timeout = 5000");
    return read(db);
  } finally {
    db.close();
  }
}

function withWritableGroupDb<T>(world: AppWorld, mutate: (db: Database.Database) => T): T {
  const db = new Database(world.fixture.groupHostDatabasePath, { fileMustExist: true });
  try {
    db.pragma("busy_timeout = 5000");
    return mutate(db);
  } finally {
    db.close();
  }
}

export function groupSpaceUris(world: AppWorld, groupDid: string, spaceType?: string): string[] {
  return withGroupDb(world, (db) => {
    const rows = spaceType
      ? (db
          .prepare("SELECT space_uri FROM group_space WHERE group_did = ? AND space_type = ? AND deleted_at IS NULL ORDER BY space_uri ASC")
          .all(groupDid, spaceType) as Array<{ space_uri: string }>)
      : (db
          .prepare("SELECT space_uri FROM group_space WHERE group_did = ? AND deleted_at IS NULL ORDER BY space_uri ASC")
          .all(groupDid) as Array<{ space_uri: string }>);
    return rows.map((row) => row.space_uri);
  });
}

export function groupSpacePolicy(world: AppWorld, spaceUri: string): GroupOpenSocialPolicy | undefined {
  return withGroupDb(world, (db) => {
    const row = db
      .prepare("SELECT policy_json FROM group_space WHERE space_uri = ? AND deleted_at IS NULL")
      .get(spaceUri) as { policy_json: string } | undefined;
    return row ? (JSON.parse(row.policy_json) as GroupOpenSocialPolicy) : undefined;
  });
}

export function groupSpacePolicies(world: AppWorld, groupDid: string): Map<string, GroupOpenSocialPolicy> {
  return withGroupDb(world, (db) => {
    const rows = db
      .prepare("SELECT space_uri, policy_json FROM group_space WHERE group_did = ? AND deleted_at IS NULL")
      .all(groupDid) as Array<{ space_uri: string; policy_json: string }>;
    const map = new Map<string, GroupOpenSocialPolicy>();
    for (const row of rows) {
      map.set(row.space_uri, JSON.parse(row.policy_json) as GroupOpenSocialPolicy);
    }
    return map;
  });
}

export function groupSpaceRecords(
  world: AppWorld,
  spaceUri: string,
  collection: string,
  repoDid?: string,
): StoredGroupSpaceRecord[] {
  const ownerDid = repoDid ?? parseSpaceUri(spaceUri)?.authorityDid;
  assert.ok(ownerDid, `cannot determine repo DID for ${spaceUri}`);
  return withGroupDb(world, (db) => {
    const rows = db
      .prepare(
        "SELECT rkey, cid, uri, value FROM space_record WHERE space_uri = ? AND repo_did = ? AND collection = ? ORDER BY rkey ASC",
      )
      .all(spaceUri, ownerDid, collection) as Array<{ rkey: string; cid: string; uri: string; value: string }>;
    return rows.map((row) => ({
      rkey: row.rkey,
      cid: row.cid,
      uri: row.uri,
      value: JSON.parse(row.value) as Record<string, unknown>,
    }));
  });
}

export function groupSpaceRecord(
  world: AppWorld,
  spaceUri: string,
  collection: string,
  rkey: string,
  repoDid?: string,
): Record<string, unknown> | undefined {
  const ownerDid = repoDid ?? parseSpaceUri(spaceUri)?.authorityDid;
  assert.ok(ownerDid, `cannot determine repo DID for ${spaceUri}`);
  return withGroupDb(world, (db) => {
    const row = db
      .prepare("SELECT value FROM space_record WHERE space_uri = ? AND repo_did = ? AND collection = ? AND rkey = ?")
      .get(spaceUri, ownerDid, collection, rkey) as { value: string } | undefined;
    return row ? (JSON.parse(row.value) as Record<string, unknown>) : undefined;
  });
}

export function groupGovernanceState(
  world: AppWorld,
  groupDid: string,
): EffectiveGovernanceState & { knownAppSubjects: ReadonlySet<string> } {
  return withGroupDb(world, (db) => {
    const membersSpace = groupMembersUri(groupDid);
    const roleRows = db
      .prepare("SELECT rkey, value FROM space_record WHERE space_uri = ? AND repo_did = ? AND collection = ?")
      .all(membersSpace, groupDid, OPENSOCIAL_COLLECTION.role) as Array<{ rkey: string; value: string }>;
    const roles = new Map<string, GroupRoleRecord>();
    for (const row of roleRows) {
      const parsed = JSON.parse(row.value) as Record<string, unknown>;
      roles.set(row.rkey, {
        displayName: String(parsed.displayName ?? row.rkey),
        ...(typeof parsed.description === "string" ? { description: parsed.description } : {}),
        default: parsed.default === true,
        scopes: Array.isArray(parsed.scopes) ? (parsed.scopes as string[]) : [],
        assignable: Array.isArray(parsed.assignable) ? (parsed.assignable as string[]) : [],
      });
    }

    const membershipRows = db
      .prepare("SELECT rkey, value FROM space_record WHERE space_uri = ? AND repo_did = ? AND collection = ?")
      .all(membersSpace, groupDid, OPENSOCIAL_COLLECTION.membership) as Array<{ rkey: string; value: string }>;
    const memberships = new Map<string, GroupMembershipRecord>();
    for (const row of membershipRows) {
      const parsed = JSON.parse(row.value) as Record<string, unknown>;
      memberships.set(row.rkey, {
        ...(parsed as GroupMembershipRecord),
        roles: Array.isArray(parsed.roles) ? (parsed.roles as string[]) : [],
        createdAt: String(parsed.createdAt ?? ""),
      });
    }

    const policyRows = db
      .prepare("SELECT space_uri, policy_json FROM group_space WHERE group_did = ? AND deleted_at IS NULL")
      .all(groupDid) as Array<{ space_uri: string; policy_json: string }>;
    const spacePolicies = new Map<string, GroupOpenSocialPolicy>();
    for (const row of policyRows) {
      spacePolicies.set(row.space_uri, JSON.parse(row.policy_json) as GroupOpenSocialPolicy);
    }

    const appRows = db
      .prepare("SELECT subject_did FROM known_app_subject WHERE group_did = ?")
      .all(groupDid) as Array<{ subject_did: string }>;
    const knownAppSubjects = new Set<string>(appRows.map((row) => row.subject_did));
    const installRows = db
      .prepare("SELECT value FROM space_record WHERE space_uri = ? AND repo_did = ? AND collection = ?")
      .all(`at:space/${groupDid}/new.flock.workspace/self`, groupDid, COLLECTION.appInstall) as Array<{ value: string }>;
    for (const row of installRows) {
      const parsed = JSON.parse(row.value) as { subject?: unknown };
      if (typeof parsed.subject === "string") knownAppSubjects.add(parsed.subject);
    }

    return { roles, memberships, spacePolicies, knownAppSubjects };
  });
}

/** Effective human members with read and/or write access on `spaceUri` under OpenSocial flat RBAC. */
export function groupSpaceMembers(world: AppWorld, spaceUri: string): GroupSpaceMember[] {
  const parsed = parseSpaceUri(spaceUri);
  assert.ok(parsed, `invalid space URI: ${spaceUri}`);
  const groupDid = parsed.authorityDid;
  const state = groupGovernanceState(world, groupDid);
  const policy = state.spacePolicies.get(spaceUri);
  if (!policy) return [];

  const members: GroupSpaceMember[] = [];
  for (const [did, membership] of state.memberships.entries()) {
    if (did === groupDid || state.knownAppSubjects.has(did)) continue;
    const heldRoles = new Set(membership.roles);
    let read = policy.publicRead === true;
    let write = false;
    for (const grant of policy.grants) {
      if (!heldRoles.has(grant.role)) continue;
      if (grant.read === true) read = true;
      if (grant.write === true) write = true;
    }
    if (read || write) {
      members.push({ did, read, write });
    }
  }
  return members.sort((left, right) => left.did.localeCompare(right.did));
}

export function groupHumanMemberDids(world: AppWorld, groupDid: string): string[] {
  const state = groupGovernanceState(world, groupDid);
  return [...state.memberships.keys()]
    .filter((did) => did !== groupDid && !state.knownAppSubjects.has(did))
    .sort();
}

export function groupHasHumanMember(world: AppWorld, groupDid: string, did: string): boolean {
  const state = groupGovernanceState(world, groupDid);
  return did !== groupDid && !state.knownAppSubjects.has(did) && state.memberships.has(did);
}

export function groupEffectiveAdmins(world: AppWorld, groupDid: string): string[] {
  const state = groupGovernanceState(world, groupDid);
  return effectiveHumanAdmins(state, groupDid);
}

export function groupPrivateChannelRoster(world: AppWorld, groupDid: string, channelSkey: string): string[] {
  const roleKey = channelRoleKey(channelSkey);
  const state = groupGovernanceState(world, groupDid);
  return [...state.memberships.entries()]
    .filter(([did, membership]) => did !== groupDid && !state.knownAppSubjects.has(did) && membership.roles.includes(roleKey))
    .map(([did]) => did)
    .sort();
}

// --- Surgical SQLite trigger faults on Group Host for pending-operation recovery tests ---------------

function sanitizeTriggerSuffix(groupDid: string): string {
  return groupDid.replace(/[^a-zA-Z0-9_]/g, "_");
}

/**
 * Blocks `group.opensocial.membership` writes (insert/update) on `groupDid`, so multi-step operations like
 * `transitionChannel` complete `channel-set-transitioning` and stop in `state = 'pending'` on membership role assignment.
 */
export function injectGroupMembershipWriteFault(world: AppWorld, groupDid: string): void {
  const suffix = sanitizeTriggerSuffix(groupDid);
  const membersSpace = groupMembersUri(groupDid).replace(/'/g, "''");
  withWritableGroupDb(world, (db) => {
    db.exec(`
      CREATE TRIGGER IF NOT EXISTS bdd_fault_mem_ins_${suffix}
      BEFORE INSERT ON space_record
      WHEN NEW.space_uri = '${membersSpace}' AND NEW.collection = '${OPENSOCIAL_COLLECTION.membership}'
      BEGIN
        SELECT RAISE(ABORT, 'bdd injected membership write fault');
      END;
      CREATE TRIGGER IF NOT EXISTS bdd_fault_mem_upd_${suffix}
      BEFORE UPDATE ON space_record
      WHEN NEW.space_uri = '${membersSpace}' AND NEW.collection = '${OPENSOCIAL_COLLECTION.membership}'
      BEGIN
        SELECT RAISE(ABORT, 'bdd injected membership write fault');
      END;
    `);
  });
  world.teardown.push(async () => clearGroupMembershipWriteFault(world, groupDid));
}

export function clearGroupMembershipWriteFault(world: AppWorld, groupDid: string): void {
  const suffix = sanitizeTriggerSuffix(groupDid);
  withWritableGroupDb(world, (db) => {
    db.exec(`
      DROP TRIGGER IF EXISTS bdd_fault_mem_ins_${suffix};
      DROP TRIGGER IF EXISTS bdd_fault_mem_upd_${suffix};
    `);
  });
}

/** Blocks `group.opensocial.membership` deletes on `groupDid`, so `removeMember` stops in `state = 'pending'`. */
export function injectGroupMembershipDeleteFault(world: AppWorld, groupDid: string): void {
  const suffix = sanitizeTriggerSuffix(groupDid);
  const membersSpace = groupMembersUri(groupDid).replace(/'/g, "''");
  withWritableGroupDb(world, (db) => {
    db.exec(`
      CREATE TRIGGER IF NOT EXISTS bdd_fault_mem_del_${suffix}
      BEFORE DELETE ON space_record
      WHEN OLD.space_uri = '${membersSpace}' AND OLD.collection = '${OPENSOCIAL_COLLECTION.membership}'
      BEGIN
        SELECT RAISE(ABORT, 'bdd injected membership delete fault');
      END;
    `);
  });
  world.teardown.push(async () => clearGroupMembershipDeleteFault(world, groupDid));
}

export function clearGroupMembershipDeleteFault(world: AppWorld, groupDid: string): void {
  const suffix = sanitizeTriggerSuffix(groupDid);
  withWritableGroupDb(world, (db) => {
    db.exec(`DROP TRIGGER IF EXISTS bdd_fault_mem_del_${suffix};`);
  });
}
