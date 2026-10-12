"use client";

import { useState } from "react";
import { inviteLinkFor, makeShortId, splitDids, toSlug, type Grant, type InboxRequest, type RunOperation } from "./client-api";
import type { WorkspaceSummary } from "@/workspaces/read-model";

type WorkspaceHomeProps = {
  did: string;
  activeWorkspace: WorkspaceSummary;
  busy: boolean;
  workspaceDegraded: boolean;
  needOperatorLeave: boolean;
  inbox: InboxRequest[];
  inboxLoaded: boolean;
  inboxPermissionMissing: boolean;
  runOperation: RunOperation;
  grant: Grant;
  leaveWorkspace: () => Promise<void>;
  syncInbox: () => void;
  setStatus: (message: string) => void;
  setError: (message: string) => void;
};

export function WorkspaceHome({ did, activeWorkspace, busy, workspaceDegraded, needOperatorLeave, inbox, inboxLoaded, inboxPermissionMissing, runOperation, grant, leaveWorkspace, syncInbox, setStatus, setError }: WorkspaceHomeProps) {
  const [inviteDid, setInviteDid] = useState("");
  const [channelName, setChannelName] = useState("");
  const [channelVisibility, setChannelVisibility] = useState<"public" | "private">("public");
  const [privateMembers, setPrivateMembers] = useState("");

  return <>
    <div className="welcome-banner"><div><div className="eyebrow"><span className="eyebrow-line" /> WORKSPACE HOME</div><h1>{activeWorkspace.name}</h1><p>{activeWorkspace.members.length} active members · {activeWorkspace.channels.length} channels</p><p className="mono-note">{activeWorkspace.uri}</p><button className="text-button" onClick={() => void navigator.clipboard.writeText(activeWorkspace.uri).then(() => setStatus("Workspace URI copied."), () => setError("Could not copy the workspace URI."))}>Copy workspace URI</button><button className="text-button" onClick={() => void navigator.clipboard.writeText(inviteLinkFor(window.location.origin, activeWorkspace.uri)).then(() => setStatus("Invite link copied. Send it to the people you added so they can join."), () => setError("Could not copy the invite link."))}>Copy invite link</button></div><div className="banner-illustration"><div className="banner-card banner-card-main"><b>Workspace data</b><p>Authority: {activeWorkspace.authorityDid}</p><p>Directory and membership are read from AT Protocol spaces.</p></div></div></div>
    {activeWorkspace.isAdmin && <><div className="section-heading"><div><span className="eyebrow">GETTING STARTED</span><h2>Workspace controls</h2></div></div>
    <div className="starter-grid"><article className="starter-card"><span className="starter-icon icon-violet">＋</span><h3>Invite a member</h3><p>Add their DID to workspace, inbox, and public-channel membership.</p><form onSubmit={(event) => { event.preventDefault(); void runOperation({ kind: "inviteMember", subject: inviteDid }); setInviteDid(""); }}><input aria-label="Member DID" value={inviteDid} onChange={(event) => setInviteDid(event.target.value)} placeholder="did:plc:…" required /><button className="text-button" disabled={busy || workspaceDegraded}>Invite member →</button></form></article>
      <article className="starter-card"><span className="starter-icon icon-mint">#</span><h3>Create a channel</h3><p>Membership is applied before the directory entry becomes visible.</p><form onSubmit={(event) => { event.preventDefault(); const skey = `${toSlug(channelName)}-${makeShortId()}`; const members = splitDids(privateMembers); void runOperation({ kind: "createChannel", skey, name: channelName, visibility: channelVisibility, ...(channelVisibility === "private" ? { members } : {}) }); setChannelName(""); }}><input aria-label="Channel name" value={channelName} onChange={(event) => setChannelName(event.target.value)} placeholder="project-room" required /><select aria-label="Channel visibility" value={channelVisibility} onChange={(event) => setChannelVisibility(event.target.value as "public" | "private")}><option value="public">Public</option><option value="private">Private</option></select>{channelVisibility === "private" && <input aria-label="Private member DIDs" value={privateMembers} onChange={(event) => setPrivateMembers(event.target.value)} placeholder="Member DIDs, comma separated" /> }<button className="text-button" disabled={busy || workspaceDegraded}>Create channel →</button></form></article>
      <article className="starter-card"><span className="starter-icon icon-peach">⚙</span><h3>Operator permissions</h3><p>Grant this admin identity the exact XRPC method scopes used for workspace changes.</p><button className="text-button" type="button" disabled={workspaceDegraded} onClick={() => void grant("operatorAdmin", activeWorkspace.uri)}>Grant admin controls →</button></article></div></>}
    {did !== activeWorkspace.authorityDid && <div className="starter-card lifecycle-card"><h3>Leave workspace</h3><p>Leaving removes your workspace, inbox, public-channel, and private-channel memberships.</p><button className="text-button danger" disabled={busy || workspaceDegraded} onClick={() => void leaveWorkspace()}>Leave this workspace</button>{needOperatorLeave && <button className="text-button" disabled={workspaceDegraded} onClick={() => void grant("operatorLeave", activeWorkspace.uri)}>Authorize leave control →</button>}</div>}
    {activeWorkspace.isAdmin && <>
      <div className="section-heading"><div><span className="eyebrow">MEMBERS</span><h2>Current workspace roster</h2></div></div>
      <div className="starter-card roster-list">{activeWorkspace.members.map((member) => <div className="roster-row" key={member.did}><span>{member.did}</span>{member.did !== activeWorkspace.authorityDid && <div><button className="text-button" disabled={workspaceDegraded} onClick={() => void runOperation({ kind: "setAdmin", subject: member.did, active: !activeWorkspace.admins.includes(member.did) })}>{activeWorkspace.admins.includes(member.did) ? "Demote admin" : "Make admin"}</button><button className="text-button danger" disabled={workspaceDegraded} onClick={() => void runOperation({ kind: "removeMember", subject: member.did })}>Remove</button></div>}</div>)}</div>
      <div className="section-heading"><div><span className="eyebrow">PRIVATE CHANNEL INBOX</span><h2>Join requests</h2></div><button className="text-button" disabled={workspaceDegraded} onClick={syncInbox}>Sync inbox ↻</button></div>
      <div className="starter-card roster-list">{inbox.length === 0 ? <p>{inboxPermissionMissing ? <>Grant operator controls to sync private-channel requests. <button className="text-button" onClick={() => void grant("operatorAdmin", activeWorkspace.uri)}>Grant admin controls →</button></> : inboxLoaded ? "No pending join requests." : "Inbox has not been synced yet."}</p> : inbox.map((joinRequest) => <div className="roster-row" key={joinRequest.uri}><span>{joinRequest.repoDid} requested #{joinRequest.channelName}</span><div><button className="text-button" onClick={() => void runOperation({ kind: "decideJoinRequest", request: joinRequest.uri, requestId: joinRequest.requestId, decision: "approve" })}>Approve</button><button className="text-button danger" onClick={() => void runOperation({ kind: "decideJoinRequest", request: joinRequest.uri, requestId: joinRequest.requestId, decision: "deny" })}>Deny</button></div></div>)}</div>
    </>}
  </>;
}
