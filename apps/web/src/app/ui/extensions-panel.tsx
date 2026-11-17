"use client";

import { useState } from "react";
import { EXTENSIONS, type ExtensionId } from "@flock/protocol/extensions";
import type { WorkspaceSummary } from "@flock/protocol/workspace-summary";

export type ExtensionToggleOutcome =
  | { kind: "completed" }
  | { kind: "reauthorizationRequired"; message: string; authorityDid: string }
  | { kind: "failed" };

type ExtensionsPanelProps = {
  activeWorkspace: WorkspaceSummary;
  busy: boolean;
  workspaceDegraded: boolean;
  onToggleExtension: (extId: ExtensionId, enable: boolean) => Promise<ExtensionToggleOutcome>;
  onReauthorizeAuthority: (authorityDid: string) => Promise<void>;
  onOpenExtension?: (extId: ExtensionId) => void;
};

/**
 * Workspace admin controls for declarative first-party extensions (`D11.8`, `D11.9`).
 * Surfaces an inline authority re-consent CTA if a legacy workspace grant lacks the extension space scope.
 */
export function ExtensionsPanel({
  activeWorkspace,
  busy,
  workspaceDegraded,
  onToggleExtension,
  onReauthorizeAuthority,
  onOpenExtension,
}: ExtensionsPanelProps) {
  const [reauthNeeded, setReauthNeeded] = useState<{ extId: ExtensionId; authorityDid: string; message: string } | null>(null);
  const installedById = new Map((activeWorkspace.extensions ?? []).map((entry) => [entry.extId, entry]));

  async function toggle(extId: ExtensionId, enable: boolean) {
    setReauthNeeded(null);
    const outcome = await onToggleExtension(extId, enable);
    if (outcome.kind === "reauthorizationRequired") {
      setReauthNeeded({ extId, authorityDid: outcome.authorityDid, message: outcome.message });
    }
  }

  return (
    <>
      <div className="section-heading">
        <div>
          <span className="eyebrow">EXTENSIONS</span>
          <h2>Workspace extensions</h2>
        </div>
      </div>
      {reauthNeeded && (
        <div className="starter-card permission-box" role="alert">
          <p>
            <strong>Workspace authority re-approval required.</strong>{" "}
            {reauthNeeded.message} Channels remain unaffected.
          </p>
          <button
            type="button"
            className="text-button"
            disabled={busy}
            onClick={() => void onReauthorizeAuthority(reauthNeeded.authorityDid)}
          >
            Re-authorize workspace authority →
          </button>
        </div>
      )}
      <div className="starter-card roster-list">
        {Object.values(EXTENSIONS).map((manifest) => {
          const installed = installedById.get(manifest.id);
          const enabled = Boolean(installed?.active);
          const cleanupPending = Boolean(installed && !installed.active && !installed.cleanupComplete);
          const stateLabel = enabled ? "Enabled" : cleanupPending ? "Disabling (cleanup pending)" : "Disabled";
          return (
            <div className="roster-row extension-row" key={manifest.id}>
              <span>
                <strong>{manifest.name}</strong> · {stateLabel}
                <br />
                <small>{manifest.description}</small>
                {installed?.space && (
                  <>
                    <br />
                    <small className="mono-note">{installed.space}</small>
                  </>
                )}
              </span>
              <div>
                {enabled && onOpenExtension && (
                  <button
                    type="button"
                    className="text-button"
                    onClick={() => onOpenExtension(manifest.id)}
                  >
                    Open {manifest.name} →
                  </button>
                )}
                <button
                  type="button"
                  className={enabled ? "text-button danger" : "text-button"}
                  disabled={busy || workspaceDegraded}
                  onClick={() => void toggle(manifest.id, !enabled)}
                >
                  {enabled ? `Disable ${manifest.name}` : `Enable ${manifest.name}`}
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </>
  );
}
