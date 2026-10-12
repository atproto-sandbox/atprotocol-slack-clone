"use client";

import { useState } from "react";
import type { DmRequest } from "@/dm/dm-client";
import { participantLabel, sharesAnyWorkspace } from "@/dm/ui-logic";
import { messageOf } from "./client-api";
import { useDmContext } from "./dm-context";

export function DmRequests() {
  const { client, requests, skippedNote, workspaces, labels, openView, setError, refresh } = useDmContext();
  const [busyUri, setBusyUri] = useState("");
  const shared = requests.filter((request) => sharesAnyWorkspace(request.sender, workspaces));
  const others = requests.filter((request) => !sharesAnyWorkspace(request.sender, workspaces));

  async function accept(request: DmRequest) {
    if (!client) return;
    setBusyUri(request.uri);
    try {
      await client.accept(request);
      await refresh();
      openView({ kind: "conversation", convKey: request.convKey, participants: request.participants });
    } catch (caught) {
      setError(messageOf(caught));
    } finally {
      setBusyUri("");
    }
  }

  async function hide(request: DmRequest) {
    if (!client) return;
    setBusyUri(request.uri);
    try {
      await client.hideRequest(request.uri);
      await refresh();
    } catch (caught) {
      setError(messageOf(caught));
    } finally {
      setBusyUri("");
    }
  }

  return (
    <>
      <div className="section-heading">
        <div><span className="eyebrow"><span className="eyebrow-line" /> DIRECT MESSAGE</span><h2>Requests</h2></div>
      </div>
      {skippedNote && <p className="status-note" role="status">{skippedNote}</p>}
      <div className="starter-card">
        <h3>From people you share a workspace with</h3>
        <p>Accepting creates your half of the conversation and always allows the sender on your PDS.</p>
        <RequestList requests={shared} labels={labels} busyUri={busyUri} accept={accept} hide={hide} empty="No requests from workspace co-members." />
      </div>
      <div className="starter-card">
        <h3>Others</h3>
        <p>Requests from everyone else, kept out of your conversation list until accepted.</p>
        <RequestList requests={others} labels={labels} busyUri={busyUri} accept={accept} hide={hide} empty="No other requests." />
      </div>
    </>
  );
}

function RequestList({ requests, labels, busyUri, accept, hide, empty }: {
  requests: DmRequest[];
  labels: Readonly<Record<string, string>>;
  busyUri: string;
  accept: (request: DmRequest) => Promise<void>;
  hide: (request: DmRequest) => Promise<void>;
  empty: string;
}) {
  if (requests.length === 0) return <p>{empty}</p>;
  return (
    <div className="roster-list">
      {requests.map((request) => (
        <div className="roster-row" key={request.uri}>
          <span>
            {participantLabel(request.sender, labels)} <small className="mono-note">{request.sender}</small>
            <br />
            <small>{request.participants.length} participants · {request.createdAt}</small>
          </span>
          <div>
            <button className="text-button" disabled={busyUri === request.uri} onClick={() => void accept(request)}>Accept</button>
            <button className="text-button danger" disabled={busyUri === request.uri} onClick={() => void hide(request)}>Hide</button>
          </div>
        </div>
      ))}
    </div>
  );
}
