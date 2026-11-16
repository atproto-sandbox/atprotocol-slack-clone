import { BLOCK_TYPE, type ButtonElement, type MessageBlock } from "@flock/client/blocks";
import type { AppDeclaration } from "@flock/client/workspace-client";
import { isCommandName } from "@flock/protocol/registry";
import type { WorkspaceSummary } from "@flock/protocol/workspace-summary";
import type { ChannelSelection } from "./client-api";
import type { ChannelContent } from "./use-channel-content";

export type AppDeclarationEntry =
  | { status: "loading" }
  | { status: "loaded"; declaration: AppDeclaration | null };

export type WorkspaceDeclarations = Readonly<Record<string, AppDeclarationEntry>>;

export type OfferedCommand = {
  appDid: string;
  appName: string;
  name: string;
  description?: string;
  usage?: string;
};

export type ChannelCommandContext = {
  canOffer: boolean;
  loading: boolean;
  offered: OfferedCommand[];
};

export type ComposerResolution =
  | { kind: "empty" }
  | { kind: "message"; text: string }
  | { kind: "blocked"; reason: string }
  | { kind: "held"; reason: string }
  | { kind: "unknown"; name: string; reason: string }
  | { kind: "ambiguous"; name: string; candidates: OfferedCommand[]; reason: string }
  | { kind: "command"; appDid: string; appName: string; command: string; text: string };

/**
 * Loads and caches app declarations once per `(workspaceUri, appDid)`, shared by the Apps panel and the channel composer. An
 * app whose host cannot be reached resolves to `null` so loading finishes and its commands are simply not offered.
 */
export class WorkspaceDeclarationCache {
  private readonly entries = new Map<string, Map<string, AppDeclarationEntry>>();
  private readonly inflight = new Map<string, Promise<AppDeclaration | null>>();

  ensureWorkspace(
    workspaceUri: string,
    installDids: readonly string[],
    fetchDeclaration: (did: string) => Promise<AppDeclaration | null>,
    onChange?: () => void,
  ): void {
    for (const did of installDids) {
      if (this.entries.get(workspaceUri)?.has(did)) continue;
      void this.load(workspaceUri, did, fetchDeclaration, onChange);
    }
  }

  load(
    workspaceUri: string,
    did: string,
    fetchDeclaration: (did: string) => Promise<AppDeclaration | null>,
    onChange?: () => void,
  ): Promise<AppDeclaration | null> {
    const existing = this.entries.get(workspaceUri)?.get(did);
    if (existing?.status === "loaded") return Promise.resolve(existing.declaration);
    const key = `${workspaceUri} ${did}`;
    const pending = this.inflight.get(key);
    if (pending) return pending;

    this.setEntry(workspaceUri, did, { status: "loading" });
    onChange?.();

    const request = fetchDeclaration(did)
      .catch(() => null)
      .then((declaration) => {
        this.inflight.delete(key);
        this.setEntry(workspaceUri, did, { status: "loaded", declaration });
        onChange?.();
        return declaration;
      });
    this.inflight.set(key, request);
    return request;
  }

  forWorkspace(workspaceUri: string, installDids: readonly string[]): WorkspaceDeclarations {
    const map = this.entries.get(workspaceUri);
    const snapshot: Record<string, AppDeclarationEntry> = {};
    for (const did of installDids) {
      snapshot[did] = map?.get(did) ?? { status: "loading" };
    }
    return snapshot;
  }

  private setEntry(workspaceUri: string, did: string, entry: AppDeclarationEntry): void {
    let map = this.entries.get(workspaceUri);
    if (!map) {
      map = new Map();
      this.entries.set(workspaceUri, map);
    }
    map.set(did, entry);
  }
}

/**
 * Which slash commands are offered in the open channel composer: only for active installs granted this channel, never where
 * the viewer cannot read the channel or while it transitions, and in a thread only on a top-level message.
 */
export function channelCommandContext(input: {
  workspace: WorkspaceSummary | null;
  channel: ChannelSelection | null;
  viewerDid: string;
  content: ChannelContent | undefined;
  replyTo: string;
  declarations: WorkspaceDeclarations;
}): ChannelCommandContext {
  const { workspace, channel, viewerDid, content, replyTo, declarations } = input;
  if (!workspace || !channel) return { canOffer: false, loading: false, offered: [] };
  if (channel.visibility !== "public" && channel.visibility !== "private") {
    return { canOffer: false, loading: false, offered: [] };
  }
  if (content?.refused) return { canOffer: false, loading: false, offered: [] };
  if (
    channel.visibility === "private" &&
    viewerDid !== workspace.authorityDid &&
    !(content?.roster?.includes(viewerDid) ?? false)
  ) {
    return { canOffer: false, loading: false, offered: [] };
  }
  if (replyTo !== "") {
    const target = (content?.messages ?? []).find((message) => message.uri === replyTo);
    if (!target || target.value.parent !== undefined) {
      return { canOffer: false, loading: false, offered: [] };
    }
  }

  const channelInstalls = workspace.installs.filter((install) =>
    install.channels.some((grant) => grant.skey === channel.skey),
  );
  if (channelInstalls.length === 0) return { canOffer: true, loading: false, offered: [] };

  const loading = channelInstalls.some((install) => (declarations[install.did]?.status ?? "loading") === "loading");
  const offered = channelInstalls.flatMap((install) => {
    const entry = declarations[install.did];
    if (!entry || entry.status !== "loaded" || !entry.declaration?.commands) return [];
    const appName = entry.declaration.name;
    return entry.declaration.commands.map((command): OfferedCommand => ({
      appDid: install.did,
      appName,
      name: command.name,
      ...(command.description === undefined ? {} : { description: command.description }),
      ...(command.usage === undefined ? {} : { usage: command.usage }),
    }));
  });
  return { canOffer: true, loading, offered };
}

/** Commands matching the `/` token currently typed in the composer, for the picker. */
export function matchingCommands(rawText: string, context: ChannelCommandContext): OfferedCommand[] {
  if (!context.canOffer || !rawText.startsWith("/") || rawText.startsWith("//")) return [];
  const prefix = (rawText.slice(1).split(/\s+/)[0] ?? "").toLowerCase();
  return context.offered.filter((command) => command.name.startsWith(prefix));
}

/**
 * Decides what submitting the composer does:
 * - `//...` sends a channel message with one leading `/` kept;
 * - text not starting with `/` sends a channel message;
 * - `/...` is always treated as a command: blocked where commands cannot run, held while channel app declarations load,
 *   rejected when no offered app declares it, disambiguated via picker when two apps declare it, or sent to the app's inbox.
 */
export function resolveComposerSubmission(
  rawText: string,
  context: ChannelCommandContext & { chosenAppDid?: string | null },
): ComposerResolution {
  if (rawText.startsWith("//")) {
    const stripped = rawText.slice(1);
    return stripped.trim().length === 0 ? { kind: "empty" } : { kind: "message", text: stripped };
  }
  if (!rawText.startsWith("/")) {
    return rawText.trim().length === 0 ? { kind: "empty" } : { kind: "message", text: rawText };
  }
  if (!context.canOffer) {
    return {
      kind: "blocked",
      reason: "Slash commands are only available in channels you can read, and in threads only on a top-level message.",
    };
  }
  if (context.loading) {
    return {
      kind: "held",
      reason: "App commands for this channel are still loading. Wait a moment and send again.",
    };
  }
  const token = rawText.slice(1).split(/\s+/)[0] ?? "";
  const args = rawText.slice(1 + token.length).trim();
  if (!isCommandName(token)) {
    return {
      kind: "unknown",
      name: token,
      reason: token ? `No app in this channel offers /${token}.` : "Type a command name after /, or start with // to send a message.",
    };
  }
  const matches = context.offered.filter((command) => command.name === token);
  if (matches.length === 0) {
    return { kind: "unknown", name: token, reason: `No app in this channel offers /${token}.` };
  }
  if (matches.length === 1) {
    const match = matches[0]!;
    return { kind: "command", appDid: match.appDid, appName: match.appName, command: token, text: args };
  }
  const chosen = context.chosenAppDid ? matches.find((entry) => entry.appDid === context.chosenAppDid) : undefined;
  if (chosen) {
    return { kind: "command", appDid: chosen.appDid, appName: chosen.appName, command: token, text: args };
  }
  return {
    kind: "ambiguous",
    name: token,
    candidates: matches,
    reason: `Multiple apps offer /${token}. Choose an app below before sending.`,
  };
}

/**
 * Blocks to render for `message`, or `null` when its fallback `text` should be rendered instead. A person's message (or an
 * uninstalled app's) never renders blocks, whatever `blocks` its record carries.
 */
export function renderableBlocks(
  message: { repo: string; value: { text?: string; blocks?: unknown } },
  activeAppDids: ReadonlySet<string>,
): MessageBlock[] | null {
  if (!activeAppDids.has(message.repo)) return null;
  if (!Array.isArray(message.value.blocks) || message.value.blocks.length === 0) return null;
  const blocks: MessageBlock[] = [];
  for (const raw of message.value.blocks) {
    if (!isPlainObject(raw)) continue;
    if (raw.$type === BLOCK_TYPE.section && typeof raw.text === "string" && raw.text.length > 0) {
      blocks.push({ $type: BLOCK_TYPE.section, text: raw.text });
    } else if (
      raw.$type === BLOCK_TYPE.context &&
      Array.isArray(raw.elements) &&
      raw.elements.length > 0 &&
      raw.elements.every((item) => typeof item === "string")
    ) {
      blocks.push({ $type: BLOCK_TYPE.context, elements: [...(raw.elements as string[])] });
    } else if (raw.$type === BLOCK_TYPE.divider) {
      blocks.push({ $type: BLOCK_TYPE.divider });
    } else if (raw.$type === BLOCK_TYPE.actions && Array.isArray(raw.elements)) {
      const elements: ButtonElement[] = [];
      for (const item of raw.elements) {
        if (!isPlainObject(item)) continue;
        if (item.$type !== undefined && item.$type !== BLOCK_TYPE.button) continue;
        if (typeof item.actionId === "string" && typeof item.label === "string") {
          elements.push({
            ...(item.$type === BLOCK_TYPE.button ? { $type: BLOCK_TYPE.button } : {}),
            actionId: item.actionId,
            label: item.label,
            ...(typeof item.value === "string" ? { value: item.value } : {}),
            ...(item.style === "primary" || item.style === "danger" ? { style: item.style } : {}),
          });
        }
      }
      if (elements.length > 0) blocks.push({ $type: BLOCK_TYPE.actions, elements });
    }
  }
  return blocks.length > 0 ? blocks : null;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
