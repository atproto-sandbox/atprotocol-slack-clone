import { AppInboxClient } from "./app-inbox-client";
import { ChannelClient } from "./channel-client";
import { CredentialCache } from "./credentials";
import { withIdentityCache } from "./identity";
import { Lifecycle } from "./lifecycle";
import { MemoryStore } from "./memory-store";
import { OperatorClient, type OperatorService } from "./operator-client";
import type { SyncStore } from "./store";
import { SyncCore, type SyncOptions } from "./sync";
import { transportNow, type ClientTransport } from "./transport";
import { WorkspaceClient } from "./workspace-client";

export type Engine = {
  credentials: CredentialCache;
  sync: SyncCore;
  lifecycle: Lifecycle;
  channels: ChannelClient;
  workspaces: WorkspaceClient;
  appInboxes: AppInboxClient;
  operator?: OperatorClient;
};

/**
 * The engine for one account's workspace, inbox and channel spaces: one credential cache and one store under every client, so
 * a refused credential drops the space for all of them. `DmClient` keeps its own cache over a memory store (D10). Start-up
 * (`lifecycle.sweep`, `IndexedDbStore.deleteOtherAccounts`) and sign-out (`signOutAccount` in src/browser/sign-out.ts, which
 * deletes the account's store) are the host app's to call. `applyOwnWrites` is on by default for people's sessions and turned
 * off by app runtimes so posting-only apps keep nothing they send in memory.
 */
export function createEngine(
  host: ClientTransport,
  input: { store?: SyncStore; options?: Partial<SyncOptions>; operator?: OperatorService; applyOwnWrites?: boolean } = {},
): Engine {
  const store = input.store ?? new MemoryStore();
  const transport = withIdentityCache(host, store);
  const lifecycle = new Lifecycle(store, () => transportNow(transport));
  const credentials = new CredentialCache(transport, (space) => lifecycle.dropSpace(space));
  const sync = new SyncCore({ transport, credentials, store, options: input.options });
  return {
    credentials,
    sync,
    lifecycle,
    channels: new ChannelClient({ transport, credentials, sync, lifecycle, applyOwnWrites: input.applyOwnWrites }),
    workspaces: new WorkspaceClient({ transport, credentials, lifecycle }),
    appInboxes: new AppInboxClient({ transport, sync }),
    ...(input.operator ? { operator: new OperatorClient(transport, input.operator) } : {}),
  };
}
