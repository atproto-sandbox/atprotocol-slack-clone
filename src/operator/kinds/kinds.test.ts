import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { stepMatcher } from "../journal";
import { FIELD_RULES } from "../operations";
import { OPERATION_KINDS, operationKind } from ".";

// A journal row is replayed by its kind's name, request fields and step names. Changing any of them strands rows an earlier
// release wrote, so this table only ever grows by a new kind.
const PERSISTED_KINDS = {
  bootstrapWorkspace: {
    required: ["name"], optional: [], actor: "authority", submittedThrough: "createWorkspace",
    steps: ["workspace-space", "inbox-space", "general-channel-space", "workspace-profile", "owner-roster", "owner-admin", "general-directory"],
  },
  inviteMember: {
    required: ["subject"], optional: [], actor: "admin", submittedThrough: "execute",
    steps: ["member-workspace", "member-inbox-writer", "member-public-channel-{skey}", "member-workspace-roster", "member-state-verified"],
  },
  removeMember: {
    required: ["subject"], optional: [], actor: "admin", submittedThrough: "execute",
    steps: ["remove-inbox-membership", "remove-channel-{skey}", "remove-workspace-membership", "deactivate-workspace-roster", "deactivate-admin", "removal-verified"],
  },
  setAdmin: {
    required: ["subject", "active"], optional: [], actor: "admin", submittedThrough: "execute",
    steps: ["write-admin-active", "grant-inbox-read", "remove-inbox-read", "write-admin-inactive", "admin-state-verified"],
  },
  createChannel: {
    required: ["skey", "name", "visibility"], optional: ["members"], actor: "admin", submittedThrough: "execute",
    steps: ["channel-space", "channel-member-{did}", "channel-roster-{did}", "channel-directory", "channel-membership-verified"],
  },
  transitionChannel: {
    required: ["skey", "visibility"], optional: ["members"], actor: "admin", submittedThrough: "execute",
    steps: [
      "channel-set-transitioning", "channel-public-add-{did}", "channel-remove-{did}", "channel-roster-inactive-{did}", "channel-private-add-{did}",
      "channel-roster-active-{did}", "channel-visibility-verified", "channel-set-final-visibility",
    ],
  },
  archiveChannel: {
    required: ["skey"], optional: [], actor: "admin", submittedThrough: "execute",
    steps: ["channel-archive-transition", "channel-archive-remove-{did}", "channel-archive-roster-{did}", "channel-archive-verified", "channel-archive-final"],
  },
  decideJoinRequest: {
    required: ["request", "requestId", "decision"], optional: [], actor: "admin", submittedThrough: "execute",
    steps: [
      "join-request-baseline-{state}", "join-request-inactive-revoke-membership", "join-request-inactive-deactivate-roster", "join-request-channel-membership",
      "join-request-private-roster", "join-request-decision", "join-request-approved-membership-verified", "join-request-stale-restore-membership",
      "join-request-stale-restore-roster",
    ],
  },
  leaveWorkspace: {
    required: [], optional: [], actor: "member", submittedThrough: "execute",
    steps: ["remove-inbox-membership", "remove-channel-{skey}", "remove-workspace-membership", "deactivate-workspace-roster", "deactivate-admin", "removal-verified"],
  },
  leaveChannel: {
    required: ["skey"], optional: [], actor: "member", submittedThrough: "execute",
    steps: ["leave-channel-membership", "leave-channel-roster", "leave-channel-verified"],
  },
  reconcileWorkspace: {
    required: [], optional: [], actor: "admin", submittedThrough: "execute",
    steps: [
      "workspace-set-{did}", "workspace-remove-{did}", "workspace-verified", "inbox-set-{did}", "inbox-remove-{did}", "inbox-verified",
      "channel-{skey}-set-{did}", "channel-{skey}-remove-{did}", "channel-{skey}-verified", "channel-{skey}-deactivate-stale-roster-{did}",
      "archived-{skey}-set-{did}", "archived-{skey}-remove-{did}", "archived-{skey}-verified", "archived-{skey}-deactivate-roster-{did}",
    ],
  },
};

test("every persisted operation kind keeps its name, request fields, actor and step names", () => {
  // #given the kind table
  // #when each kind is reduced to what a journal row depends on
  const actual = Object.fromEntries(Object.values(OPERATION_KINDS).map((kind) => [kind.kind, {
    required: kind.required, optional: kind.optional ?? [], actor: kind.actor, submittedThrough: kind.submittedThrough, steps: kind.steps,
  }]));

  // #then it is exactly the released table
  assert.deepEqual(actual, PERSISTED_KINDS);
});

test("step names that earlier releases recorded are still declared by their kind", () => {
  // #given step names as the code before the kind table wrote them, with real values in place of the placeholders
  const recorded: Record<string, string[]> = {
    createChannel: ["channel-space", "channel-member-did:plc:member", "channel-roster-did:plc:member", "channel-directory", "channel-membership-verified"],
    inviteMember: ["member-public-channel-acme-1a2b3c4d5e-general"],
    decideJoinRequest: ["join-request-baseline-1-0", "join-request-baseline-0-1"],
    reconcileWorkspace: [
      "workspace-set-did:plc:member", "inbox-verified", "channel-acme-general-set-did:web:example.com",
      "channel-acme-general-deactivate-stale-roster-did:plc:member", "archived-acme-old-deactivate-roster-did:plc:member",
    ],
    transitionChannel: ["channel-roster-inactive-did:plc:member", "channel-set-final-visibility"],
  };

  // #then each one is accepted by its kind's declared steps
  for (const [kind, names] of Object.entries(recorded)) {
    const declared = stepMatcher(operationKind(kind)!.steps);
    for (const name of names) assert.equal(declared(name), true, `${kind}: ${name}`);
  }
});

test("a step name its kind does not declare is refused, including a placeholder left empty", () => {
  // #given createChannel's declared steps
  const declared = stepMatcher(operationKind("createChannel")!.steps);

  // #then names outside them are refused
  for (const name of ["channel-spaces", "channel-member-", "member-workspace", "xchannel-space"]) assert.equal(declared(name), false, name);
});

test("only names in the table are kinds, never inherited object keys", () => {
  assert.equal(operationKind("toString"), undefined);
  assert.equal(operationKind("__proto__"), undefined);
  assert.equal(operationKind(42), undefined);
});

test("every step a kind's run body records is a step that kind declares", async () => {
  // #given each kind module's source and the kinds it exports
  const directory = join("src", "operator", "kinds");
  let checked = 0;
  for (const file of readdirSync(directory).filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts") && !["index.ts", "kind.ts"].includes(name))) {
    const source = readFileSync(join(directory, file), "utf8");
    const exports = await import(`./${file.replace(/\.ts$/, "")}`) as Record<string, unknown>;
    const declared = Object.values(exports).flatMap((value) => isKind(value) ? [stepMatcher(value.steps)] : []);
    assert.ok(declared.length > 0, `${file} exports a kind`);
    // A value in a step name stands for any value; the reconcile helper's label is each label it is called with.
    const value = (template: string) => template.replace(/\$\{[^}]+\}/g, "value");
    const labels = [...source.matchAll(/reconcileSpace\(actor, context, ["`]([^"`]+)["`]/g)].map((match) => value(match[1]!));
    const calls = [...source.matchAll(/context\.step\(\s*["`]([^"`]+)["`]/g)].map((match) => match[1]!);
    assert.equal(calls.length, (source.match(/\.step\(/g) ?? []).length, `${file}: every step call names its step inline`);
    assert.ok(calls.length > 0, `${file} records steps`);
    const names = calls.flatMap((call) => call.startsWith("${label}") ? labels.map((label) => value(call.replace("${label}", label))) : [value(call)]);

    // #then each recorded name is declared by a kind in the same module
    for (const name of names) assert.ok(declared.some((matches) => matches(name)), `${file}: step "${name}" is not declared`);
    checked += calls.length;
  }
  assert.equal(checked, 58, "every context.step call in the kind modules was checked");
});

function isKind(value: unknown): value is { kind: string; steps: readonly string[] } {
  return typeof value === "object" && value !== null && "kind" in value && "steps" in value && Array.isArray((value as { steps: unknown }).steps);
}

test("every request field a kind declares has a validation rule", () => {
  for (const kind of Object.values(OPERATION_KINDS)) {
    for (const field of [...kind.required, ...(kind.optional ?? [])]) assert.ok(Object.hasOwn(FIELD_RULES, field), `${kind.kind}: ${field}`);
  }
});

test("only a request that takes away its submitter's own role says so", () => {
  const ME = "did:plc:me";
  const OTHER = "did:plc:other";
  const ends = (request: { kind: string } & Record<string, unknown>) => operationKind(request.kind)?.endsOwnRole?.(request, ME) ?? false;

  // #then exactly four kinds have the rule
  assert.deepEqual(
    Object.values(OPERATION_KINDS).filter((kind) => kind.endsOwnRole).map((kind) => kind.kind).sort(),
    ["leaveChannel", "leaveWorkspace", "removeMember", "setAdmin"],
  );

  // #then a leave always does, and a removal or demotion only when it names the submitter
  for (const request of [
    { kind: "leaveWorkspace" }, { kind: "leaveChannel", skey: "design" },
    { kind: "removeMember", subject: ME }, { kind: "setAdmin", subject: ME, active: false },
  ]) assert.equal(ends(request), true, JSON.stringify(request));
  for (const request of [
    { kind: "removeMember", subject: OTHER }, { kind: "setAdmin", subject: OTHER, active: false }, { kind: "setAdmin", subject: ME, active: true },
  ]) assert.equal(ends(request), false, JSON.stringify(request));
});

test("the request lexicon gives a channel name the limits of the directory record that will carry it", () => {
  const lexicon = (path: string) => JSON.parse(readFileSync(join(process.cwd(), "lexicons/new/flock", path), "utf8"));
  assert.deepEqual(
    lexicon("operator/execute.json").defs.operationRequest.properties.name,
    lexicon("directory.json").defs.main.record.properties.name,
  );
});
