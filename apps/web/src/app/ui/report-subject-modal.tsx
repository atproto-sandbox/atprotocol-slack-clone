"use client";

import { useState, type FormEvent } from "react";
import { messageOf } from "./client-api";

export const REPORT_REASON_TYPES = [
  { value: "spam", label: "Spam" },
  { value: "violation", label: "Rule violation" },
  { value: "misleading", label: "Misleading" },
  { value: "nsfw", label: "Unwanted sexual / NSFW content" },
  { value: "rude", label: "Anti-social / rude" },
  { value: "other", label: "Other" },
] as const;

export type ReportRuleOption = {
  uri: string;
  title: string;
};

export type SubmitReportFn = (input: {
  subject: string;
  cid?: string;
  reasonType: string;
  rule?: string;
  reason?: string;
}) => Promise<void>;

type ReportSubjectButtonProps = {
  subject: string;
  cid?: string;
  subjectLabel?: string;
  rules?: readonly ReportRuleOption[];
  onSubmitReport: SubmitReportFn;
  onReported?: () => void;
  onError?: (message: string) => void;
};

/**
 * Inline toggleable report form (`group.opensocial.createReport`) for messages, tasks, comments, or accounts.
 * Requires selecting a group rule URI when `reasonType === "violation"` (`createReport.json:38`).
 */
export function ReportSubjectButton({
  subject,
  cid,
  subjectLabel = "Report",
  rules = [],
  onSubmitReport,
  onReported,
  onError,
}: ReportSubjectButtonProps) {
  const [open, setOpen] = useState(false);
  const [reasonType, setReasonType] = useState<string>("spam");
  const [ruleUri, setRuleUri] = useState<string>(rules[0]?.uri ?? "");
  const [reason, setReason] = useState("");
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (reasonType === "violation" && !ruleUri.trim()) {
      onError?.("Select or enter the group rule URI violated by this subject.");
      return;
    }
    setSubmitting(true);
    try {
      await onSubmitReport({
        subject,
        ...(cid ? { cid } : {}),
        reasonType,
        ...(reasonType === "violation" ? { rule: ruleUri.trim() } : {}),
        ...(reason.trim() ? { reason: reason.trim() } : {}),
      });
      setOpen(false);
      setReason("");
      onReported?.();
    } catch (caught) {
      onError?.(messageOf(caught));
    } finally {
      setSubmitting(false);
    }
  }

  if (!open) {
    return (
      <button type="button" className="text-button" onClick={() => setOpen(true)}>
        {subjectLabel}
      </button>
    );
  }

  return (
    <form className="inline-form report-subject-form" onSubmit={(e) => void handleSubmit(e)}>
      <label>
        Reason
        <select
          aria-label="Report reason"
          value={reasonType}
          onChange={(e) => setReasonType(e.target.value)}
          disabled={submitting}
        >
          {REPORT_REASON_TYPES.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
      </label>
      {reasonType === "violation" &&
        (rules.length > 0 ? (
          <label>
            Violated rule
            <select
              aria-label="Violated rule"
              value={ruleUri || rules[0]!.uri}
              onChange={(e) => setRuleUri(e.target.value)}
              disabled={submitting}
            >
              {rules.map((r) => (
                <option key={r.uri} value={r.uri}>
                  {r.title}
                </option>
              ))}
            </select>
          </label>
        ) : (
          <input
            aria-label="Violated rule URI"
            placeholder="at:space/did:plc:…/group.opensocial.meta/self/…/group.opensocial.rule/…"
            value={ruleUri}
            onChange={(e) => setRuleUri(e.target.value)}
            required
            disabled={submitting}
          />
        ))}
      <input
        aria-label="Report details"
        placeholder="Additional context (optional)"
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        maxLength={2000}
        disabled={submitting}
      />
      <div>
        <button type="submit" className="primary-button" disabled={submitting}>
          Submit report
        </button>
        <button type="button" className="text-button" disabled={submitting} onClick={() => setOpen(false)}>
          Cancel
        </button>
      </div>
    </form>
  );
}
