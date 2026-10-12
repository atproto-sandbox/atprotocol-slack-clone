"use client";

import { useMemo, useState, type FormEvent } from "react";
import type { DmDelivery, DmStartResult } from "@/dm/dm-client";
import { parseParticipantInput, participantLabel } from "@/dm/ui-logic";
import { useDmContext } from "./dm-context";

const MIN_TOTAL_PARTICIPANTS = 2;
const MAX_TOTAL_PARTICIPANTS = 100;
const PRIVATE_CHANNEL_SUGGESTION_AT = 20;

export function DmHome() {
  const { did, client, inbox, activeWorkspace, labels, openView, refresh } = useDmContext();
  const [entry, setEntry] = useState("");
  const [picked, setPicked] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [started, setStarted] = useState<DmStartResult | null>(null);
  const [localError, setLocalError] = useState("");

  const parsed = useMemo(() => parseParticipantInput(entry), [entry]);
  const recipients = useMemo(() => [...new Set([...parsed.dids, ...picked])], [parsed.dids, picked]);
  const totalParticipants = recipients.length + 1;
  const countValid = totalParticipants >= MIN_TOTAL_PARTICIPANTS && totalParticipants <= MAX_TOTAL_PARTICIPANTS;

  function toggleMember(memberDid: string) {
    setPicked((current) => current.includes(memberDid) ? current.filter((did) => did !== memberDid) : [...current, memberDid]);
  }

  async function start(event: FormEvent) {
    event.preventDefault();
    if (!client) return;
    if (!countValid || parsed.invalid.length > 0) return;
    setBusy(true);
    setLocalError("");
    try {
      const result = await client.startConversation(recipients);
      setStarted(result);
      await refresh();
    } catch (caught) {
      setLocalError(caught instanceof Error ? caught.message : "Could not start the conversation.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="section-heading">
        <div><span className="eyebrow"><span className="eyebrow-line" /> DIRECT MESSAGE</span><h2>New message</h2></div>
      </div>
      {inbox && !inbox.exists && (
        <div className="starter-card permission-box">
          <p>Your inbox does not exist yet, so nobody can send you requests. Enable direct messages to receive them.</p>
          <button className="text-button" onClick={() => openView({ kind: "settings" })}>Open DM settings →</button>
        </div>
      )}
      <div className="starter-card">
        <h3>Start a conversation</h3>
        <p>Enter participant DIDs{activeWorkspace ? " or pick members of the active workspace" : ""}. Conversations hold 2 to 100 people including you, and their participant set never changes.</p>
        <form className="inline-form" onSubmit={(event) => void start(event)}>
          <label>Participant DIDs
            <input value={entry} onChange={(event) => setEntry(event.target.value)} placeholder="did:plc:… separated by commas or spaces" />
          </label>
          {parsed.invalid.length > 0 && <p className="form-error" role="alert">Not valid DIDs: {parsed.invalid.join(", ")}</p>}
          {activeWorkspace && activeWorkspace.members.filter((member) => member.did !== did).length > 0 && (
            <div className="roster-list">
              {activeWorkspace.members.filter((member) => member.did !== did).map((member) => (
                <div className="roster-row" key={member.did}>
                  <span>{participantLabel(member.did, labels)}</span>
                  <div>
                    <button type="button" className="text-button" onClick={() => toggleMember(member.did)}>
                      {picked.includes(member.did) ? "Remove" : "Add to conversation"}
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
          <p className="status-note">{totalParticipants} participant{totalParticipants === 1 ? "" : "s"} including you.</p>
          {totalParticipants > PRIVATE_CHANNEL_SUGGESTION_AT && (
            <p className="status-note">Above 20 people a private channel may work better, since adding anyone later starts a new conversation.</p>
          )}
          {localError && <p className="form-error" role="alert">{localError}</p>}
          <button className="primary-button" disabled={busy || !countValid || parsed.invalid.length > 0}>
            {busy ? "Starting…" : "Start conversation"}
          </button>
          {!countValid && <p className="form-error">Pick between {MIN_TOTAL_PARTICIPANTS - 1} and {MAX_TOTAL_PARTICIPANTS - 1} other participants.</p>}
        </form>
      </div>
      {started && (
        <div className="starter-card">
          <h3>Delivery results</h3>
          <p>The conversation exists in your own space; each recipient is notified through their own inbox.</p>
          <div className="roster-list">
            {started.participants.filter((participant) => participant !== did).map((participant) => (
              <DeliveryRow key={participant} did={participant} label={participantLabel(participant, labels)} delivery={started.delivery[participant]} />
            ))}
          </div>
          <button className="text-button" onClick={() => openView({ kind: "conversation", convKey: started.convKey, participants: started.participants })}>
            Open conversation →
          </button>
        </div>
      )}
    </>
  );
}

function DeliveryRow({ did, label, delivery }: { did: string; label: string; delivery?: DmDelivery }) {
  const outcome = !delivery ? "not attempted" : delivery.status === "delivered" ? "delivered" : delivery.status === "noInbox" ? "noInbox — they have not enabled direct messages" : `failed${delivery.message ? ` — ${delivery.message}` : ""}`;
  return (
    <div className="roster-row">
      <span>{label} <small className="mono-note">{did}</small></span>
      <div><span className="status-note">{outcome}</span></div>
    </div>
  );
}
