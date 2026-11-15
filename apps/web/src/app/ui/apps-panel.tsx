"use client";

import { useEffect, useState, type FormEvent } from "react";
import type { AppDeclaration } from "@flock/client/workspace-client";
import { REPO_COLLECTION } from "@flock/protocol/nsids";
import type { WorkspaceSummary } from "@flock/protocol/workspace-summary";
import { messageOf, type RunOperation } from "./client-api";

/** What the panel asks of the engine: an account's app declaration, and the DID of an account an admin typed. */
export type AppDirectory = { declaration(did: string): Promise<AppDeclaration | null>; resolve(account: string): Promise<string> };

type Access = "none" | "read" | "write";

/**
 * The workspace's apps, for its admins: each install with its declared name and what it may read and write, a form that
 * installs an account only when it declares itself an app (or changes an installed app's channels), and removal, said first
 * to take the app's earlier messages out of every channel's view.
 */
export function AppsPanel({ activeWorkspace, busy, workspaceDegraded, runOperation, apps, setError }: {
  activeWorkspace: WorkspaceSummary;
  busy: boolean;
  workspaceDegraded: boolean;
  runOperation: RunOperation;
  apps: AppDirectory | null;
  setError: (message: string) => void;
}) {
  const [names, setNames] = useState<Record<string, string>>({});
  const [account, setAccount] = useState("");
  const [access, setAccess] = useState<Record<string, Access>>({});
  const [editing, setEditing] = useState<string | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const channels = activeWorkspace.channels.filter((channel) => channel.visibility === "public" || channel.visibility === "private");
  const channelName = (skey: string) => channels.find((channel) => channel.skey === skey)?.name ?? skey;
  const nameOf = (did: string) => names[did] ?? did;

  useEffect(() => {
    if (!apps) return;
    for (const { did } of activeWorkspace.installs) {
      if (names[did]) continue;
      void apps.declaration(did).then((declared) => setNames((current) => ({ ...current, [did]: declared?.name ?? did })), () => undefined);
    }
  }, [apps, activeWorkspace.installs, names]);

  function reset() {
    setAccount("");
    setAccess({});
    setEditing(null);
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!apps) return;
    try {
      const subject = editing ?? await apps.resolve(account);
      if (!editing && !(await apps.declaration(subject))) {
        setError(`That account has not declared itself an app: an app publishes ${REPO_COLLECTION.appDeclaration} in its own repo.`);
        return;
      }
      const grants = Object.entries(access).filter(([, level]) => level !== "none").map(([skey, level]) => ({ skey, write: level === "write" }));
      await runOperation({ kind: editing ? "updateAppAccess" : "installApp", subject, channels: grants });
      reset();
    } catch (caught) {
      setError(messageOf(caught));
    }
  }

  function change(install: WorkspaceSummary["installs"][number]) {
    setEditing(install.did);
    setAccess(Object.fromEntries(install.channels.map(({ skey, write }) => [skey, write ? "write" : "read"])));
  }

  return <>
    <div className="section-heading"><div><span className="eyebrow">APPS</span><h2>Installed apps</h2></div></div>
    <div className="starter-card roster-list">
      {activeWorkspace.installs.length === 0 ? <p>No apps are installed.</p> : activeWorkspace.installs.map((install) => <div className="roster-row app-row" key={install.did}>
        <span>{nameOf(install.did)} · {install.channels.map(({ skey, write }) => `#${channelName(skey)} (${write ? "read and write" : "read"})`).join(", ") || "no channels"}</span>
        <div><button className="text-button" disabled={busy || workspaceDegraded} onClick={() => change(install)}>Change access</button><button className="text-button danger" disabled={busy || workspaceDegraded} onClick={() => setRemoving(install.did)}>Remove</button></div>
      </div>)}
      {removing && <div className="roster-row" role="alert"><span>Removing {nameOf(removing)} also takes its earlier messages out of every channel’s view.</span><div><button className="text-button danger" disabled={busy || workspaceDegraded} onClick={() => { void runOperation({ kind: "uninstallApp", subject: removing }); setRemoving(null); }}>Remove app</button><button className="text-button" onClick={() => setRemoving(null)}>Cancel</button></div></div>}
    </div>
    <form className="starter-card" onSubmit={(event) => void submit(event)}>
      <h3>{editing ? `Change ${nameOf(editing)}’s access` : "Install an app"}</h3>
      <p>An app is an account that declares itself one. It reads the workspace, and the channels you grant it.</p>
      {!editing && <input aria-label="App account" value={account} onChange={(event) => setAccount(event.target.value)} placeholder="handle or did:plc:…" required />}
      {channels.map((channel) => <select key={channel.skey} aria-label={`Access to #${channel.name}`} value={access[channel.skey] ?? "none"} onChange={(event) => setAccess((current) => ({ ...current, [channel.skey]: event.target.value as Access }))}>
        <option value="none">#{channel.name}: no access</option><option value="read">#{channel.name}: read</option><option value="write">#{channel.name}: read and write</option>
      </select>)}
      <button className="text-button" disabled={busy || workspaceDegraded || !apps}>{editing ? "Save access →" : "Install app →"}</button>
      {editing && <button type="button" className="text-button" onClick={reset}>Cancel</button>}
    </form>
  </>;
}
