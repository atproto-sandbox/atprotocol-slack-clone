import { channelUri, isDid, isSkey, isTid, spaceRecordUri, tasksSpaceUri, workspaceUri } from "@flock/protocol/keys";
import { COLLECTION } from "@flock/protocol/nsids";

export { captureReturnTo, consumeReturnTo, RETURN_TO_KEY, sanitizeReturnTo, validateReturnTo } from "../../lib/return-to";

export type TasksRouteView = "default" | "list" | "board" | "project" | "task" | "activity";

export type AppRoute =
  | { kind: "home" }
  | { kind: "workspace"; authority: string; workspaceSkey: string; workspaceUri: string }
  | { kind: "channel"; authority: string; workspaceSkey: string; workspaceUri: string; channelSkey: string; thread?: string }
  | {
      kind: "message";
      authority: string;
      workspaceSkey: string;
      workspaceUri: string;
      channelSkey: string;
      repo: string;
      rkey: string;
      messageUri: string;
    }
  | {
      kind: "tasks";
      view: "default" | "list" | "board" | "activity";
      authority: string;
      workspaceSkey: string;
      workspaceUri: string;
    }
  | {
      kind: "tasks";
      view: "project";
      authority: string;
      workspaceSkey: string;
      workspaceUri: string;
      repo: string;
      rkey: string;
      projectUri: string;
      layout?: "list" | "board";
    }
  | {
      kind: "tasks";
      view: "task";
      authority: string;
      workspaceSkey: string;
      workspaceUri: string;
      repo: string;
      rkey: string;
      taskUri: string;
    }
  | { kind: "dm"; view: "home" | "requests" | "settings" }
  | { kind: "dm"; view: "conversation"; convKey: string };

const RKEY_PATTERN = /^[A-Za-z0-9._~:-]{1,512}$/;

function isRecordKey(value: string): boolean {
  return RKEY_PATTERN.test(value) && value !== "." && value !== "..";
}

function enc(segment: string): string {
  return encodeURIComponent(segment);
}

export function homeRoute(): string {
  return "/";
}

export function workspaceRoute(authority: string, workspaceSkey: string): string {
  return `/w/${enc(authority)}/${enc(workspaceSkey)}`;
}

export function channelRoute(input: {
  authority: string;
  workspaceSkey: string;
  channelSkey: string;
  thread?: string;
}): string {
  const base = `${workspaceRoute(input.authority, input.workspaceSkey)}/c/${enc(input.channelSkey)}`;
  if (!input.thread) return base;
  return `${base}?thread=${encodeURIComponent(input.thread)}`;
}

export function messageRoute(input: {
  authority: string;
  workspaceSkey: string;
  channelSkey: string;
  repo: string;
  rkey: string;
}): string {
  return `${workspaceRoute(input.authority, input.workspaceSkey)}/c/${enc(input.channelSkey)}/m/${enc(input.repo)}/${enc(input.rkey)}`;
}

export function tasksRoute(
  authority: string,
  workspaceSkey: string,
  subView?: "list" | "board" | "activity",
): string {
  const base = `${workspaceRoute(authority, workspaceSkey)}/ext/tasks`;
  return subView ? `${base}/${subView}` : base;
}

export function tasksProjectRoute(input: {
  authority: string;
  workspaceSkey: string;
  repo: string;
  rkey: string;
  layout?: "list" | "board";
}): string {
  const base = `${tasksRoute(input.authority, input.workspaceSkey)}/p/${enc(input.repo)}/${enc(input.rkey)}`;
  return input.layout ? `${base}?view=${input.layout}` : base;
}

export function tasksTaskRoute(input: {
  authority: string;
  workspaceSkey: string;
  repo: string;
  rkey: string;
}): string {
  return `${tasksRoute(input.authority, input.workspaceSkey)}/t/${enc(input.repo)}/${enc(input.rkey)}`;
}

export function dmHomeRoute(view: "home" | "requests" | "settings" = "home"): string {
  if (view === "requests" || view === "settings") return `/dm?view=${view}`;
  return "/dm";
}

export function dmConversationRoute(convKey: string): string {
  return `/dm/${enc(convKey)}`;
}

/**
 * Decodes raw URL pathname segments ONCE (so `%253A` in `did%3Aweb%3Alocalhost%253A3000` yields
 * `did:web:localhost%3A3000` without double-decoding) and validates against the route grammar.
 */
export function parseRoute(pathname: string, search = ""): AppRoute | null {
  if (!pathname.startsWith("/") || pathname.includes("//") || pathname.includes("\\")) return null;
  if (pathname === "/") return { kind: "home" };
  const trimmed = pathname.length > 1 && pathname.endsWith("/") ? pathname.slice(0, -1) : pathname;
  const rawSegments = trimmed.slice(1).split("/");
  const decoded: string[] = [];
  for (const segment of rawSegments) {
    if (!segment) return null;
    try {
      decoded.push(decodeURIComponent(segment));
    } catch {
      return null;
    }
  }
  return parseDecodedSegments(decoded, search);
}

/** Validates already-decoded segments (e.g. from Next `params` which App Router decoded once) without re-decoding. */
export function parseDecodedSegments(segments: readonly string[], search = ""): AppRoute | null {
  if (segments.length === 0) return { kind: "home" };

  if (segments[0] === "dm") {
    if (segments.length === 1) {
      const viewParam = new URLSearchParams(search).get("view");
      const view = viewParam === "requests" || viewParam === "settings" ? viewParam : "home";
      return { kind: "dm", view };
    }
    if (segments.length === 2) {
      const convKey = segments[1]!;
      return isTid(convKey) ? { kind: "dm", view: "conversation", convKey } : null;
    }
    return null;
  }

  if (segments[0] !== "w" || segments.length < 3) return null;
  const authority = segments[1]!;
  const workspaceSkey = segments[2]!;
  if (!isDid(authority) || !isSkey(workspaceSkey)) return null;
  const wsUri = workspaceUri(authority, workspaceSkey);

  if (segments.length === 3) {
    return { kind: "workspace", authority, workspaceSkey, workspaceUri: wsUri };
  }

  if (segments[3] === "c") {
    if (segments.length < 5) return null;
    const channelSkey = segments[4]!;
    if (!isSkey(channelSkey)) return null;
    if (segments.length === 5) {
      const rawThread = new URLSearchParams(search).get("thread");
      const thread = rawThread && rawThread.trim().length > 0 ? rawThread : undefined;
      return { kind: "channel", authority, workspaceSkey, workspaceUri: wsUri, channelSkey, ...(thread ? { thread } : {}) };
    }
    if (segments.length === 8 && segments[5] === "m") {
      const repo = segments[6]!;
      const rkey = segments[7]!;
      if (!isDid(repo) || !isRecordKey(rkey)) return null;
      return {
        kind: "message",
        authority,
        workspaceSkey,
        workspaceUri: wsUri,
        channelSkey,
        repo,
        rkey,
        messageUri: spaceRecordUri(channelUri(authority, channelSkey), repo, COLLECTION.message, rkey),
      };
    }
    return null;
  }

  if (segments[3] === "ext" && segments[4] === "tasks") {
    if (segments.length === 5) {
      return { kind: "tasks", view: "default", authority, workspaceSkey, workspaceUri: wsUri };
    }
    const sub = segments[5]!;
    if (segments.length === 6 && (sub === "list" || sub === "board" || sub === "activity")) {
      return { kind: "tasks", view: sub, authority, workspaceSkey, workspaceUri: wsUri };
    }
    if (segments.length === 8 && (sub === "p" || sub === "t")) {
      const repo = segments[6]!;
      const rkey = segments[7]!;
      if (!isDid(repo) || !isRecordKey(rkey)) return null;
      const tasksSpace = tasksSpaceUri(authority, workspaceSkey);
      if (sub === "p") {
        const layoutParam = new URLSearchParams(search).get("view");
        const layout = layoutParam === "list" || layoutParam === "board" ? layoutParam : undefined;
        return {
          kind: "tasks",
          view: "project",
          authority,
          workspaceSkey,
          workspaceUri: wsUri,
          repo,
          rkey,
          projectUri: spaceRecordUri(tasksSpace, repo, COLLECTION.taskProject, rkey),
          ...(layout ? { layout } : {}),
        };
      }
      return {
        kind: "tasks",
        view: "task",
        authority,
        workspaceSkey,
        workspaceUri: wsUri,
        repo,
        rkey,
        taskUri: spaceRecordUri(tasksSpace, repo, COLLECTION.task, rkey),
      };
    }
    return null;
  }

  return null;
}

/**
 * Returns the canonical channel URL when clearing a sent message's `?thread=` parameter,
 * or `null` when the browser has already left that channel or had no `?thread=` query active.
 */
export function sentThreadCleanupRoute(
  liveRoute: AppRoute | null,
  sent: { authority: string; workspaceSkey: string; workspaceUri: string; channelSkey: string },
): string | null {
  if (
    liveRoute?.kind !== "channel" ||
    !liveRoute.thread ||
    liveRoute.workspaceUri !== sent.workspaceUri ||
    liveRoute.channelSkey !== sent.channelSkey
  ) {
    return null;
  }
  return channelRoute({
    authority: sent.authority,
    workspaceSkey: sent.workspaceSkey,
    channelSkey: sent.channelSkey,
  });
}
