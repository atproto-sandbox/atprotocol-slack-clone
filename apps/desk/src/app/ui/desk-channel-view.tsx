"use client";

import { useState } from "react";
import { Badge, Banner, Button, Card, Heading, HStack, Text, TextArea, VStack } from "@astryxdesign/core";
import { COLLECTION } from "@flock/protocol/nsids";
import type { IndependentChannelPage, IndependentMessage } from "@flock/reader/independent";
import {
  deleteChannelMessage,
  editChannelMessage,
  postChannelMessage,
  type DeskShellDeps,
  type GroupModerationConfig,
} from "@flock/shell";
import { DeskReportPanel, type ReportTarget } from "./desk-report-panel";

export type ChannelDescriptor = {
  uri: string;
  skey: string;
  name: string;
  visibility: string;
};

export function DeskChannelView({
  deps,
  groupDid,
  channel,
  page,
  privateRoster,
  moderationConfig,
  loading,
  onRefresh,
}: {
  deps: DeskShellDeps;
  groupDid: string;
  channel: ChannelDescriptor;
  page: IndependentChannelPage | null;
  privateRoster: string[] | null;
  moderationConfig: GroupModerationConfig | null;
  loading: boolean;
  onRefresh: () => Promise<void>;
}) {
  const [composerText, setComposerText] = useState("");
  const [replyParent, setReplyParent] = useState<IndependentMessage | null>(null);
  const [editingUri, setEditingUri] = useState<string | null>(null);
  const [editText, setEditText] = useState("");
  const [revealedUris, setRevealedUris] = useState<Record<string, boolean>>({});
  const [reportTarget, setReportTarget] = useState<ReportTarget | null>(null);
  const [reportNotice, setReportNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const labeler = moderationConfig?.labeler;
  const allowsMessageReports =
    moderationConfig !== null &&
    (!labeler?.subjectTypes || labeler.subjectTypes.includes("record")) &&
    (!labeler?.subjectCollections || labeler.subjectCollections.includes(COLLECTION.message)) &&
    (labeler?.reasonTypes === undefined || labeler.reasonTypes.length > 0);

  async function handleSend(event: React.FormEvent) {
    event.preventDefault();
    const trimmed = composerText.trim();
    if (!trimmed) return;
    setBusy(true);
    setError(null);
    try {
      await postChannelMessage(deps, channel.uri, {
        text: trimmed,
        ...(replyParent ? { parent: replyParent.uri } : {}),
      });
      setComposerText("");
      setReplyParent(null);
      await onRefresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Failed to post message.");
    } finally {
      setBusy(false);
    }
  }

  async function handleSaveEdit(messageUri: string) {
    const trimmed = editText.trim();
    if (!trimmed) return;
    setBusy(true);
    setError(null);
    try {
      await editChannelMessage(deps, channel.uri, messageUri, { text: trimmed });
      setEditingUri(null);
      setEditText("");
      await onRefresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Failed to edit message.");
    } finally {
      setBusy(false);
    }
  }

  async function handleDelete(messageUri: string) {
    setBusy(true);
    setError(null);
    try {
      await deleteChannelMessage(deps, channel.uri, messageUri);
      await onRefresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Failed to delete message.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <VStack
      gap={4}
      data-testid="desk-channel-view"
      data-channel-skey={channel.skey}
      data-ready={!loading && page !== null ? "true" : "false"}
    >
      <HStack justify="between" align="center">
        <HStack gap={2} align="center">
          <Heading level={2} data-testid="desk-channel-heading">
            {channel.visibility === "private" ? "🔒 " : "#"}
            {channel.name}
          </Heading>
          <Badge label={channel.visibility} variant="neutral" />
        </HStack>
        <Button
          label={loading ? "Refreshing…" : "Refresh channel"}
          variant="secondary"
          size="sm"
          isDisabled={loading}
          onClick={() => {
            void onRefresh().catch((caught) => {
              setError(caught instanceof Error ? caught.message : "Failed to refresh channel.");
            });
          }}
          data-testid="desk-channel-refresh-button"
        />
      </HStack>

      {channel.visibility === "private" && privateRoster !== null ? (
        <Card padding={3} variant="muted" role="region" aria-label="Private channel roster">
          <VStack gap={1}>
            <Text color="secondary">Private channel roster</Text>
            <p className="desk-mono" data-testid="desk-private-roster">
              {privateRoster.join(" · ")}
            </p>
          </VStack>
        </Card>
      ) : null}

      {error ? (
        <Banner status="error" title={error} role="alert" data-testid="desk-channel-error" />
      ) : null}
      {reportNotice ? (
        <Banner
          status="success"
          title={reportNotice}
          isDismissable
          onDismiss={() => setReportNotice(null)}
          data-testid="desk-report-confirmation"
        />
      ) : null}

      {page?.degradedReasons.length ? (
        <Banner
          status="warning"
          title="Partial channel read"
          description={page.degradedReasons.join(" ")}
        />
      ) : null}

      {reportTarget && moderationConfig ? (
        <DeskReportPanel
          key={reportTarget.subject}
          deps={deps}
          groupDid={groupDid}
          config={moderationConfig}
          target={reportTarget}
          onClose={() => setReportTarget(null)}
          onSubmitted={(id) => {
            setReportTarget(null);
            setReportNotice(`Report #${id || "submitted"} sent to group moderators.`);
          }}
        />
      ) : null}

      <Card padding={4}>
        <form onSubmit={handleSend} data-testid="desk-message-composer">
          <VStack gap={3}>
            {replyParent ? (
              <HStack justify="between" align="center">
                <Text color="secondary">
                  Replying to: {String(replyParent.value.text ?? "").slice(0, 80)}
                </Text>
                <Button label="Cancel reply" variant="ghost" size="sm" onClick={() => setReplyParent(null)} />
              </HStack>
            ) : null}
            <TextArea
              label={replyParent ? "Write a reply" : `Message #${channel.name}`}
              placeholder="Write a message directly to your personal PDS space…"
              value={composerText}
              onChange={setComposerText}
              rows={2}
              width="100%"
              data-testid="desk-message-input"
            />
            <HStack gap={2}>
              <Button
                type="submit"
                variant="primary"
                label={busy ? "Sending…" : "Send message"}
                isDisabled={busy || composerText.trim().length === 0}
                data-testid="desk-send-button"
              />
            </HStack>
          </VStack>
        </form>
      </Card>

      <section
        aria-label="Channel messages"
        className="desk-message-list"
        data-testid="desk-message-list"
      >
        {loading && !page ? (
          <Text color="secondary">Loading messages directly from writer PDSes…</Text>
        ) : page && page.messages.length === 0 ? (
          <Text color="secondary">No messages in this channel yet.</Text>
        ) : (
          (page?.messages ?? []).map((msg) => {
            const isOwn = msg.repo === deps.did;
            const isHidden = msg.hidden === true;
            const isRevealed = Boolean(revealedUris[msg.uri]);
            const isEditing = editingUri === msg.uri;
            const textValue = typeof msg.value.text === "string" ? msg.value.text : "";
            const isTopLevel = msg.value.parent === undefined;

            return (
              <article
                key={msg.uri}
                className="desk-message-entry"
                data-testid="desk-message-item"
                data-message-uri={msg.uri}
                data-hidden={isHidden ? "true" : "false"}
              >
                <HStack justify="between" align="center">
                  <span className="desk-mono">{msg.repo}</span>
                  <HStack gap={1} align="center">
                    {msg.value.parent ? <Badge label="Reply" variant="neutral" /> : null}
                    {(msg.labels ?? []).map((val) => (
                      <Badge key={val} label={val} variant="warning" />
                    ))}
                  </HStack>
                </HStack>

                {isHidden && !isRevealed ? (
                  <div className="desk-hidden-veil" data-testid="desk-hidden-message-warning">
                    <Text color="secondary">Hidden by group moderation (!hide)</Text>
                    <Button
                      label="Show hidden message"
                      variant="secondary"
                      size="sm"
                      onClick={() => setRevealedUris((prev) => ({ ...prev, [msg.uri]: true }))}
                      data-testid="desk-reveal-hidden-button"
                    />
                  </div>
                ) : isEditing ? (
                  <VStack gap={2}>
                    <TextArea
                      label="Edit message"
                      value={editText}
                      onChange={setEditText}
                      rows={2}
                      width="100%"
                      data-testid="desk-edit-message-input"
                    />
                    <HStack gap={2}>
                      <Button
                        label="Save edit"
                        variant="primary"
                        size="sm"
                        isDisabled={busy || editText.trim().length === 0}
                        onClick={() => void handleSaveEdit(msg.uri)}
                        data-testid="desk-save-edit-button"
                      />
                      <Button
                        label="Cancel"
                        variant="ghost"
                        size="sm"
                        onClick={() => {
                          setEditingUri(null);
                          setEditText("");
                        }}
                      />
                    </HStack>
                  </VStack>
                ) : (
                  <>
                    <p data-testid="desk-message-text">{textValue}</p>
                    {isHidden ? (
                      <div>
                        <Button
                          label="Hide again"
                          variant="ghost"
                          size="sm"
                          onClick={() => setRevealedUris((prev) => ({ ...prev, [msg.uri]: false }))}
                        />
                      </div>
                    ) : null}
                  </>
                )}

                <HStack gap={2}>
                  {isTopLevel && (!isHidden || isRevealed) ? (
                    <Button
                      label="Reply"
                      variant="ghost"
                      size="sm"
                      onClick={() => setReplyParent(msg)}
                      data-testid="desk-reply-message-button"
                    />
                  ) : null}
                  {isOwn ? (
                    <>
                      {!isHidden || isRevealed ? (
                        <Button
                          label="Edit"
                          variant="ghost"
                          size="sm"
                          onClick={() => {
                            setEditingUri(msg.uri);
                            setEditText(textValue);
                          }}
                          data-testid="desk-edit-message-button"
                        />
                      ) : null}
                      <Button
                        label="Delete"
                        variant="ghost"
                        size="sm"
                        isDisabled={busy}
                        onClick={() => void handleDelete(msg.uri)}
                        data-testid="desk-delete-message-button"
                      />
                    </>
                  ) : null}
                  {allowsMessageReports ? (
                    <Button
                      label="Report"
                      variant="ghost"
                      size="sm"
                      onClick={() =>
                        setReportTarget({
                          subject: msg.uri,
                          subjectType: "record",
                          ...(msg.cid ? { cid: msg.cid } : {}),
                          label: `Message by ${msg.repo}`,
                        })
                      }
                      data-testid="desk-report-message-button"
                    />
                  ) : null}
                </HStack>
              </article>
            );
          })
        )}
      </section>
    </VStack>
  );
}
