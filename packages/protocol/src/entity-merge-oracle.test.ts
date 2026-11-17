import assert from "node:assert/strict";
import test from "node:test";
import {
  advanceHlc,
  buildEditClosure,
  compareOpOrder,
  formatHlc,
  MAX_ANCESTOR_REFS,
  mergeTask,
  opId,
  opRef,
  type StoredEntityRecord,
  type TaskActivityEvent,
  type TaskEditRecordValue,
  type TaskRecordValue,
} from "./entity-merge";
import { canonicalJson, spaceRecordUri, tasksSpaceUri } from "./keys";
import { COLLECTION } from "./nsids";

const AUTHORITY = "did:plc:authority";
const ALICE = "did:plc:alice";
const BOB = "did:plc:bob";
const CAROL = "did:plc:carol";
const SPACE = tasksSpaceUri(AUTHORITY, "acme");
const CREATED_AT = "2026-11-16T00:00:00.000Z";
const BASE_MS = 1_700_000_000_000;

function tidFor(n: number): string {
  const alphabet = "234567abcdefghijklmnopqrstuvwxyz";
  let v = n;
  let suffix = "";
  for (let i = 0; i < 6; i += 1) {
    suffix = alphabet[v % 32] + suffix;
    v = Math.floor(v / 32);
  }
  return `3k33333${suffix}`;
}

type SimOp = {
  isRoot: boolean;
  repo: string;
  rkey: string;
  id: string;
  ref: string;
  t: string;
  title?: string;
  deleted?: boolean;
  addLabels?: readonly string[];
  removeLabels?: readonly string[];
  record?: StoredEntityRecord<TaskEditRecordValue>;
};

type OracleResult = {
  deleted: boolean;
  title: string;
  otherTitleLosers: string[];
  labels: string[];
  activityIds: string[];
};

/**
 * Completely independent reference oracle computed strictly from ground-truth `groundPast` sets
 * (never reading `op.s` or `opRef` edges from records).
 */
function evaluateGroundTruthOracle(
  root: StoredEntityRecord<TaskRecordValue>,
  ops: readonly SimOp[],
  groundPast: ReadonlyMap<string, ReadonlySet<string>>,
): OracleResult {
  const happensBefore = (a: SimOp, b: SimOp): boolean => a.id !== b.id && (groundPast.get(b.id)?.has(a.id) ?? false);
  const rootOp = ops.find((op) => op.isRoot)!;
  const allOps = [rootOp, ...ops.filter((op) => !op.isRoot)];

  // 1. Lifecycle delete/restore.
  const deletes = allOps.filter((op) => op.deleted === true);
  const restores = allOps.filter((op) => op.deleted === false);
  const activeDeletes = deletes.filter((d) => !restores.some((r) => happensBefore(d, r)));
  const deleted = activeDeletes.length > 0;

  const activityIds: string[] = [];
  if (deleted) {
    for (const op of allOps) {
      if (op.isRoot || op.deleted === true) continue;
      if (activeDeletes.some((d) => happensBefore(op, d))) continue;
      const concurrentActiveDeletes = activeDeletes.filter((d) => !happensBefore(op, d) && !happensBefore(d, op));
      if (concurrentActiveDeletes.length === 0) continue;
      const overwritingDelete = concurrentActiveDeletes.reduce((best, cur) => (compareOpOrder(cur, best) > 0 ? cur : best));
      activityIds.push(`delete:${root.uri}:${overwritingDelete.id}:${op.id}`);
    }
  }

  // 2. Scalar field LWW (title) with equal-value suppression.
  const touchingTitle = allOps.filter((op) => op.title !== undefined);
  const maxTitle = touchingTitle
    .filter((op) => !touchingTitle.some((other) => other.id !== op.id && happensBefore(op, other)))
    .sort((a, b) => compareOpOrder(b, a));
  const titleWinner = maxTitle[0]!;
  const winnerCanonical = canonicalJson(titleWinner.title ?? null);
  const otherTitleLosers: string[] = [];
  for (let i = 1; i < maxTitle.length; i += 1) {
    const loser = maxTitle[i]!;
    if (canonicalJson(loser.title ?? null) === winnerCanonical) continue;
    otherTitleLosers.push(loser.id);
    activityIds.push(`field:${root.uri}:title:${titleWinner.id}:${loser.id}`);
  }

  // 3. OR-Set (labels) add-wins + concurrentSetConflict.
  const allLabels = new Set<string>();
  for (const op of allOps) {
    for (const label of op.addLabels ?? []) allLabels.add(label);
  }
  const labels: string[] = [];
  for (const label of allLabels) {
    const adds = allOps.filter((op) => op.addLabels?.includes(label));
    const removes = allOps.filter((op) => op.removeLabels?.includes(label));
    const activeAdds = adds.filter((a) => !removes.some((r) => happensBefore(a, r)));
    if (activeAdds.length === 0) continue;
    labels.push(label);

    const unresolvedRemoves = removes.filter((r) => !activeAdds.some((a) => happensBefore(r, a)));
    if (unresolvedRemoves.length === 0) continue;
    const winner = activeAdds.reduce((best, cur) => (compareOpOrder(cur, best) > 0 ? cur : best));
    const loser = unresolvedRemoves.reduce((best, cur) => (compareOpOrder(cur, best) > 0 ? cur : best));
    activityIds.push(`set:${root.uri}:labels:${label}:${winner.id}:${loser.id}`);
  }

  labels.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  activityIds.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

  return {
    deleted,
    title: titleWinner.title!,
    otherTitleLosers,
    labels,
    activityIds,
  };
}

function assertMatchesOracle(
  root: StoredEntityRecord<TaskRecordValue>,
  ops: readonly SimOp[],
  groundPast: ReadonlyMap<string, ReadonlySet<string>>,
  permuteSeed: number,
) {
  const oracle = evaluateGroundTruthOracle(root, ops, groundPast);
  const editRecords = ops.filter((op) => !op.isRoot).map((op) => op.record!);
  // Permute arrival order deterministically by rotating & reversing on odd seeds.
  const offset = editRecords.length > 0 ? permuteSeed % editRecords.length : 0;
  const rotated = [...editRecords.slice(offset), ...editRecords.slice(0, offset)];
  const permuted = permuteSeed % 2 === 1 ? rotated.reverse() : rotated;

  const merged = mergeTask(root, permuted);
  assert.ok(merged);
  assert.equal(merged.uncertainAncestry, false);
  assert.equal(merged.lifecycleFinal, true);
  assert.equal(merged.conflictFinal, true);
  assert.equal(merged.deleted, oracle.deleted);
  assert.equal(merged.title, oracle.title);
  assert.deepEqual(
    (merged.otherVersions.title ?? []).map((v) => v.opId),
    oracle.otherTitleLosers,
  );
  assert.deepEqual(merged.labels, oracle.labels);
  assert.deepEqual(
    merged.activities.map((a: TaskActivityEvent) => a.id),
    oracle.activityIds,
  );
}

test("brute-force full-DAG event-history oracle: multi-device DID, skewed/coarse clocks, scalar equal-values, delete/restore, OR-Set, arrival permutations", () => {
  // 3 devices across 2 DIDs: device 0 = ALICE, device 1 = ALICE (same-DID multi-device!), device 2 = BOB.
  const devices = [ALICE, ALICE, BOB] as const;
  const clockOffsets = [0, 35, -35] as const;
  const rootRkey = tidFor(1);
  const rootT = formatHlc({ ms: BASE_MS, counter: 0 });
  const root: StoredEntityRecord<TaskRecordValue> = {
    uri: spaceRecordUri(SPACE, ALICE, COLLECTION.task, rootRkey),
    repo: ALICE,
    rkey: rootRkey,
    value: {
      title: "Init",
      status: "todo",
      priority: "none",
      labels: ["tag"],
      t: rootT,
      createdAt: CREATED_AT,
    },
  };
  const rootOp: SimOp = {
    isRoot: true,
    repo: ALICE,
    rkey: rootRkey,
    id: opId(ALICE, rootRkey),
    ref: opRef(ALICE, rootRkey),
    t: rootT,
    title: "Init",
    addLabels: ["tag"],
  };

  type Action =
    | { kind: "title"; value: string }
    | { kind: "deleted"; value: boolean }
    | { kind: "addLabel"; value: string }
    | { kind: "removeLabel"; value: string };

  const actions: Action[] = [
    { kind: "title", value: "Same" },
    { kind: "title", value: "Alt" },
    { kind: "deleted", value: true },
    { kind: "deleted", value: false },
    { kind: "addLabel", value: "tag" },
    { kind: "removeLabel", value: "tag" },
  ];

  type SimState = {
    step: number;
    nextSeq: number;
    allOps: SimOp[];
    groundPast: Map<string, Set<string>>;
    deviceOwnLast: [string | null, string | null, string | null];
    deviceObserved: [SimOp[], SimOp[], SimOp[]];
  };

  const initPast = new Map<string, Set<string>>([[rootOp.id, new Set([rootOp.id])]]);
  const initialState: SimState = {
    step: 0,
    nextSeq: 2,
    allOps: [rootOp],
    groundPast: initPast,
    deviceOwnLast: [rootT, null, null],
    deviceObserved: [[rootOp], [rootOp], [rootOp]],
  };

  let statesChecked = 0;
  const MAX_DEPTH = 4;

  function cloneState(s: SimState): SimState {
    return {
      step: s.step,
      nextSeq: s.nextSeq,
      allOps: s.allOps.slice(),
      groundPast: new Map([...s.groundPast.entries()].map(([k, v]) => [k, new Set(v)])),
      deviceOwnLast: [s.deviceOwnLast[0], s.deviceOwnLast[1], s.deviceOwnLast[2]],
      deviceObserved: [s.deviceObserved[0].slice(), s.deviceObserved[1].slice(), s.deviceObserved[2].slice()],
    };
  }

  function applyWrite(s: SimState, deviceIdx: 0 | 1 | 2, action: Action): SimState {
    const next = cloneState(s);
    const repo = devices[deviceIdx];
    const rkey = tidFor(next.nextSeq++);
    const observed = next.deviceObserved[deviceIdx];
    const rawWall = BASE_MS + next.step * 10 + clockOffsets[deviceIdx];
    // Coarse 25ms clock quantization to force equal-ms ties across skewed devices.
    const coarseWall = Math.floor(rawWall / 25) * 25;
    const t = advanceHlc({
      wallNowMs: coarseWall,
      ownLast: next.deviceOwnLast[deviceIdx],
      observedTs: observed.map((op) => op.t),
    });
    const closure = buildEditClosure({
      observedOps: observed.map((op) => ({
        repo: op.repo,
        rkey: op.rkey,
        t: op.t,
        s: op.record?.value.s,
        isRoot: op.isRoot,
      })),
    });
    const value: TaskEditRecordValue = {
      subject: root.uri,
      t,
      s: closure.s,
      ...(action.kind === "title" ? { title: action.value } : {}),
      ...(action.kind === "deleted" ? { deleted: action.value } : {}),
      ...(action.kind === "addLabel" ? { addLabels: [action.value] } : {}),
      ...(action.kind === "removeLabel" ? { removeLabels: [action.value] } : {}),
    };
    const record: StoredEntityRecord<TaskEditRecordValue> = {
      uri: spaceRecordUri(SPACE, repo, COLLECTION.taskEdit, rkey),
      repo,
      rkey,
      value,
    };
    const newOpId = opId(repo, rkey);
    const newOp: SimOp = {
      isRoot: false,
      repo,
      rkey,
      id: newOpId,
      ref: opRef(repo, rkey),
      t,
      ...(action.kind === "title" ? { title: action.value } : {}),
      ...(action.kind === "deleted" ? { deleted: action.value } : {}),
      ...(action.kind === "addLabel" ? { addLabels: [action.value] } : {}),
      ...(action.kind === "removeLabel" ? { removeLabels: [action.value] } : {}),
      record,
    };
    const past = new Set<string>([newOpId]);
    for (const obs of observed) {
      for (const ancestorId of next.groundPast.get(obs.id)!) past.add(ancestorId);
    }
    next.groundPast.set(newOpId, past);
    next.allOps.push(newOp);
    next.deviceOwnLast[deviceIdx] = t;
    next.deviceObserved[deviceIdx].push(newOp);
    next.step += 1;
    return next;
  }

  function applySync(s: SimState, targetIdx: 0 | 1 | 2, sourceIdx: 0 | 1 | 2): SimState | null {
    const targetSeen = new Set(s.deviceObserved[targetIdx].map((op) => op.id));
    const unseenFromSource = s.deviceObserved[sourceIdx].filter((op) => !targetSeen.has(op.id));
    if (unseenFromSource.length === 0) return null;
    const next = cloneState(s);
    next.deviceObserved[targetIdx].push(...unseenFromSource);
    next.step += 1;
    return next;
  }

  function explore(s: SimState, depth: number) {
    assertMatchesOracle(root, s.allOps, s.groundPast, statesChecked);
    statesChecked += 1;
    if (depth === 0) return;

    // Limit branching symmetrically to keep full state space exhaustive within ~1-2 seconds in CI:
    // at depth 4, pick a representative subset of actions per step + all pairwise syncs.
    const stepActions: Action[] = depth % 2 === 0
      ? [actions[0]!, actions[1]!, actions[2]!]
      : [actions[0]!, actions[3]!, actions[4]!, actions[5]!];

    for (const deviceIdx of [0, 1, 2] as const) {
      for (const action of stepActions) {
        explore(applyWrite(s, deviceIdx, action), depth - 1);
      }
    }
    for (const targetIdx of [0, 1, 2] as const) {
      for (const sourceIdx of [0, 1, 2] as const) {
        if (targetIdx === sourceIdx) continue;
        const synced = applySync(s, targetIdx, sourceIdx);
        if (synced) explore(synced, depth - 1);
      }
    }
  }

  explore(initialState, MAX_DEPTH);
  assert.ok(statesChecked > 1000, `explored ${statesChecked} full-DAG states`);
});

test("oracle verifies intermediate writer removal (D -> B -> R without B) and exact 255/256/257 + purged overflow cold-read parity", () => {
  const rootRkey = tidFor(1);
  const rootT = formatHlc({ ms: BASE_MS, counter: 0 });
  const root: StoredEntityRecord<TaskRecordValue> = {
    uri: spaceRecordUri(SPACE, ALICE, COLLECTION.task, rootRkey),
    repo: ALICE,
    rkey: rootRkey,
    value: {
      title: "Root",
      status: "backlog",
      priority: "medium",
      labels: ["alpha"],
      t: rootT,
      createdAt: CREATED_AT,
    },
  };

  const groundPast = new Map<string, Set<string>>([[opId(ALICE, rootRkey), new Set([opId(ALICE, rootRkey)])]]);
  const allOps: SimOp[] = [{
    isRoot: true,
    repo: ALICE,
    rkey: rootRkey,
    id: opId(ALICE, rootRkey),
    ref: opRef(ALICE, rootRkey),
    t: rootT,
    title: "Root",
    addLabels: ["alpha"],
  }];

  const appendOp = (
    repo: string,
    seq: number,
    observed: SimOp[],
    patch: Omit<TaskEditRecordValue, "subject" | "t" | "s" | "sTruncated">,
  ): SimOp => {
    const rkey = tidFor(seq);
    const t = advanceHlc({
      wallNowMs: BASE_MS + seq * 10,
      observedTs: observed.map((o) => o.t),
    });
    const closure = buildEditClosure({
      observedOps: observed.map((o) => ({
        repo: o.repo,
        rkey: o.rkey,
        t: o.t,
        s: o.record?.value.s,
        sTruncated: o.record?.value.sTruncated,
        deleted: o.deleted,
        isRoot: o.isRoot,
      })),
    });
    const value: TaskEditRecordValue = {
      subject: root.uri,
      t,
      s: closure.s,
      ...(closure.sTruncated ? { sTruncated: true } : {}),
      ...patch,
    };
    const op: SimOp = {
      isRoot: false,
      repo,
      rkey,
      id: opId(repo, rkey),
      ref: opRef(repo, rkey),
      t,
      title: patch.title,
      deleted: patch.deleted,
      addLabels: patch.addLabels,
      removeLabels: patch.removeLabels,
      record: { uri: spaceRecordUri(SPACE, repo, COLLECTION.taskEdit, rkey), repo, rkey, value },
    };
    const past = new Set<string>([op.id]);
    for (const obs of observed) {
      for (const id of groundPast.get(obs.id)!) past.add(id);
    }
    groundPast.set(op.id, past);
    allOps.push(op);
    return op;
  };

  // Build D (Alice) -> B (Bob) -> R (Carol) plus OR-Set & equal-value branches, then purge Bob!
  const dOp = appendOp(ALICE, 2, [allOps[0]!], { deleted: true, removeLabels: ["alpha"] });
  const bOp = appendOp(BOB, 3, [allOps[0]!, dOp], { title: "Bob intermediate", addLabels: ["alpha"] });
  const rOp = appendOp(CAROL, 4, [allOps[0]!, dOp, bOp], { deleted: false, title: "Restored" });
  const eqA = appendOp(ALICE, 5, [allOps[0]!, dOp, bOp, rOp], { title: "Converged" });
  const eqC = appendOp(CAROL, 6, [allOps[0]!, dOp, bOp, rOp], { title: "Converged" });

  // Remove Bob's ops under D14: surviving ops still have exact transitive groundPast projection & match cold merge!
  const survivingOps = allOps.filter((op) => op.repo !== BOB);
  assertMatchesOracle(root, survivingOps, groundPast, 0);
  assertMatchesOracle(root, survivingOps, groundPast, 1);
  assertMatchesOracle(root, survivingOps, groundPast, 3);
  void eqA;
  void eqC;

  // Exact 255 -> 256 (final, matches oracle!) -> 257 (saturated, non-final) transitions.
  let seq = 10;
  const frontier = [...allOps];
  while (frontier.length < 255) {
    const writer = frontier.length % 3 === 0 ? ALICE : frontier.length % 3 === 1 ? BOB : CAROL;
    const nextOp = appendOp(writer, seq++, frontier, { title: `Step ${seq}` });
    frontier.push(nextOp);
  }
  assert.equal(frontier.length, 255);
  assertMatchesOracle(root, frontier, groundPast, 2);

  // Add 256th op (closure of length 255 -> total 256 ops including this one -> STILL final!).
  const op256 = appendOp(ALICE, seq++, frontier, { title: "Step 256" });
  frontier.push(op256);
  assert.equal(frontier.length, 256);
  assert.equal(op256.record?.value.s.length, 255);
  assert.equal(op256.record?.value.sTruncated, undefined);
  assertMatchesOracle(root, frontier, groundPast, 4);

  // Add 257th op (closure size = 256 -> s.length = 256, STILL final!).
  const op257 = appendOp(BOB, seq++, frontier, { title: "Step 257" });
  frontier.push(op257);
  assert.equal(op257.record?.value.s.length, MAX_ANCESTOR_REFS);
  assert.equal(op257.record?.value.sTruncated, undefined);
  assertMatchesOracle(root, frontier, groundPast, 5);

  // Add 258th op (closure size = 257 > 256 -> saturated sTruncated: true, non-final!).
  const op258 = appendOp(CAROL, seq++, frontier, { title: "Step 258" });
  frontier.push(op258);
  assert.equal(op258.record?.value.s.length, MAX_ANCESTOR_REFS);
  assert.equal(op258.record?.value.sTruncated, true);

  // Add 259th op so even after Bob's purge, live + purged inherited refs exceed 256.
  const op259 = appendOp(ALICE, seq++, frontier, { title: "Step 259" });
  frontier.push(op259);

  // Now purge Bob from the saturated history and compare cold independent read parity across arrival permutations.
  const coldSurvivingEdits = frontier
    .filter((op) => !op.isRoot && op.repo !== BOB)
    .map((op) => op.record!);
  const coldForward = mergeTask(root, coldSurvivingEdits);
  const coldReversed = mergeTask(root, [...coldSurvivingEdits].reverse());
  assert.deepEqual(coldForward, coldReversed);
  assert.equal(coldForward?.uncertainAncestry, true);
  assert.equal(coldForward?.lifecycleFinal, false);
  assert.equal(coldForward?.conflictFinal, false);
  assert.deepEqual(coldForward?.activities, []);

  // Also verify cold closure packing after Bob's purge yields identical deterministic s regardless of arrival order,
  // ranking live ops first and purged inherited opRefs last in ASCII hex order.
  const coldOps = frontier
    .filter((op) => op.repo !== BOB)
    .map((op) => ({
      repo: op.repo,
      rkey: op.rkey,
      t: op.t,
      s: op.record?.value.s,
      sTruncated: op.record?.value.sTruncated,
      deleted: op.deleted,
      isRoot: op.isRoot,
    }));
  const coldPackedForward = buildEditClosure({ observedOps: coldOps });
  const coldPackedReversed = buildEditClosure({ observedOps: [...coldOps].reverse() });
  assert.deepEqual(coldPackedForward, coldPackedReversed);
  assert.equal(coldPackedForward.sTruncated, true);
  assert.equal(coldPackedForward.s.length, MAX_ANCESTOR_REFS);
  assert.ok(coldPackedForward.totalClosureSize > MAX_ANCESTOR_REFS);
  const liveRefs = new Set(coldOps.map((op) => opRef(op.repo, op.rkey)));
  const purgedTail = coldPackedForward.s.filter((ref) => !liveRefs.has(ref));
  assert.ok(purgedTail.length > 0);
  assert.deepEqual(purgedTail, [...purgedTail].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)));
});
