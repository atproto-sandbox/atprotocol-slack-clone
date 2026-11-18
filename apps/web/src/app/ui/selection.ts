import type { WorkspaceSummary } from "@flock/protocol/workspace-summary";
import type { ChannelSelection } from "./client-api";

/** A channel a person chose, by its key in its workspace; what is shown of it follows the workspace's directory. */
export type ChosenChannel = { workspace: string; skey: string };

/** Chosen instead of a workspace: the form to create one or to join one by its link. */
export const NO_WORKSPACE = "";

/**
 * The workspace shown for what a person chose (a workspace URI, `NO_WORKSPACE`, or null before any choice): the chosen one
 * while it is listed, none for `NO_WORKSPACE`, else the first listed.
 */
export function shownWorkspace(workspaces: readonly WorkspaceSummary[], chosen: string | null): WorkspaceSummary | null {
  if (chosen === NO_WORKSPACE) return null;
  return workspaces.find((workspace) => workspace.uri === chosen) ?? workspaces[0] ?? null;
}

/** The chosen channel while the shown workspace's directory lists it, with the name and visibility the directory gives it now. */
export function shownChannel(workspace: WorkspaceSummary | null, chosen: ChosenChannel | null): ChannelSelection | null {
  if (!workspace || !chosen || chosen.workspace !== workspace.uri) return null;
  const channel = workspace.channels.find((entry) => entry.skey === chosen.skey);
  return channel ? { workspace: workspace.uri, skey: channel.skey, name: channel.name, visibility: channel.visibility } : null;
}
