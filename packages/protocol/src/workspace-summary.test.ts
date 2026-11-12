import assert from "node:assert/strict";
import test from "node:test";
import { subjectKey, workspaceUri } from "./keys";
import { COLLECTION } from "./nsids";
import { assertWorkspaceWithinEnvelope, summarizeWorkspace, WorkspaceEnvelopeError, type ScannedRecords } from "./workspace-summary";

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
