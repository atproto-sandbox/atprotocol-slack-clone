import type { FormEvent } from "react";
import { SPACE_TYPE } from "@flock/protocol/nsids";

type WorkspaceOnboardingProps = {
  busy: boolean;
  workspaceName: string;
  setWorkspaceName: (value: string) => void;
  joinPolicy: "invite" | "approval" | "open";
  setJoinPolicy: (value: "invite" | "approval" | "open") => void;
  publicMeta: boolean;
  setPublicMeta: (value: boolean) => void;
  inviteUri: string;
  setInviteUri: (value: string) => void;
  joinMessage: string;
  setJoinMessage: (value: string) => void;
  reactivateDid: string;
  setReactivateDid: (value: string) => void;
  createWorkspace: (event: FormEvent) => Promise<void>;
  beginAccept: (event: FormEvent) => Promise<void>;
  beginReactivate: (event: FormEvent) => Promise<void>;
};

export function WorkspaceOnboarding({
  busy,
  workspaceName,
  setWorkspaceName,
  joinPolicy,
  setJoinPolicy,
  publicMeta,
  setPublicMeta,
  inviteUri,
  setInviteUri,
  joinMessage,
  setJoinMessage,
  reactivateDid,
  setReactivateDid,
  createWorkspace,
  beginAccept,
  beginReactivate,
}: WorkspaceOnboardingProps) {
  return (
    <>
      <div className="welcome-banner">
        <div>
          <div className="eyebrow">
            <span className="eyebrow-line" /> YOUR TEAM, YOUR SPACE
          </div>
          <h1>
            Make room for
            <br />
            <em>great work.</em>
          </h1>
          <p>Create a shared workspace or accept an invitation.</p>
        </div>
        <div className="banner-illustration" aria-hidden="true">
          <div className="orb orb-large" />
          <div className="orb orb-small" />
          <div className="banner-card banner-card-main">
            <div className="banner-card-top">
              <span className="mini-avatar avatar-lilac">S</span>
              <span>
                <b>general</b>
                <small># your first channel</small>
              </span>
              <span className="card-check">✓</span>
            </div>
            <div className="banner-card-lines">
              <i />
              <i />
              <i />
            </div>
          </div>
        </div>
      </div>

      <div id="workspace-setup" className="starter-card setup-panel">
        <h2>Create a workspace</h2>
        <p>
          Creates an atmospheric <code>opensocial.group</code> DID on the Group Host with flat role-based access
          control. You authenticate with your own AT Protocol account and become the group&rsquo;s first admin.
        </p>
        <form className="inline-form" onSubmit={(e) => void createWorkspace(e)}>
          <label htmlFor="workspace-name">Workspace name</label>
          <input
            id="workspace-name"
            value={workspaceName}
            onChange={(event) => setWorkspaceName(event.target.value)}
            required
            maxLength={60}
          />
          <label htmlFor="workspace-join-policy">Join policy</label>
          <select
            id="workspace-join-policy"
            value={joinPolicy}
            onChange={(event) => setJoinPolicy(event.target.value as "invite" | "approval" | "open")}
          >
            <option value="invite">Invite only</option>
            <option value="approval">Approval required</option>
            <option value="open">Open to anyone</option>
          </select>
          <label htmlFor="workspace-public-meta">
            <input
              id="workspace-public-meta"
              type="checkbox"
              checked={publicMeta}
              onChange={(event) => setPublicMeta(event.target.checked)}
            />{" "}
            Publish public group metadata &amp; declaration
          </label>
          <button className="primary-button" disabled={busy}>
            Create workspace
          </button>
        </form>
      </div>

      <div className="starter-card setup-panel">
        <h2>Join a group or accept an invitation</h2>
        <p>
          Paste a Group DID (<code>did:plc:…</code>) or workspace URI (
          <code>{`at:space/did:…/${SPACE_TYPE.workspace}/self`}</code>) to join an open group, request moderator
          approval, or accept an invitation.
        </p>
        <form className="inline-form" onSubmit={(e) => void beginAccept(e)}>
          <label htmlFor="workspace-uri">Workspace URI</label>
          <input
            id="workspace-uri"
            value={inviteUri}
            onChange={(event) => setInviteUri(event.target.value)}
            placeholder={`did:plc:… or at:space/did:…/${SPACE_TYPE.workspace}/self`}
            required
          />
          <label htmlFor="workspace-join-message">Join message (optional, for approval groups)</label>
          <input
            id="workspace-join-message"
            value={joinMessage}
            onChange={(event) => setJoinMessage(event.target.value)}
            placeholder="Optional note to moderators"
            maxLength={500}
          />
          <button className="primary-button" disabled={busy}>
            Connect invitation
          </button>
        </form>
      </div>

      <div className="starter-card setup-panel">
        <h2>Reactivate a deactivated group</h2>
        <p>
          If the sole human admin left a group, the Group Host deactivated it reversibly. Enter its Group DID to
          authenticate in recovery mode and restore active membership.
        </p>
        <form className="inline-form" onSubmit={(e) => void beginReactivate(e)}>
          <label htmlFor="reactivate-group-did">Deactivated group DID</label>
          <input
            id="reactivate-group-did"
            value={reactivateDid}
            onChange={(event) => setReactivateDid(event.target.value)}
            placeholder="did:plc:…"
            required
          />
          <button className="text-button" disabled={busy}>
            Reactivate group →
          </button>
        </form>
      </div>
    </>
  );
}
