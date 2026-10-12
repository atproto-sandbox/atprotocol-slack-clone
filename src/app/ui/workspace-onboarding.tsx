import type { FormEvent } from "react";

type WorkspaceOnboardingProps = {
  busy: boolean;
  workspaceName: string;
  setWorkspaceName: (value: string) => void;
  inviteUri: string;
  setInviteUri: (value: string) => void;
  createWorkspace: (event: FormEvent) => Promise<void>;
  beginAccept: (event: FormEvent) => Promise<void>;
};

export function WorkspaceOnboarding({ busy, workspaceName, setWorkspaceName, inviteUri, setInviteUri, createWorkspace, beginAccept }: WorkspaceOnboardingProps) {
  return <>
    <div className="welcome-banner"><div><div className="eyebrow"><span className="eyebrow-line" /> YOUR TEAM, YOUR SPACE</div><h1>Make room for<br /><em>great work.</em></h1><p>Create a shared workspace or accept an invitation.</p></div><div className="banner-illustration" aria-hidden="true"><div className="orb orb-large" /><div className="orb orb-small" /><div className="banner-card banner-card-main"><div className="banner-card-top"><span className="mini-avatar avatar-lilac">S</span><span><b>general</b><small># your first channel</small></span><span className="card-check">✓</span></div><div className="banner-card-lines"><i /><i /><i /></div></div></div></div>
    <div id="workspace-setup" className="starter-card setup-panel"><h2>Create a workspace</h2><p>Sign in with the dedicated workspace identity that will own its spaces and authority records. The first time, you will be asked to approve the permission it needs.</p>
      <form className="inline-form" onSubmit={createWorkspace}><label htmlFor="workspace-name">Workspace name</label><input id="workspace-name" value={workspaceName} onChange={(event) => setWorkspaceName(event.target.value)} required maxLength={60} /><button className="primary-button" disabled={busy}>Create workspace</button></form>
    </div>
    <div className="starter-card setup-panel"><h2>Accept an invitation</h2><p>Paste the workspace URI shared by an admin. Membership remains enforced by the PDS.</p><form className="inline-form" onSubmit={beginAccept}><label htmlFor="workspace-uri">Workspace URI</label><input id="workspace-uri" value={inviteUri} onChange={(event) => setInviteUri(event.target.value)} placeholder="at://did:.../space/org.slack.workspace/key" required /><button className="primary-button" disabled={busy}>Connect invitation</button></form></div>
  </>;
}
