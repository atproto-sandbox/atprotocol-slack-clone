import { parseSpaceUri } from "@/protocol/keys";
import { SPACE_TYPE } from "@/protocol/nsids";
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
    const keep = new Set(current);
    for (const state of await this.store.listSpaces()) {
      if (state.workspace === workspace && parseSpaceUri(state.space)?.type === SPACE_TYPE.channel && !keep.has(state.space)) {
        await this.store.purgeSpace(state.space);
      }
    }
  }

  /** At start-up: spaces not opened for the retention period go, so what accounts never return to read is bounded. */
  async sweep(retentionMs: number): Promise<void> {
    const cutoff = this.now() - retentionMs;
    for (const state of await this.store.listSpaces()) if (state.lastOpenedAt < cutoff) await this.store.purgeSpace(state.space);
  }

  /** Sign-out: the account's store goes. */
  async signOut(): Promise<void> {
    await this.store.clear();
  }
}
