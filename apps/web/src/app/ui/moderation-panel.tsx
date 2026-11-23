"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import type {
  GroupClient,
  GroupRule,
  ModSubjectHistoryEvent,
  ModSubjectItem,
} from "@flock/client/group-client";
import type { WorkspaceSummary } from "@flock/protocol/workspace-summary";
import type { GroupBrowserOAuthClient } from "../../browser/group-session";
import { messageOf } from "./client-api";

export function mergeModSubjectsPage(
  existing: readonly ModSubjectItem[],
  incoming: readonly ModSubjectItem[],
): ModSubjectItem[] {
  const byKey = new Map<string, ModSubjectItem>();
  for (const item of existing) byKey.set(`${item.subject}#${item.cid ?? ""}`, item);
  for (const item of incoming) byKey.set(`${item.subject}#${item.cid ?? ""}`, item);
  return [...byKey.values()];
}

export function mergeModHistoryPage(
  existing: readonly ModSubjectHistoryEvent[],
  incoming: readonly ModSubjectHistoryEvent[],
): ModSubjectHistoryEvent[] {
  const byId = new Map<string, ModSubjectHistoryEvent>();
  for (const ev of existing) byId.set(ev.id, ev);
  for (const ev of incoming) byId.set(ev.id, ev);
  return [...byId.values()];
}

export type ModerationSnapshot = {
  rules?: GroupRule[];
  rulesError: string;
  subjects?: ModSubjectItem[];
  subjectsCursor?: string;
  subjectsError: string;
};

export async function fetchModerationSnapshot(
  groupClient: Pick<GroupClient, "listRules" | "listModSubjects">,
  options: { canModerate: boolean; status: "open" | "escalated" | "resolved" },
): Promise<ModerationSnapshot> {
  const [rulesSettled, subjectsSettled] = await Promise.allSettled([
    (async () => groupClient.listRules())(),
    options.canModerate
      ? (async () => groupClient.listModSubjects({ status: options.status }))()
      : Promise.resolve({ subjects: [] as ModSubjectItem[], cursor: undefined as string | undefined }),
  ]);

  const rules = rulesSettled.status === "fulfilled" ? rulesSettled.value : undefined;
  const rulesError = rulesSettled.status === "rejected" ? messageOf(rulesSettled.reason) : "";

  const subjects = subjectsSettled.status === "fulfilled" ? subjectsSettled.value.subjects : undefined;
  const subjectsCursor =
    subjectsSettled.status === "fulfilled" && subjectsSettled.value.cursor
      ? subjectsSettled.value.cursor
      : undefined;
  const subjectsError = subjectsSettled.status === "rejected" ? messageOf(subjectsSettled.reason) : "";

  return {
    ...(rules !== undefined ? { rules } : {}),
    rulesError,
    ...(subjects !== undefined ? { subjects } : {}),
    ...(subjectsCursor ? { subjectsCursor } : {}),
    subjectsError,
  };
}

type ModerationPanelProps = {
  activeWorkspace: WorkspaceSummary;
  groupClient: GroupClient | null;
  groupOAuth: GroupBrowserOAuthClient | null;
  returnTo: string;
  onRulesChanged?: (rules: GroupRule[]) => void;
  onAfterModerationChange: () => Promise<void>;
  setStatus: (message: string) => void;
  setError: (message: string) => void;
};

/**
 * OpenSocial group rules & moderation queue (`proposal.md:140-152`):
 * - Group rules CRUD (`group.opensocial.rule/*` in `meta/self`)
 * - Moderation queue (`listModSubjects` across `open` / `escalated` / `resolved`)
 * - Subject audit trail (`getModSubjectHistory`) + `resolveModSubject`
 * - In-space label publishing & negation (`!hide`, `!takedown`) via `com.atproto.label.record`
 */
export function ModerationPanel({
  activeWorkspace,
  groupClient,
  groupOAuth,
  returnTo,
  onRulesChanged,
  onAfterModerationChange,
  setStatus,
  setError,
}: ModerationPanelProps) {
  const canModerate = activeWorkspace.isAdmin || activeWorkspace.isModerator;
  const [rules, setRules] = useState<GroupRule[]>([]);
  const [rulesError, setRulesError] = useState("");
  const [ruleTitle, setRuleTitle] = useState("");
  const [ruleText, setRuleText] = useState("");
  const [queueFilter, setQueueFilter] = useState<"open" | "escalated" | "resolved">("open");
  const [subjects, setSubjects] = useState<ModSubjectItem[]>([]);
  const [subjectsCursor, setSubjectsCursor] = useState<string | undefined>(undefined);
  const [subjectsError, setSubjectsError] = useState("");
  const [selectedSubject, setSelectedSubject] = useState<{ subject: string; cid?: string } | null>(null);
  const [historyState, setHistoryState] = useState<{
    key: string;
    events: ModSubjectHistoryEvent[];
    cursor?: string;
    error?: string;
  } | null>(null);
  const [busy, setBusy] = useState(false);

  const selectedSubjectKey = selectedSubject ? `${selectedSubject.subject}#${selectedSubject.cid ?? ""}` : null;
  const activeHistoryState = selectedSubjectKey && historyState?.key === selectedSubjectKey ? historyState : null;
  const history = activeHistoryState ? activeHistoryState.events : [];
  const activeHistoryCursor = activeHistoryState?.cursor;
  const activeHistoryError = activeHistoryState?.error ?? "";

  const applyModerationSnapshot = useCallback(
    (snap: ModerationSnapshot) => {
      if (snap.rules !== undefined) {
        setRules(snap.rules);
        onRulesChanged?.(snap.rules);
      }
      setRulesError(snap.rulesError);

      if (snap.subjects !== undefined) {
        setSubjects(snap.subjects);
        setSubjectsCursor(snap.subjectsCursor);
      } else {
        setSubjectsCursor(undefined);
      }
      setSubjectsError(snap.subjectsError);

      const combinedError = [snap.rulesError, snap.subjectsError].filter(Boolean).join(" · ");
      if (combinedError) {
        setError(combinedError);
      }
    },
    [onRulesChanged, setError],
  );

  const loadModerationState = useCallback(async () => {
    if (!groupClient) return;
    try {
      const snap = await fetchModerationSnapshot(groupClient, {
        canModerate,
        status: queueFilter,
      });
      applyModerationSnapshot(snap);
    } catch (caught) {
      const msg = messageOf(caught);
      setSubjectsError(msg);
      setError(msg);
    }
  }, [groupClient, canModerate, queueFilter, applyModerationSnapshot, setError]);

  useEffect(() => {
    if (!groupClient) return;
    let cancelled = false;
    void fetchModerationSnapshot(groupClient, {
      canModerate,
      status: queueFilter,
    }).then(
      (snap) => {
        if (!cancelled) applyModerationSnapshot(snap);
      },
      (caught: unknown) => {
        if (!cancelled) {
          const msg = messageOf(caught);
          setSubjectsError(msg);
          setError(msg);
        }
      },
    );
    return () => {
      cancelled = true;
    };
  }, [groupClient, canModerate, queueFilter, applyModerationSnapshot, setError]);

  useEffect(() => {
    if (!groupClient || !selectedSubject || !selectedSubjectKey || !canModerate) return;
    let cancelled = false;
    const targetKey = selectedSubjectKey;
    void groupClient
      .getModSubjectHistory({ subject: selectedSubject.subject, ...(selectedSubject.cid ? { cid: selectedSubject.cid } : {}) })
      .then(
        (res) => {
          if (!cancelled) {
            setHistoryState({
              key: targetKey,
              events: res.events,
              ...(res.cursor ? { cursor: res.cursor } : {}),
            });
          }
        },
        (caught: unknown) => {
          if (!cancelled) {
            const msg = messageOf(caught);
            setHistoryState({ key: targetKey, events: [], error: msg });
            setError(msg);
          }
        },
      );
    return () => {
      cancelled = true;
    };
  }, [groupClient, selectedSubject, selectedSubjectKey, canModerate, setError]);

  async function signInForModeration() {
    if (!groupOAuth) return;
    setBusy(true);
    setError("");
    try {
      const url = await groupOAuth.authorizeGroup({
        groupOrHost: activeWorkspace.groupDid,
        roleScope: activeWorkspace.isAdmin ? "admin" : "moderator",
        appState: {
          returnTo,
          purpose: activeWorkspace.isAdmin ? "admin" : "moderator",
          groupDid: activeWorkspace.groupDid,
        },
      });
      window.location.assign(url.toString());
    } catch (caught) {
      setError(messageOf(caught));
      setBusy(false);
    }
  }

  async function handleAddRule(event: FormEvent) {
    event.preventDefault();
    if (!groupClient || !ruleTitle.trim() || !ruleText.trim()) return;
    setBusy(true);
    setError("");
    try {
      await groupClient.putRule({
        title: ruleTitle.trim(),
        text: ruleText.trim(),
        order: rules.length + 1,
      });
      setRuleTitle("");
      setRuleText("");
      setStatus("Group rule published.");
      await loadModerationState();
      await onAfterModerationChange();
    } catch (caught) {
      setError(messageOf(caught));
    } finally {
      setBusy(false);
    }
  }

  async function handleDeleteRule(rkey: string) {
    if (!groupClient) return;
    setBusy(true);
    setError("");
    try {
      await groupClient.deleteRule(rkey);
      setStatus("Group rule deleted.");
      await loadModerationState();
      await onAfterModerationChange();
    } catch (caught) {
      setError(messageOf(caught));
    } finally {
      setBusy(false);
    }
  }

  async function applyLabelAction(subject: string, cid: string | undefined, val: "!hide" | "!takedown", negate: boolean) {
    if (!groupClient) return;
    setBusy(true);
    setError("");
    try {
      if (negate) {
        await groupClient.negateLabel({ uri: subject, ...(cid ? { cid } : {}), val });
        setStatus(`Removed ${val} label on ${subject}.`);
      } else {
        await groupClient.publishLabel({ uri: subject, ...(cid ? { cid } : {}), val });
        setStatus(`Published ${val} label on ${subject}.`);
      }
      await loadModerationState();
      if (selectedSubject && selectedSubject.subject === subject) {
        const refreshed = await groupClient.getModSubjectHistory({ subject, ...(cid ? { cid } : {}) });
        setHistoryState({
          key: `${subject}#${cid ?? ""}`,
          events: refreshed.events,
          ...(refreshed.cursor ? { cursor: refreshed.cursor } : {}),
        });
      }
      await onAfterModerationChange();
    } catch (caught) {
      setError(messageOf(caught));
    } finally {
      setBusy(false);
    }
  }

  async function updateSubjectStatus(subject: string, cid: string | undefined, nextStatus: "resolved" | "escalated") {
    if (!groupClient) return;
    setBusy(true);
    setError("");
    try {
      await groupClient.resolveModSubject({
        subject,
        ...(cid ? { cid } : {}),
        status: nextStatus,
      });
      setStatus(`Marked moderation subject ${nextStatus}.`);
      await loadModerationState();
      if (selectedSubject && selectedSubject.subject === subject) {
        const refreshed = await groupClient.getModSubjectHistory({ subject, ...(cid ? { cid } : {}) });
        setHistoryState({
          key: `${subject}#${cid ?? ""}`,
          events: refreshed.events,
          ...(refreshed.cursor ? { cursor: refreshed.cursor } : {}),
        });
      }
    } catch (caught) {
      setError(messageOf(caught));
    } finally {
      setBusy(false);
    }
  }

  async function handleLoadMoreSubjects() {
    if (!groupClient || !subjectsCursor || !canModerate) return;
    setBusy(true);
    setError("");
    try {
      const page = await groupClient.listModSubjects({
        status: queueFilter,
        cursor: subjectsCursor,
      });
      setSubjects((prev) => mergeModSubjectsPage(prev, page.subjects));
      setSubjectsCursor(page.cursor || undefined);
      setSubjectsError("");
    } catch (caught) {
      const msg = messageOf(caught);
      setSubjectsError(msg);
      setError(msg);
    } finally {
      setBusy(false);
    }
  }

  async function handleLoadMoreHistory() {
    if (!groupClient || !selectedSubject || !selectedSubjectKey || !activeHistoryCursor || !canModerate) return;
    const targetKey = selectedSubjectKey;
    setBusy(true);
    setError("");
    try {
      const page = await groupClient.getModSubjectHistory({
        subject: selectedSubject.subject,
        ...(selectedSubject.cid ? { cid: selectedSubject.cid } : {}),
        cursor: activeHistoryCursor,
      });
      setHistoryState((prev) => {
        if (!prev || prev.key !== targetKey) return prev;
        return {
          key: targetKey,
          events: mergeModHistoryPage(prev.events, page.events),
          ...(page.cursor ? { cursor: page.cursor } : {}),
        };
      });
    } catch (caught) {
      setError(messageOf(caught));
    } finally {
      setBusy(false);
    }
  }

  if (!canModerate) {
    return null;
  }

  return (
    <section aria-label="Group moderation">
      <div className="section-heading">
        <div>
          <span className="eyebrow">MODERATION &amp; RULES</span>
          <h2>Group moderation</h2>
        </div>
        {groupClient && (
          <button type="button" className="text-button" disabled={busy} onClick={() => void loadModerationState()}>
            Refresh queue ↻
          </button>
        )}
      </div>

      {!groupClient ? (
        <div className="starter-card permission-box">
          <p>
            Sign in with your per-user Group OAuth session ({activeWorkspace.isAdmin ? "admin" : "moderator"}) to review
            reports, manage rules, and publish moderation labels directly on the Group Host.
          </p>
          <button type="button" className="primary-button" disabled={busy} onClick={() => void signInForModeration()}>
            Sign in to moderate →
          </button>
        </div>
      ) : (
        <>
          {activeWorkspace.isAdmin ? (
            <div className="starter-card">
              <h3>Group rules</h3>
              {rulesError ? (
                <p className="form-error" role="alert">
                  Failed to load group rules: {rulesError}
                </p>
              ) : rules.length === 0 ? (
                <p>No group rules published yet.</p>
              ) : (
                <div className="roster-list">
                  {rules.map((rule) => (
                    <div className="roster-row" key={rule.uri}>
                      <div>
                        <strong>{rule.title}</strong>
                        <p>{rule.text}</p>
                        <small className="mono-note">{rule.uri}</small>
                      </div>
                      <button
                        type="button"
                        className="text-button danger"
                        disabled={busy}
                        onClick={() => void handleDeleteRule(rule.rkey)}
                      >
                        Delete rule
                      </button>
                    </div>
                  ))}
                </div>
              )}
              <form className="inline-form" onSubmit={(e) => void handleAddRule(e)}>
                <input
                  aria-label="Rule title"
                  placeholder="Rule title"
                  value={ruleTitle}
                  onChange={(e) => setRuleTitle(e.target.value)}
                  maxLength={120}
                  required
                  disabled={busy}
                />
                <input
                  aria-label="Rule description"
                  placeholder="Rule description"
                  value={ruleText}
                  onChange={(e) => setRuleText(e.target.value)}
                  maxLength={1000}
                  required
                  disabled={busy}
                />
                <button type="submit" className="text-button" disabled={busy}>
                  Add rule →
                </button>
              </form>
            </div>
          ) : (
            rulesError && (
              <p className="form-error" role="alert">
                Failed to load group rules: {rulesError}
              </p>
            )
          )}

          <div className="starter-card">
            <div className="section-heading">
              <h3>Moderation queue</h3>
              <div>
                {(["open", "escalated", "resolved"] as const).map((tab) => (
                  <button
                    key={tab}
                    type="button"
                    className={queueFilter === tab ? "primary-button" : "text-button"}
                    disabled={busy}
                    onClick={() => {
                      setQueueFilter(tab);
                      setSubjectsCursor(undefined);
                      setSubjectsError("");
                    }}
                  >
                    {tab}
                  </button>
                ))}
              </div>
            </div>

            {subjectsError ? (
              <p className="form-error" role="alert">
                Failed to load moderation subjects: {subjectsError}
              </p>
            ) : subjects.length === 0 ? (
              <p>No {queueFilter} moderation subjects.</p>
            ) : (
              <div className="roster-list">
                {subjects.map((item) => {
                  const key = `${item.subject}#${item.cid ?? ""}`;
                  const isSelected =
                    selectedSubject?.subject === item.subject && (selectedSubject?.cid ?? "") === (item.cid ?? "");
                  return (
                    <div className="roster-row" key={key}>
                      <div>
                        <strong className="mono-note">{item.subject}</strong>
                        {item.cid && <small className="mono-note"> (cid: {item.cid})</small>}
                        <p>
                          {item.reportCount} report(s) · status: <b>{item.status}</b> · updated {item.updatedAt}
                        </p>
                      </div>
                      <div>
                        <button
                          type="button"
                          className="text-button"
                          disabled={busy}
                          onClick={() =>
                            setSelectedSubject(isSelected ? null : { subject: item.subject, ...(item.cid ? { cid: item.cid } : {}) })
                          }
                        >
                          {isSelected ? "Hide history" : "History"}
                        </button>
                        <button
                          type="button"
                          className="text-button"
                          disabled={busy}
                          onClick={() => void applyLabelAction(item.subject, item.cid, "!hide", false)}
                        >
                          Apply !hide
                        </button>
                        <button
                          type="button"
                          className="text-button"
                          disabled={busy}
                          onClick={() => void applyLabelAction(item.subject, item.cid, "!hide", true)}
                        >
                          Remove !hide
                        </button>
                        <button
                          type="button"
                          className="text-button danger"
                          disabled={busy}
                          onClick={() => void applyLabelAction(item.subject, item.cid, "!takedown", false)}
                        >
                          Apply !takedown
                        </button>
                        <button
                          type="button"
                          className="text-button"
                          disabled={busy}
                          onClick={() => void applyLabelAction(item.subject, item.cid, "!takedown", true)}
                        >
                          Remove !takedown
                        </button>
                        {item.status !== "escalated" && (
                          <button
                            type="button"
                            className="text-button"
                            disabled={busy}
                            onClick={() => void updateSubjectStatus(item.subject, item.cid, "escalated")}
                          >
                            Escalate
                          </button>
                        )}
                        {item.status !== "resolved" && (
                          <button
                            type="button"
                            className="primary-button"
                            disabled={busy}
                            onClick={() => void updateSubjectStatus(item.subject, item.cid, "resolved")}
                          >
                            Resolve
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}

            {subjectsCursor && (
              <button
                type="button"
                className="text-button"
                disabled={busy}
                onClick={() => void handleLoadMoreSubjects()}
              >
                Load more subjects
              </button>
            )}

            {selectedSubject && (
              <div className="starter-card" aria-label="Moderation subject history">
                <h4>Audit history for {selectedSubject.subject}</h4>
                {activeHistoryError ? (
                  <p className="form-error" role="alert">
                    Failed to load moderation history: {activeHistoryError}
                  </p>
                ) : history.length === 0 ? (
                  <p>No moderation events recorded.</p>
                ) : (
                  <ul>
                    {history.map((ev) => (
                      <li key={ev.id}>
                        <code>#{ev.id}</code> · {ev.createdAt}
                        {ev.createdBy ? ` · by ${ev.createdBy}` : ""} ·{" "}
                        <code>{String(ev.event.$type ?? "event")}</code>{" "}
                        {typeof ev.event.val === "string"
                          ? `(${ev.event.neg ? "negate " : ""}${ev.event.val})`
                          : typeof ev.event.status === "string"
                            ? `(${ev.event.status})`
                            : typeof ev.event.reasonType === "string"
                              ? `(${ev.event.reasonType}${ev.event.reason ? `: ${String(ev.event.reason)}` : ""})`
                              : ""}
                      </li>
                    ))}
                  </ul>
                )}
                {activeHistoryCursor && (
                  <button
                    type="button"
                    className="text-button"
                    disabled={busy}
                    onClick={() => void handleLoadMoreHistory()}
                  >
                    Load more history
                  </button>
                )}
              </div>
            )}
          </div>
        </>
      )}
    </section>
  );
}
