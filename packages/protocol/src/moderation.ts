import { ATPROTO_SPACE_COLLECTION } from "./nsids";
import { validateLabelRecord } from "./registry";

export const LABEL_TAKEDOWN = "!takedown";
export const LABEL_HIDE = "!hide";

export type RawSpaceLabelRecord = {
  repoDid: string;
  rkey: string;
  value: Record<string, unknown>;
};

export type ActiveSpaceLabel = {
  rkey: string;
  uri: string;
  cid?: string;
  val: string;
  cts: string;
  ctsMs: number;
  exp?: string;
};

function parseTimestampMs(iso: string): number | null {
  const parsed = Date.parse(iso);
  return Number.isFinite(parsed) ? parsed : null;
}

function isNewerLabel(candidate: ActiveSpaceLabel, current: ActiveSpaceLabel): boolean {
  if (candidate.ctsMs !== current.ctsMs) {
    return candidate.ctsMs > current.ctsMs;
  }
  if (candidate.cts !== current.cts) {
    return candidate.cts > current.cts;
  }
  return candidate.rkey > current.rkey;
}

type DeduplicatedSpaceLabel = ActiveSpaceLabel & {
  neg: boolean;
  expMs?: number;
};

/**
 * Deduplicates `<groupDid>`-authored `com.atproto.label.record` entries in a space by
 * `(uri, cid ?? "", val)` selecting the latest `cts` (tie-broken by `rkey` desc),
 * drops negated (`neg: true`), expired (`exp <= nowMs`), and invalid/cross-space/non-authority labels.
 */
export function projectActiveLabels(
  records: Iterable<RawSpaceLabelRecord>,
  context: { groupDid: string; spaceUri: string; nowMs?: number },
): ActiveSpaceLabel[] {
  const nowMs = context.nowMs ?? Date.now();
  const byKey = new Map<string, DeduplicatedSpaceLabel>();

  for (const entry of records) {
    if (entry.repoDid !== context.groupDid) continue;
    const check = validateLabelRecord(
      { $type: ATPROTO_SPACE_COLLECTION.label, ...entry.value },
      {
        authorityDid: context.groupDid,
        spaceUri: context.spaceUri,
        repoDid: entry.repoDid,
        rkey: entry.rkey,
      },
    );
    if (!check.valid) continue;

    const uri = String(entry.value.uri);
    const cid = typeof entry.value.cid === "string" ? entry.value.cid : undefined;
    const val = String(entry.value.val);
    const neg = entry.value.neg === true;
    const cts = String(entry.value.cts);
    const ctsMs = parseTimestampMs(cts);
    if (ctsMs === null) continue;

    const exp = typeof entry.value.exp === "string" ? entry.value.exp : undefined;
    let expMs: number | undefined;
    if (exp !== undefined) {
      const parsedExp = parseTimestampMs(exp);
      if (parsedExp === null) continue;
      expMs = parsedExp;
    }

    const candidate: DeduplicatedSpaceLabel = {
      rkey: entry.rkey,
      uri,
      ...(cid !== undefined ? { cid } : {}),
      val,
      neg,
      cts,
      ctsMs,
      ...(exp !== undefined ? { exp } : {}),
      ...(expMs !== undefined ? { expMs } : {}),
    };
    const dedupeKey = `${uri}\u0000${cid ?? ""}\u0000${val}`;
    const existing = byKey.get(dedupeKey);
    if (!existing || isNewerLabel(candidate, existing)) {
      byKey.set(dedupeKey, candidate);
    }
  }

  const active: ActiveSpaceLabel[] = [];
  for (const winner of byKey.values()) {
    if (winner.neg) continue;
    if (winner.expMs !== undefined && winner.expMs <= nowMs) continue;
    active.push({
      rkey: winner.rkey,
      uri: winner.uri,
      ...(winner.cid !== undefined ? { cid: winner.cid } : {}),
      val: winner.val,
      cts: winner.cts,
      ctsMs: winner.ctsMs,
      ...(winner.exp !== undefined ? { exp: winner.exp } : {}),
    });
  }

  return active.sort((a, b) => {
    if (a.uri !== b.uri) return a.uri < b.uri ? -1 : 1;
    const aCid = a.cid ?? "";
    const bCid = b.cid ?? "";
    if (aCid !== bCid) return aCid < bCid ? -1 : 1;
    if (a.val !== b.val) return a.val < b.val ? -1 : 1;
    return 0;
  });
}

/**
 * Returns active labels matching `uri` (both version-independent labels where `label.cid === undefined`
 * and version-specific labels matching `cid` when supplied).
 */
export function labelsForResource(
  activeLabels: readonly ActiveSpaceLabel[],
  uri: string,
  cid?: string,
): ActiveSpaceLabel[] {
  return activeLabels.filter(
    (label) =>
      label.uri === uri &&
      (label.cid === undefined || (cid !== undefined && label.cid === cid)),
  );
}

export function isTakendown(
  activeLabels: readonly ActiveSpaceLabel[],
  uri: string,
  cid?: string,
): boolean {
  return labelsForResource(activeLabels, uri, cid).some((l) => l.val === LABEL_TAKEDOWN);
}

export function isHidden(
  activeLabels: readonly ActiveSpaceLabel[],
  uri: string,
  cid?: string,
): boolean {
  return labelsForResource(activeLabels, uri, cid).some((l) => l.val === LABEL_HIDE);
}
