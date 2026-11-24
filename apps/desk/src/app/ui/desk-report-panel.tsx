"use client";

import { useState } from "react";
import { Banner, Button, Card, Heading, HStack, Text, TextArea, VStack } from "@astryxdesign/core";
import {
  reportSubject,
  STANDARD_REPORT_REASON_TYPES,
  type DeskShellDeps,
  type GroupModerationConfig,
} from "@flock/shell";

export type ReportTarget = {
  subject: string;
  subjectType: "account" | "record";
  cid?: string;
  label: string;
};

export function DeskReportPanel({
  deps,
  groupDid,
  config,
  target,
  onClose,
  onSubmitted,
}: {
  deps: DeskShellDeps;
  groupDid: string;
  config: GroupModerationConfig;
  target: ReportTarget;
  onClose: () => void;
  onSubmitted: (reportId: string) => void;
}) {
  const allowedReasons =
    config.labeler?.reasonTypes !== undefined
      ? config.labeler.reasonTypes
      : [...STANDARD_REPORT_REASON_TYPES];
  const hasAllowedReasons = allowedReasons.length > 0;
  const [reasonType, setReasonType] = useState<string>(allowedReasons[0] ?? "");
  const [selectedRule, setSelectedRule] = useState<string>(config.rules[0]?.uri ?? "");
  const [reason, setReason] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const needsRule = reasonType === "violation";
  const canSubmit = hasAllowedReasons && !submitting && reasonType.length > 0 && (!needsRule || selectedRule.length > 0);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const res = await reportSubject(deps, {
        groupDid,
        subject: target.subject,
        ...(target.subjectType === "record" && target.cid ? { cid: target.cid } : {}),
        reasonType,
        ...(reason.trim().length > 0 ? { reason: reason.trim() } : {}),
        ...(needsRule && selectedRule ? { rule: selectedRule } : {}),
      });
      onSubmitted(res.id);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not submit report.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Card padding={4} data-testid="desk-report-panel" role="region" aria-label="Submit moderation report">
      <form onSubmit={handleSubmit}>
        <VStack gap={3}>
          <HStack justify="between" align="center">
            <Heading level={3}>Report {target.subjectType}</Heading>
            <Button label="Cancel" variant="ghost" size="sm" onClick={onClose} />
          </HStack>
          <Text color="secondary" className="desk-mono">
            {target.label}
          </Text>
          {error ? <Banner status="error" title={error} role="alert" /> : null}

          {hasAllowedReasons ? (
            <>
              <label htmlFor="desk-report-reason-type">
                <Text>Reason category</Text>
              </label>
              <select
                id="desk-report-reason-type"
                data-testid="desk-report-reason-type"
                value={reasonType}
                onChange={(e) => setReasonType(e.target.value)}
              >
                {allowedReasons.map((rt) => (
                  <option key={rt} value={rt}>
                    {rt}
                  </option>
                ))}
              </select>
            </>
          ) : (
            <Banner
              status="warning"
              title="This group's labeler policy does not currently accept moderation reports."
            />
          )}

          {needsRule ? (
            config.rules.length > 0 ? (
              <>
                <label htmlFor="desk-report-rule-select">
                  <Text>Group rule violated</Text>
                </label>
                <select
                  id="desk-report-rule-select"
                  data-testid="desk-report-rule-select"
                  value={selectedRule}
                  onChange={(e) => setSelectedRule(e.target.value)}
                >
                  {config.rules.map((rule) => (
                    <option key={rule.uri} value={rule.uri}>
                      {rule.title} — {rule.text}
                    </option>
                  ))}
                </select>
              </>
            ) : (
              <Banner
                status="warning"
                title="No group rules are published in meta/self; select another reason category."
              />
            )
          ) : null}

          <TextArea
            label="Details (optional)"
            placeholder="Add context for group moderators..."
            value={reason}
            onChange={setReason}
            rows={2}
            width="100%"
            data-testid="desk-report-reason-input"
          />
          <HStack gap={2}>
            <Button
              type="submit"
              variant="primary"
              label={submitting ? "Submitting…" : "Submit report"}
              isDisabled={!canSubmit}
              data-testid="desk-report-submit-button"
            />
            <Button label="Close" variant="secondary" onClick={onClose} />
          </HStack>
        </VStack>
      </form>
    </Card>
  );
}
