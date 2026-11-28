"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import type {
  GroupClient,
  GroupRule,
  ModSubjectHistoryEvent,
  ModSubjectItem,
} from "@flock/client/group-client";
import { ATGRP_MOD_EVENT_TYPE } from "@flock/protocol/nsids";
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
  for (const ev of existing) byId.set(ev.eventId, ev);
  for (const ev of incoming) byId.set(ev.eventId, ev);
  return [...byId.values()];
}

export type ModerationSnapshot = {
  rules?: GroupRule[];
  rulesError: string;
  subjects?: ModSubjectItem[];
  subjectsCursor?: string;
  subjectsError: string;
};

export type ModerationQueueFilter = "all" | "open" | "resolved";

export async function fetchModerationSnapshot(
  groupClient: Pick<GroupClient, "listRules" | "queryModSubjects">,
  options: { canModerate: boolean; status: ModerationQueueFilter; tags?: readonly string[] },
): Promise<ModerationSnapshot> {
  const [rulesSettled, subjectsSettled] = await Promise.allSettled([
    (async () => groupClient.listRules())(),
    options.canModerate
      ? (async () =>
          groupClient.queryModSubjects({
            ...(options.status === "all" ? {} : { status: options.status }),
            ...(options.tags && options.tags.length > 0 ? { tags: options.tags } : {}),
          }))()
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

export function formatModHistoryEventSummary(ev: ModSubjectHistoryEvent): string {
  const type = String(ev.event.$type ?? "event");
  if (type === ATGRP_MOD_EVENT_TYPE.label) {
    const val = typeof ev.event.val === "string" ? ev.event.val : "label";
    return ev.event.neg === true ? `negate ${val}` : val;
  }
  if (type === ATGRP_MOD_EVENT_TYPE.status) {
    const status = typeof ev.event.status === "string" ? ev.event.status : "";
    const note = typeof ev.event.note === "string" && ev.event.note.length > 0 ? `: ${ev.event.note}` : "";
    return `${status}${note}`;
  }
  if (type === ATGRP_MOD_EVENT_TYPE.report) {
    const rt = typeof ev.event.reasonType === "string" ? ev.event.reasonType : "report";
    const reason = typeof ev.event.reason === "string" && ev.event.reason.length > 0 ? `: ${ev.event.reason}` : "";
    return `${rt}${reason}`;
  }
  if (type === ATGRP_MOD_EVENT_TYPE.appeal) {
    const reason = typeof ev.event.reason === "string" && ev.event.reason.length > 0 ? ev.event.reason : "appeal";
    return reason;
  }
  if (type === ATGRP_MOD_EVENT_TYPE.tag) {
    const added = Array.isArray(ev.event.added) ? (ev.event.added as string[]) : [];
    const removed = Array.isArray(ev.event.removed) ? (ev.event.removed as string[]) : [];
    const parts: string[] = [];
    if (added.length > 0) parts.push(`+${added.join(", +")}`);
    if (removed.length > 0) parts.push(`-${removed.join(", -")}`);
    return parts.join(" ");
  }
  if (type === ATGRP_MOD_EVENT_TYPE.eject) {
    return "member ejected";
  }
  return "";
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
 * Atmosphere Groups moderation & rules panel (`org.atgrp.mod.*`, `org.atgrp.rule/*` in `members/self`):
 * - Group rules CRUD (`org.atgrp.rule/*` in `members/self`)
 * - Moderation queue (`org.atgrp.mod.querySubjects` across `all` / `open` / `resolved` + tag filter)
 * - Subject audit trail (`org.atgrp.mod.querySubjectHistory`) showing all 6 event types
 * - Subject status, notes & tags (`org.atgrp.mod.updateSubject`)
 * - In-space label publishing (`!hide`, `!takedown`) and history-based label deletion (`deleteLabelRecord`
 *   using `#labelEvent.uri`, requiring no `action=read` on `space:*`)
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
  const [queueFilter, setQueueFilter] = useState<ModerationQueueFilter>("open");
  const [tagFilterInput, setTagFilterInput] = useState("");
  const [activeTagsFilter, setActiveTagsFilter] = useState<string[]>([]);
  const [subjects, setSubjects] = useState<ModSubjectItem[]>([]);
  const [subjectsCursor, setSubjectsCursor] = useState<string | undefined>(undefined);
  const [subjectsError, setSubjectsError] = useState("");
  const [selectedSubject, setSelectedSubject] = useState<{ subject: string; cid?: string } | null>(null);
  const [noteInput, setNoteInput] = useState("");
  const [addTagInput, setAddTagInput] = useState("");
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
        tags: activeTagsFilter,
      });
      applyModerationSnapshot(snap);
    } catch (caught) {
      const msg = messageOf(caught);
      setSubjectsError(msg);
      setError(msg);
    }
  }, [groupClient, canModerate, queueFilter, activeTagsFilter, applyModerationSnapshot, setError]);

  useEffect(() => {
    if (!groupClient) return;
    let cancelled = false;
    void fetchModerationSnapshot(groupClient, {
      canModerate,
      status: queueFilter,
      tags: activeTagsFilter,
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
  }, [groupClient, canModerate, queueFilter, activeTagsFilter, applyModerationSnapshot, setError]);

  const refreshSelectedHistory = useCallback(
    async (subject: string, cid?: string) => {
      if (!groupClient) return;
      const refreshed = await groupClient.queryModSubjectHistory({ subject, ...(cid ? { cid } : {}) });
      setHistoryState({
        key: `${subject}#${cid ?? ""}`,
        events: refreshed.events,
        ...(refreshed.cursor ? { cursor: refreshed.cursor } : {}),
      });
    },
    [groupClient],
  );

  useEffect(() => {
    if (!groupClient || !selectedSubject || !selectedSubjectKey || !canModerate) return;
    let cancelled = false;
    const targetKey = selectedSubjectKey;
    void groupClient
      .queryModSubjectHistory({ subject: selectedSubject.subject, ...(selectedSubject.cid ? { cid: selectedSubject.cid } : {}) })
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
        await refreshSelectedHistory(subject, cid);
      }
      await onAfterModerationChange();
    } catch (caught) {
      setError(messageOf(caught));
    } finally {
      setBusy(false);
    }
  }

  async function handleDeleteLabelByUri(labelUri: string, subject: string, cid?: string) {
    if (!groupClient) return;
    setBusy(true);
    setError("");
    try {
      await groupClient.deleteLabelRecord(labelUri);
      setStatus(`Deleted label record ${labelUri}.`);
      await loadModerationState();
      await refreshSelectedHistory(subject, cid);
      await onAfterModerationChange();
    } catch (caught) {
      setError(messageOf(caught));
    } finally {
      setBusy(false);
    }
  }

  async function handleUpdateSubject(input: {
    subject: string;
    cid?: string;
    status?: "open" | "resolved";
    note?: string;
    addTags?: string[];
    removeTags?: string[];
  }) {
    if (!groupClient) return;
    setBusy(true);
    setError("");
    try {
      await groupClient.updateModSubject(input);
      setStatus("Updated moderation subject.");
      await loadModerationState();
      if (selectedSubject && selectedSubject.subject === input.subject) {
        await refreshSelectedHistory(input.subject, input.cid);
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
      const page = await groupClient.queryModSubjects({
        ...(queueFilter === "all" ? {} : { status: queueFilter }),
        ...(activeTagsFilter.length > 0 ? { tags: activeTagsFilter } : {}),
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
      const page = await groupClient.queryModSubjectHistory({
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
            reports, appeals, tags, rules, and moderation labels directly on the Group Host.
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
                {(["open", "resolved", "all"] as const).map((tab) => (
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

            <form
              className="inline-form"
              onSubmit={(e) => {
                e.preventDefault();
                const parsed = tagFilterInput
                  .split(/[\s,]+/)
                  .map((t) => t.trim().toLowerCase())
                  .filter(Boolean);
                setActiveTagsFilter(parsed);
                setSubjectsCursor(undefined);
              }}
            >
              <input
                aria-label="Filter by tags"
                placeholder="Filter tags (e.g. escalated, needs-review)"
                value={tagFilterInput}
                onChange={(e) => setTagFilterInput(e.target.value)}
                disabled={busy}
              />
              <button type="submit" className="text-button" disabled={busy}>
                Filter tags
              </button>
              {activeTagsFilter.length > 0 && (
                <button
                  type="button"
                  className="text-button"
                  disabled={busy}
                  onClick={() => {
                    setTagFilterInput("");
                    setActiveTagsFilter([]);
                  }}
                >
                  Clear tags
                </button>
              )}
            </form>

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
                          {item.reportCount ?? 0} report(s) · status: <b>{item.status}</b>
                          {item.tags && item.tags.length > 0 ? ` · tags: ${item.tags.join(", ")}` : ""} · updated{" "}
                          {item.updatedAt}
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
                        {item.status !== "resolved" ? (
                          <button
                            type="button"
                            className="primary-button"
                            disabled={busy}
                            onClick={() =>
                              void handleUpdateSubject({
                                subject: item.subject,
                                ...(item.cid ? { cid: item.cid } : {}),
                                status: "resolved",
                              })
                            }
                          >
                            Resolve
                          </button>
                        ) : (
                          <button
                            type="button"
                            className="text-button"
                            disabled={busy}
                            onClick={() =>
                              void handleUpdateSubject({
                                subject: item.subject,
                                ...(item.cid ? { cid: item.cid } : {}),
                                status: "open",
                              })
                            }
                          >
                            Reopen
                          </button>
                        )}
                        {item.tags?.map((tag) => (
                          <button
                            key={tag}
                            type="button"
                            className="text-button"
                            disabled={busy}
                            onClick={() =>
                              void handleUpdateSubject({
                                subject: item.subject,
                                ...(item.cid ? { cid: item.cid } : {}),
                                removeTags: [tag],
                              })
                            }
                          >
                            × {tag}
                          </button>
                        ))}
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
                <form
                  className="inline-form"
                  onSubmit={(e) => {
                    e.preventDefault();
                    const tagsToAdd = addTagInput
                      .split(/[\s,]+/)
                      .map((t) => t.trim().toLowerCase())
                      .filter(Boolean);
                    const note = noteInput.trim();
                    if (tagsToAdd.length === 0 && !note) return;
                    void handleUpdateSubject({
                      subject: selectedSubject.subject,
                      ...(selectedSubject.cid ? { cid: selectedSubject.cid } : {}),
                      ...(note ? { note } : {}),
                      ...(tagsToAdd.length > 0 ? { addTags: tagsToAdd } : {}),
                    }).then(() => {
                      setNoteInput("");
                      setAddTagInput("");
                    });
                  }}
                >
                  <input
                    aria-label="Add subject tags"
                    placeholder="Add tags (a-z, -)"
                    value={addTagInput}
                    onChange={(e) => setAddTagInput(e.target.value)}
                    disabled={busy}
                  />
                  <input
                    aria-label="Moderation note"
                    placeholder="Internal note (optional)"
                    value={noteInput}
                    onChange={(e) => setNoteInput(e.target.value)}
                    disabled={busy}
                  />
                  <button type="submit" className="text-button" disabled={busy}>
                    Save tags/note
                  </button>
                </form>

                {activeHistoryError ? (
                  <p className="form-error" role="alert">
                    Failed to load moderation history: {activeHistoryError}
                  </p>
                ) : history.length === 0 ? (
                  <p>No moderation events recorded.</p>
                ) : (
                  <ul>
                    {history.map((ev) => {
                      const summary = formatModHistoryEventSummary(ev);
                      const labelRecordUri =
                        ev.event.$type === ATGRP_MOD_EVENT_TYPE.label && typeof ev.event.uri === "string"
                          ? ev.event.uri
                          : undefined;
                      return (
                        <li key={ev.eventId}>
                          <code>#{ev.eventId}</code> · {ev.createdAt}
                          {ev.createdBy ? ` · by ${ev.createdBy}` : ""} ·{" "}
                          <code>{String(ev.event.$type ?? "event")}</code>
                          {summary ? ` (${summary})` : ""}
                          {labelRecordUri && ev.event.neg !== true ? (
                            <>
                              {" "}
                              <button
                                type="button"
                                className="text-button"
                                disabled={busy}
                                onClick={() =>
                                  void handleDeleteLabelByUri(labelRecordUri, selectedSubject.subject, selectedSubject.cid)
                                }
                              >
                                Delete label record
                              </button>
                            </>
                          ) : null}
                        </li>
                      );
                    })}
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
