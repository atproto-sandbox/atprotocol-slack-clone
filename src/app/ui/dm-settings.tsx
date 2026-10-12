"use client";

import { useState, type FormEvent } from "react";
import type { DmRequestMode } from "@/dm/dm-client";
import { applyAllowlistEdit, coMemberDids, parseParticipantInput, participantLabel, type UiWorkspace } from "@/dm/ui-logic";
import { messageOf } from "./client-api";
import { useDmContext } from "./dm-context";

const MODES: Array<{ value: DmRequestMode; label: string }> = [
  { value: "everyone", label: "Everyone" },
  { value: "allowlist", label: "Only people I allow" },
  { value: "nobody", label: "Nobody" },
];

export function DmSettings() {
  const { did, client, inbox, workspaces, labels, disconnect, setError, refresh } = useDmContext();
  const [modeOverride, setModeOverride] = useState<DmRequestMode | null>(null);
  const [addEntry, setAddEntry] = useState("");
  const [localError, setLocalError] = useState("");
  const [busy, setBusy] = useState(false);
  // The user's selection wins once made; before that the mode read from the PDS
  // shows (defaulting to the safer "Only people I allow" before enabling).
  const mode = modeOverride ?? inbox?.mode ?? "allowlist";

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setLocalError("");
    try {
      await action();
      await refresh();
    } catch (caught) {
      setLocalError(messageOf(caught));
    } finally {
      setBusy(false);
    }
  }

  async function enable() {
    if (!client) return;
    setModeOverride(mode);
    await run(() => client.enableDms(mode, coMemberDids(workspaces, did)));
  }

  async function changeMode(next: DmRequestMode) {
    if (!client) return;
    setModeOverride(next);
    await run(() => applyAllowlistEdit(client, { mode: next }));
  }

  async function addDids(event: FormEvent) {
    event.preventDefault();
    if (!client) return;
    const parsed = parseParticipantInput(addEntry);
    if (parsed.invalid.length > 0) {
      setLocalError(`Not valid DIDs: ${parsed.invalid.join(", ")}`);
      return;
    }
    if (parsed.dids.length === 0) return;
    setAddEntry("");
    await run(() => applyAllowlistEdit(client, { mode, add: parsed.dids }));
  }

  async function removeDid(target: string) {
    if (!client) return;
    await run(() => applyAllowlistEdit(client, { mode, remove: [target] }));
  }

  async function allowWorkspace(workspace: UiWorkspace) {
    if (!client) return;
    const seed = coMemberDids([workspace], did);
    if (seed.length === 0) return;
    await run(() => applyAllowlistEdit(client, { mode, add: seed }));
  }

  return (
    <>
      <div className="section-heading">
        <div><span className="eyebrow"><span className="eyebrow-line" /> DIRECT MESSAGE</span><h2>Request settings</h2></div>
      </div>
      <div className="starter-card">
        <h3>Who can start a conversation with you</h3>
        <p>This setting is stored on your PDS, not in any app, so every client you sign into sees the same policy.</p>
        {!inbox?.exists && <p className="status-note">Direct messages are not enabled yet. Enabling creates your inbox with “Only people I allow”, pre-filled with the people you share workspaces with.</p>}
        <div className="inline-form">
          {MODES.map((entry) => (
            <label key={entry.value}>
              <input
                type="radio"
                name="dm-request-mode"
                value={entry.value}
                checked={mode === entry.value}
                disabled={busy || !inbox?.exists}
                onChange={() => void changeMode(entry.value)}
              /> {entry.label}
            </label>
          ))}
          {localError && <p className="form-error" role="alert">{localError}</p>}
          {!inbox?.exists
            ? <button className="primary-button" disabled={busy} onClick={() => void enable()}>{busy ? "Enabling…" : "Enable direct messages"}</button>
            : <p className="status-note">Current mode: {MODES.find((entry) => entry.value === mode)?.label}. Replying to a request always allows that sender.</p>}
        </div>
      </div>
      {inbox?.exists && (
        <div className="starter-card">
          <h3>Allowlist</h3>
          <p>New workspace members are added to your allowlist on the next app open.</p>
          <form className="inline-form" onSubmit={(event) => void addDids(event)}>
            <label>Allow a DID
              <input value={addEntry} onChange={(event) => setAddEntry(event.target.value)} placeholder="did:plc:…" />
            </label>
            <button className="text-button" disabled={busy || addEntry.trim().length === 0}>Add to allowlist →</button>
          </form>
          {workspaces.map((workspace) => (
            <button key={workspace.uri} className="text-button" disabled={busy} onClick={() => void allowWorkspace(workspace)}>
              Allow all members of {workspace.name} →
            </button>
          ))}
          {inbox.allowlist.length === 0
            ? <p>Nobody is on your allowlist yet.</p>
            : (
              <div className="roster-list">
                {inbox.allowlist.map((entry) => (
                  <div className="roster-row" key={entry}>
                    <span>{participantLabel(entry, labels)} <small className="mono-note">{entry}</small></span>
                    <div><button className="text-button danger" disabled={busy} onClick={() => void removeDid(entry)}>Remove</button></div>
                  </div>
                ))}
              </div>
            )}
        </div>
      )}
      <div className="starter-card lifecycle-card">
        <h3>Disconnect</h3>
        <p>Revokes this browser’s direct-message session. Your conversations and inbox stay on your PDS.</p>
        <button className="text-button danger" disabled={busy} onClick={() => void disconnect().catch((caught) => setError(messageOf(caught)))}>Disconnect direct messages</button>
      </div>
    </>
  );
}
