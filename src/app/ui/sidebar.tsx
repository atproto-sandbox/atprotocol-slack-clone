import dynamic from "next/dynamic";
import { LogoutButton } from "./logout-button";
import { messageOf, type ChannelSelection, type Grant } from "./client-api";
import type { WorkspaceCandidate, WorkspaceSummary } from "@/workspaces/read-model";

// The DM tree touches IndexedDB and WebCrypto and must never render (or even
// load its module graph, which pulls in @atproto/oauth-client-browser) during
// server-side rendering: ssr:false keeps that whole dependency out of every
// server bundle. See dm-sidebar.tsx, dm-stage.tsx, and dm/use-dm-client.ts.
const DmSidebar = dynamic(() => import("./dm-sidebar").then((mod) => mod.DmSidebar), { ssr: false });

type SidebarProps = {
  did: string;
  workspaces: WorkspaceSummary[];
  workspaceCandidates: WorkspaceCandidate[];
  activeUri: string;
  activeWorkspace: WorkspaceSummary | null;
  activeChannel: ChannelSelection | null;
  switchWorkspace: (uri: string) => void;
  openChannel: (channel: WorkspaceSummary["channels"][number]) => Promise<void>;
  grant: Grant;
  setError: (message: string) => void;
};

export function Sidebar({ did, workspaces, workspaceCandidates, activeUri, activeWorkspace, activeChannel, switchWorkspace, openChannel, grant, setError }: SidebarProps) {
  return (
    <aside className="sidebar">
      <div className="sidebar-top"><span className="brand brand-inverse"><span className="brand-mark"><i /><i /><i /></span><span>spaces</span></span><button className="icon-button sidebar-menu" aria-label="Open menu">☰</button></div>
      <div className="workspace-heading"><span className="workspace-avatar">{activeWorkspace?.name.slice(0, 1).toUpperCase() ?? "S"}</span><span className="workspace-title"><strong>{activeWorkspace?.name ?? "Your spaces"}</strong><small>{activeWorkspace ? "AT Protocol workspace" : "Personal workspace"}</small></span></div>
      <div className="sidebar-section">
        <div className="section-label"><span>WORKSPACES</span><button className="plus-button" aria-label="Create workspace" onClick={() => switchWorkspace("")}>+</button></div>
        {workspaces.length ? workspaces.map((workspace) => <button key={workspace.uri} className={`sidebar-action ${workspace.uri === activeUri ? "selected-workspace" : ""}`} onClick={() => switchWorkspace(workspace.uri)}><span>◈</span> {workspace.name}</button>) : <div className="empty-workspaces"><span className="empty-icon">⌂</span><p>No workspaces yet</p><span>Start a space for your team</span></div>}
        {workspaceCandidates.length > 0 && <div className="channel-nav"><div className="section-label"><span>ACCEPTED · NEEDS ACCESS</span></div>{workspaceCandidates.map((candidate) => <button key={candidate.uri} className="sidebar-action" title={candidate.uri} aria-label={`Authorize reading accepted workspace ${candidate.uri}`} onClick={() => void grant("workspaceRead", candidate.uri).catch((caught) => setError(messageOf(caught)))}><span>↗</span> {candidate.skey}</button>)}</div>}
        {activeWorkspace && <div className="channel-nav"><div className="section-label"><span>CHANNELS</span></div>{activeWorkspace.channels.map((channel) => <button key={channel.skey} className={`channel-nav-item ${activeChannel?.skey === channel.skey ? "active" : ""}`} onClick={() => void openChannel(channel)}><span>{channel.visibility === "private" ? "▣" : "#"}</span>{channel.name}</button>)}</div>}
        <DmSidebar />
      </div>
      <div className="sidebar-bottom"><div className="connection-state"><span className="connection-dot" /> CONNECTED TO ATPROTO</div><div className="profile-row"><span className="profile-avatar">{did.slice(-1).toUpperCase()}</span><span className="profile-copy"><strong>{did.slice(0, 17)}…</strong><small>Signed in</small></span><LogoutButton /></div></div>
    </aside>
  );
}
