import assert from "node:assert/strict";
import test from "node:test";
import { extSpaceUriFor } from "./extensions";
import { subjectKey, workspaceUri } from "./keys";
import { COLLECTION } from "./nsids";
import { assertWorkspaceWithinEnvelope, summarizeWorkspace, WORKSPACE_ENVELOPE, WorkspaceEnvelopeError, type ScannedRecords } from "./workspace-summary";

test("workspace envelope checks reject degraded state for operator mutations and inbox recovery", () => {
  assert.doesNotThrow(() => assertWorkspaceWithinEnvelope({ degradedReasons: [] }));
  assert.throws(() => assertWorkspaceWithinEnvelope({ degradedReasons: ["The active channel count exceeds 100 channels."] }),
    (error: unknown) => error instanceof WorkspaceEnvelopeError && error.status === 409 && /degraded mode/.test(error.message));
});

const AUTHORITY = "did:plc:authority";
const WORKSPACE = workspaceUri(AUTHORITY, "acme");
const NOW = "2026-11-11T12:00:00.000Z";
const scanned = (records: Array<{ rkey: string; value: Record<string, unknown> }>, truncated = false): ScannedRecords => ({ records, truncated });
const install = (did: string, active: boolean, channels = [{ skey: "acme-general", write: true }]) => ({
  rkey: subjectKey(did), value: { $type: COLLECTION.appInstall, subject: did, active, channels, installedBy: AUTHORITY, installedAt: NOW, updatedAt: NOW },
});
const directoryEntry = (skey: string, visibility: string) => ({ rkey: skey, value: { $type: COLLECTION.directory, skey, name: skey, visibility } });
const summaryWith = (installs: ScannedRecords) => summarizeWorkspace(WORKSPACE, AUTHORITY, {
  profiles: scanned([{ rkey: "self", value: { $type: COLLECTION.workspaceProfile, name: "Acme", createdAt: NOW } }]),
  directory: scanned([directoryEntry("acme-general", "public"), directoryEntry("acme-secret", "private"), directoryEntry("acme-old", "archived")]),
  roster: scanned([]), admins: scanned([]), installs,
});

test("a workspace's apps are its active installs, with their channels; an inactive or invalid install is no app", () => {
  const summary = summaryWith(scanned([
    install("did:plc:bot", true, [{ skey: "acme-general", write: true }, { skey: "acme-secret", write: false }]),
    install("did:plc:gone", false),
    { rkey: subjectKey("did:plc:other"), value: install("did:plc:liar", true).value },
  ]));
  assert.deepEqual(summary?.installs, [{ did: "did:plc:bot", channels: [{ skey: "acme-general", write: true }, { skey: "acme-secret", write: false }] }]);
  assert.deepEqual(summary?.degradedReasons, []);
});

test("more than twenty active apps, or an install scan cut short, puts the workspace in degraded mode", () => {
  const reasons = (installs: ScannedRecords) => (summaryWith(installs)?.degradedReasons ?? []).join(" ");
  assert.match(reasons(scanned(Array.from({ length: 21 }, (_, index) => install(`did:plc:bot${index}`, true)))), /active app count exceeds 20/);
  assert.match(reasons(scanned([], true)), /app list may be incomplete/);
});

test("an install grants no archived channel", () => {
  const summary = summaryWith(scanned([install("did:plc:bot", true, [{ skey: "acme-general", write: true }, { skey: "acme-old", write: true }])]));
  assert.deepEqual(summary?.installs, [{ did: "did:plc:bot", channels: [{ skey: "acme-general", write: true }] }]);
});

test("WORKSPACE_ENVELOPE exposes all D11.13 tasks and verified-sync limits", () => {
  assert.equal(WORKSPACE_ENVELOPE.extensions, 20);
  assert.equal(WORKSPACE_ENVELOPE.taskProjects, 100);
  assert.equal(WORKSPACE_ENVELOPE.tasks, 2_000);
  assert.equal(WORKSPACE_ENVELOPE.maxAncestorRefs, 256);
  assert.equal(WORKSPACE_ENVELOPE.maxCommentsPerTask, 200);
  assert.equal(WORKSPACE_ENVELOPE.maxStarArchiveBytes, 16 * 1024 * 1024);
  assert.equal(WORKSPACE_ENVELOPE.maxStarRecords, 20_000);
  assert.equal(WORKSPACE_ENVELOPE.maxRepoOpsPages, 128);
  assert.equal(WORKSPACE_ENVELOPE.maxListRecordsRetry, 3);
});

test("summarizeWorkspace parses valid ext.install records, drops invalid ones, and flags truncated extension scans", () => {
  const tasksSpace = extSpaceUriFor(AUTHORITY, "acme", "tasks");
  const validActive = {
    rkey: "tasks",
    value: {
      $type: COLLECTION.extInstall,
      extId: "tasks",
      active: true,
      space: tasksSpace,
      cleanupComplete: false,
      enabledBy: AUTHORITY,
      enabledAt: NOW,
      updatedAt: NOW,
    },
  };
  const invalidWrongSpace = {
    rkey: "tasks",
    value: {
      ...validActive.value,
      space: extSpaceUriFor(AUTHORITY, "other", "tasks"),
    },
  };
  const validDisabled = {
    rkey: "tasks",
    value: {
      ...validActive.value,
      active: false,
      cleanupComplete: true,
      disabledAt: NOW,
    },
  };

  const baseRecords = {
    profiles: scanned([{ rkey: "self", value: { $type: COLLECTION.workspaceProfile, name: "Acme", createdAt: NOW } }]),
    directory: scanned([directoryEntry("acme-general", "public")]),
    roster: scanned([]),
    admins: scanned([]),
    installs: scanned([]),
  };

  const omitted = summarizeWorkspace(WORKSPACE, AUTHORITY, baseRecords);
  assert.deepEqual(omitted?.extensions, []);
  assert.deepEqual(omitted?.degradedReasons, []);

  const enabled = summarizeWorkspace(WORKSPACE, AUTHORITY, {
    ...baseRecords,
    extInstalls: scanned([validActive, invalidWrongSpace]),
  });
  assert.deepEqual(enabled?.extensions, [{
    extId: "tasks",
    active: true,
    space: tasksSpace,
    cleanupComplete: false,
    enabledBy: AUTHORITY,
    enabledAt: NOW,
    updatedAt: NOW,
  }]);
  assert.deepEqual(enabled?.degradedReasons, []);

  const disabled = summarizeWorkspace(WORKSPACE, AUTHORITY, {
    ...baseRecords,
    extInstalls: scanned([validDisabled]),
  });
  assert.deepEqual(disabled?.extensions, [{
    extId: "tasks",
    active: false,
    space: tasksSpace,
    cleanupComplete: true,
    enabledBy: AUTHORITY,
    enabledAt: NOW,
    updatedAt: NOW,
    disabledAt: NOW,
  }]);

  const truncated = summarizeWorkspace(WORKSPACE, AUTHORITY, {
    ...baseRecords,
    extInstalls: scanned([], true),
  });
  assert.match((truncated?.degradedReasons ?? []).join(" "), /extension list may be incomplete/);

  const overEnvelope = summarizeWorkspace(WORKSPACE, AUTHORITY, {
    ...baseRecords,
    extInstalls: scanned(Array.from({ length: WORKSPACE_ENVELOPE.extensions + 1 }, () => validActive)),
  });
  assert.match((overEnvelope?.degradedReasons ?? []).join(" "), /active extension count exceeds 20/);
});
