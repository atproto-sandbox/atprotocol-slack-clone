import { parseExtSpaceUri, parseSpaceUri } from "@flock/protocol/keys";
import { SPACE_TYPE } from "@flock/protocol/nsids";
import type { SyncStore } from "./store";

// When held copies stop being served: the lifecycle rules that lived in the server's cache, applied to the client's store.

export class Lifecycle {
  constructor(private readonly store: SyncStore, private readonly now: () => number) {}

  /** Access to a space lost, or the space deleted: it goes, and a workspace takes every space that belongs to it. */
  async dropSpace(space: string): Promise<void> {
    const dependents = parseSpaceUri(space)?.type === SPACE_TYPE.workspace
      ? (await this.store.listSpaces()).filter((state) => state.workspace === space).map((state) => state.space)
      : [];
    for (const target of [space, ...dependents]) await this.store.purgeSpace(target);
  }

  /** After a full discovery: workspaces the account no longer lists go, with their channels and inboxes. */
  async keepWorkspaces(listed: readonly string[]): Promise<void> {
    const keep = new Set(listed);
    for (const state of await this.store.listSpaces()) {
      const isWorkspace = parseSpaceUri(state.space)?.type === SPACE_TYPE.workspace;
      if ((isWorkspace && !keep.has(state.space)) || (state.workspace !== null && !keep.has(state.workspace))) await this.store.purgeSpace(state.space);
    }
  }

  /** After a directory read: a workspace's channels that are archived or gone from the directory go. */
  async keepChannels(workspace: string, current: readonly string[]): Promise<void> {
    await this.keepWorkspaceSpaces(workspace, { channels: current });
  }

  /**
   * After reading a workspace's directory and extension installs: keeps its active channels and active extension spaces,
   * and purges archived/removed channels and disabled extension spaces. Passing a string array keeps only those channels
   * and extension spaces; passing an object updates only the subsets whose scans were complete.
   */
  async keepWorkspaceSpaces(
    workspace: string,
    current: readonly string[] | { channels?: readonly string[]; extensions?: readonly string[] },
  ): Promise<void> {
    const spaces = isStringList(current) ? { channels: current, extensions: current } : current;
    const keepChannels = spaces.channels ? new Set(spaces.channels) : undefined;
    const keepExtensions = spaces.extensions ? new Set(spaces.extensions) : undefined;
    for (const state of await this.store.listSpaces()) {
      if (state.workspace !== workspace) continue;
      const parsed = parseSpaceUri(state.space);
      if (!parsed) continue;
      if (parsed.type === SPACE_TYPE.channel && keepChannels && !keepChannels.has(state.space)) {
        await this.store.purgeSpace(state.space);
      } else if (parseExtSpaceUri(state.space) && keepExtensions && !keepExtensions.has(state.space)) {
        await this.store.purgeSpace(state.space);
      }
    }
  }

  /** At start-up: spaces not opened for the retention period go, so what accounts never return to read is bounded. */
  async sweep(retentionMs: number): Promise<void> {
    const cutoff = this.now() - retentionMs;
    for (const state of await this.store.listSpaces()) if (state.lastOpenedAt < cutoff) await this.store.purgeSpace(state.space);
  }

}

function isStringList(
  value: readonly string[] | { channels?: readonly string[]; extensions?: readonly string[] },
): value is readonly string[] {
  return Array.isArray(value);
}
