"use client";

import { useState } from "react";
import type { Engine } from "@flock/client/engine";
import type { GroupClient, GroupRule } from "@flock/client/group-client";
import type { ExtensionId } from "@flock/protocol/extensions";
import type { WorkspaceSummary } from "@flock/protocol/workspace-summary";
import type { GroupBrowserOAuthClient } from "../../browser/group-session";
import { AppsPanel, type AppDirectory } from "./apps-panel";
import { inviteLinkFor, makeShortId, splitDids, toSlug, type InboxRequest, type RunOperation } from "./client-api";
import { ExtensionsPanel, type ExtensionToggleOutcome } from "./extensions-panel";
import { GroupGovernancePanel, safeWebsiteUrl } from "./group-governance-panel";
import type { WorkspaceDeclarations } from "./interactions";
import { ModerationPanel } from "./moderation-panel";
import { ReportSubjectButton, type ReportRuleOption, type SubmitReportFn } from "./report-subject-modal";
import { useBrowserSessionContext } from "./session-context";

type WorkspaceHomeProps = {
  did: string;
  engine: Engine | null;
  groupClient: GroupClient | null;
  groupOAuth: GroupBrowserOAuthClient | null;
  returnTo: string;
  activeWorkspace: WorkspaceSummary;
  declarations: WorkspaceDeclarations;
  busy: boolean;
  workspaceDegraded: boolean;
  inbox: InboxRequest[];
  inboxLoaded: boolean;
  inboxPermissionMissing: boolean;
  reportRules: readonly ReportRuleOption[];
  onRulesChanged: (rules: GroupRule[]) => void;
  onReportSubject: SubmitReportFn;
  onGroupClientChanged: () => Promise<void>;
  onWorkspaceMutated: () => Promise<void>;
  onGroupDeleted: () => void;
  runOperation: RunOperation;
  onToggleExtension: (extId: ExtensionId, enable: boolean) => Promise<ExtensionToggleOutcome>;
  onReauthorizeAuthority: (authorityDid: string) => Promise<void>;
  onOpenExtension?: (extId: ExtensionId) => void;
  leaveWorkspace: () => Promise<void>;
  syncInbox: () => void;
  setStatus: (message: string) => void;
  setError: (message: string) => void;
  apps: AppDirectory | null;
};

export function buildVisibleWorkspaceRoster(
  activeWorkspace: Pick<WorkspaceSummary, "members" | "pendingMembers" | "takendownMembers">,
): Array<{ did: string; roles: string[]; pending: boolean }> {
  const takendownSet = new Set(activeWorkspace.takendownMembers ?? []);
  return [
    ...activeWorkspace.members
      .filter((m) => !takendownSet.has(m.did))
      .map((m) => ({ did: m.did, roles: m.roles, pending: false })),
    ...activeWorkspace.pendingMembers
      .filter((m) => !takendownSet.has(m.did))
      .map((m) => ({ did: m.did, roles: m.roles, pending: true })),
  ];
}

export function WorkspaceHome({
  did,
  engine,
  groupClient,
  groupOAuth,
  returnTo,
  activeWorkspace,
  declarations,
  busy,
  workspaceDegraded,
  inbox,
  inboxLoaded,
  inboxPermissionMissing,
  reportRules,
  onRulesChanged,
  onReportSubject,
  onGroupClientChanged,
  onWorkspaceMutated,
  onGroupDeleted,
  runOperation,
  onToggleExtension,
  onReauthorizeAuthority,
  onOpenExtension,
  leaveWorkspace,
  syncInbox,
  setStatus,
  setError,
  apps,
}: WorkspaceHomeProps) {
  const { connect: connectBrowser } = useBrowserSessionContext();
  const [inviteDid, setInviteDid] = useState("");
  const [channelName, setChannelName] = useState("");
  const [channelVisibility, setChannelVisibility] = useState<"public" | "private">("public");
  const [privateMembers, setPrivateMembers] = useState("");

  const combinedRoster = buildVisibleWorkspaceRoster(activeWorkspace);

  return (
    <>
      <div className="welcome-banner">
        <div>
          <div className="eyebrow">
            <span className="eyebrow-line" /> WORKSPACE HOME
          </div>
          <h1>{activeWorkspace.name}</h1>
          <p>
            {activeWorkspace.members.length} active members · {activeWorkspace.channels.length} channels · join policy:{" "}
            <b>{activeWorkspace.joinPolicy}</b>
          </p>
          {activeWorkspace.description && <p>{activeWorkspace.description}</p>}
          {(() => {
            const safeSite = safeWebsiteUrl(activeWorkspace.website);
            return safeSite ? (
              <p>
                <a href={safeSite} target="_blank" rel="noreferrer noopener" data-testid="workspace-website-link">
                  {safeSite}
                </a>
              </p>
            ) : null;
          })()}
          <p className="mono-note">{activeWorkspace.uri}</p>
          <button
            className="text-button"
            onClick={() =>
              void navigator.clipboard.writeText(activeWorkspace.uri).then(
                () => setStatus("Workspace URI copied."),
                () => setError("Could not copy the workspace URI."),
              )
            }
          >
            Copy workspace URI
          </button>
          <button
            className="text-button"
            onClick={() =>
              void navigator.clipboard.writeText(inviteLinkFor(window.location.origin, activeWorkspace.uri)).then(
                () => setStatus("Invite link copied. Send it to the people you added so they can join."),
                () => setError("Could not copy the invite link."),
              )
            }
          >
            Copy invite link
          </button>
        </div>
        <div className="banner-illustration">
          <div className="banner-card banner-card-main">
            <b>Atmospheric group</b>
            <p>Group DID: {activeWorkspace.authorityDid}</p>
            <p>Governance &amp; RBAC enforced by Atmosphere Groups spaces.</p>
          </div>
        </div>
      </div>

      {activeWorkspace.isAdmin && (
        <>
          <div className="section-heading">
            <div>
              <span className="eyebrow">GETTING STARTED</span>
              <h2>Workspace controls</h2>
            </div>
          </div>
          <div className="starter-grid">
            <article className="starter-card">
              <span className="starter-icon icon-violet">＋</span>
              <h3>Invite a member</h3>
              <p>Admits their DID to group membership so they can join with one click.</p>
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  void runOperation({ kind: "inviteMember", subject: inviteDid });
                  setInviteDid("");
                }}
              >
                <input
                  aria-label="Member DID"
                  value={inviteDid}
                  onChange={(event) => setInviteDid(event.target.value)}
                  placeholder="did:plc:…"
                  required
                />
                <button className="text-button" disabled={busy || workspaceDegraded}>
                  Invite member →
                </button>
              </form>
            </article>

            <article className="starter-card">
              <span className="starter-icon icon-mint">#</span>
              <h3>Create a channel</h3>
              <p>Role-based policy is applied before the directory entry becomes visible.</p>
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  const skey = `${toSlug(channelName)}-${makeShortId()}`;
                  const members = splitDids(privateMembers);
                  void runOperation({
                    kind: "createChannel",
                    skey,
                    name: channelName,
                    visibility: channelVisibility,
                    ...(channelVisibility === "private" ? { members } : {}),
                  });
                  setChannelName("");
                }}
              >
                <input
                  aria-label="Channel name"
                  value={channelName}
                  onChange={(event) => setChannelName(event.target.value)}
                  placeholder="project-room"
                  required
                />
                <select
                  aria-label="Channel visibility"
                  value={channelVisibility}
                  onChange={(event) => setChannelVisibility(event.target.value as "public" | "private")}
                >
                  <option value="public">Public</option>
                  <option value="private">Private</option>
                </select>
                {channelVisibility === "private" && (
                  <input
                    aria-label="Private member DIDs"
                    value={privateMembers}
                    onChange={(event) => setPrivateMembers(event.target.value)}
                    placeholder="Member DIDs, comma separated"
                  />
                )}
                <button className="text-button" disabled={busy || workspaceDegraded}>
                  Create channel →
                </button>
              </form>
            </article>
          </div>
        </>
      )}

      {did !== activeWorkspace.authorityDid && (
        <div className="starter-card lifecycle-card">
          <h3>Leave workspace</h3>
          <p>
            Leaving atomically revokes your group membership and removes your own-PDS acceptance record (refusing if
            you are the last human admin while other members remain).
          </p>
          <button
            className="text-button danger"
            disabled={busy || workspaceDegraded}
            onClick={() => void leaveWorkspace()}
          >
            Leave this workspace
          </button>
        </div>
      )}

      <div className="section-heading">
        <div>
          <span className="eyebrow">MEMBERS</span>
          <h2>Current workspace roster</h2>
        </div>
      </div>
      <div className="starter-card roster-list">
        {combinedRoster.map((member) => (
          <div className="roster-row" key={member.did}>
            <span>
              {member.did}
              {member.roles.length > 0 ? ` (${member.roles.join(", ")})` : ""}
              {member.pending ? " · pending acceptance" : ""}
            </span>
            <div>
              {activeWorkspace.isAdmin && member.did !== activeWorkspace.authorityDid && (
                <>
                  <button
                    className="text-button"
                    disabled={busy || workspaceDegraded}
                    onClick={() =>
                      void runOperation({
                        kind: "setAdmin",
                        subject: member.did,
                        active: !activeWorkspace.admins.includes(member.did),
                      })
                    }
                  >
                    {activeWorkspace.admins.includes(member.did) ? "Demote admin" : "Make admin"}
                  </button>
                  <button
                    className="text-button danger"
                    disabled={busy || workspaceDegraded}
                    onClick={() => void runOperation({ kind: "removeMember", subject: member.did })}
                  >
                    Remove
                  </button>
                </>
              )}
              {member.did !== did && (
                <ReportSubjectButton
                  subject={member.did}
                  subjectLabel="Report member"
                  rules={reportRules}
                  onSubmitReport={onReportSubject}
                  onReported={() => setStatus(`Reported ${member.did} to group moderators.`)}
                  onError={setError}
                />
              )}
            </div>
          </div>
        ))}
      </div>

      {activeWorkspace.isAdmin && (
        <>
          <div className="section-heading">
            <div>
              <span className="eyebrow">PRIVATE CHANNEL INBOX</span>
              <h2>Join requests</h2>
            </div>
            <button className="text-button" disabled={workspaceDegraded} onClick={syncInbox}>
              Sync inbox ↻
            </button>
          </div>
          <div className="starter-card roster-list">
            {inbox.length === 0 ? (
              <p>
                {inboxPermissionMissing ? (
                  <>
                    This browser’s permission does not cover the workspace inbox.{" "}
                    <button className="text-button" onClick={connectBrowser}>
                      Connect this browser again →
                    </button>
                  </>
                ) : inboxLoaded ? (
                  "No pending join requests."
                ) : (
                  "Inbox has not been synced yet."
                )}
              </p>
            ) : (
              inbox.map((joinRequest) => (
                <div className="roster-row" key={joinRequest.uri}>
                  <span>
                    {joinRequest.repoDid} requested #{joinRequest.channelName}
                  </span>
                  <div>
                    <button
                      className="text-button"
                      disabled={busy || workspaceDegraded}
                      onClick={() =>
                        void runOperation({
                          kind: "decideJoinRequest",
                          request: joinRequest.uri,
                          requestId: joinRequest.requestId,
                          decision: "approve",
                        })
                      }
                    >
                      Approve
                    </button>
                    <button
                      className="text-button danger"
                      disabled={busy || workspaceDegraded}
                      onClick={() =>
                        void runOperation({
                          kind: "decideJoinRequest",
                          request: joinRequest.uri,
                          requestId: joinRequest.requestId,
                          decision: "deny",
                        })
                      }
                    >
                      Deny
                    </button>
                  </div>
                </div>
              ))
            )}
          </div>
          <ExtensionsPanel
            key={`ext:${activeWorkspace.uri}`}
            activeWorkspace={activeWorkspace}
            busy={busy}
            workspaceDegraded={workspaceDegraded}
            onToggleExtension={onToggleExtension}
            onReauthorizeAuthority={onReauthorizeAuthority}
            onOpenExtension={onOpenExtension}
          />
          <AppsPanel
            key={activeWorkspace.uri}
            activeWorkspace={activeWorkspace}
            declarations={declarations}
            busy={busy}
            workspaceDegraded={workspaceDegraded}
            runOperation={runOperation}
            apps={apps}
            setError={setError}
          />
        </>
      )}

      <GroupGovernancePanel
        key={`gov:${activeWorkspace.uri}`}
        activeWorkspace={activeWorkspace}
        engine={engine}
        groupClient={groupClient}
        groupOAuth={groupOAuth}
        returnTo={returnTo}
        onGroupClientChanged={onGroupClientChanged}
        onWorkspaceMutated={onWorkspaceMutated}
        onGroupDeleted={onGroupDeleted}
        setStatus={setStatus}
        setError={setError}
      />

      <ModerationPanel
        key={`mod:${activeWorkspace.uri}`}
        activeWorkspace={activeWorkspace}
        groupClient={groupClient}
        groupOAuth={groupOAuth}
        returnTo={returnTo}
        onRulesChanged={onRulesChanged}
        onAfterModerationChange={onWorkspaceMutated}
        setStatus={setStatus}
        setError={setError}
      />
    </>
  );
}
