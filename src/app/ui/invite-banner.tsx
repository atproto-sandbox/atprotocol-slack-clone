import { parseWorkspaceUri } from "./client-api";

export function InviteBanner({ workspace, busy, join, dismiss }: { workspace: string; busy: boolean; join: () => void; dismiss: () => void }) {
  const owner = parseWorkspaceUri(workspace)?.authorityDid;
  return (
    <div className="starter-card" role="region" aria-label="Workspace invitation">
      <h3>You&rsquo;ve been invited to a workspace</h3>
      <p className="mono-note">{workspace}</p>
      {owner && <p>Owned by <span className="mono-note">{owner}</span>. Anyone can send an invite link, so join only if you recognise this account.</p>}
      <p>Joining asks your PDS for permission to read it and records that you accepted. It opens only if an admin has added your account.</p>
      <button className="primary-button" type="button" disabled={busy} onClick={join}>Join this workspace</button>
      <button className="text-button" type="button" disabled={busy} onClick={dismiss}>Dismiss</button>
    </div>
  );
}
