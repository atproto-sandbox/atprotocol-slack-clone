import assert from "node:assert/strict";
import { World, type IWorldOptions } from "@cucumber/cucumber";
import Database from "better-sqlite3";
import type { Browser, BrowserContext, Page, Response as PlaywrightResponse } from "@playwright/test";
import type { AppFixture, FixtureAccount } from "../../protocol-tests/support/app-fixture";

/**
 * `body` says what `responseBody` holds: "recorded" is the response text. "streamed" (text/event-stream) and "navigated-away" (the
 * page left before the browser would hand over the body, as it does right after an OAuth permission reply) are recorded headers-only
 * with an empty `responseBody`, which says nothing about what they carried. Leak scans must report such calls as not covered.
 */
export type ApiCall = {
  method: string; path: string; query: string; status: number; requestBody: string; responseBody: string;
  body: "recorded" | "streamed" | "navigated-away";
};
export type Actor = FixtureAccount & { role: string; context: BrowserContext; page: Page; calls: ApiCall[] };

let sequence = 0;
const VIDEO_SIZE = { width: 1280, height: 720 };

/** One scenario: its own accounts and browser contexts on the shared fixture, driven through the real UI. */
export class AppWorld extends World {
  fixture!: AppFixture;
  browser!: Browser;
  readonly actors = new Map<string, Actor>();
  workspaceName = "";
  workspaceUri = "";
  inviteLink = "";
  scratch = new Map<string, unknown>();
  startedAt = Date.now();
  readonly contexts: BrowserContext[] = [];
  /** Pages in creation order with the label of the session they belong to, for the optional session recording. */
  readonly clips: Array<{ page: Page; label: string; startedAt: number }> = [];
  private readonly recordings = new Set<Promise<void>>();
  private readonly unreadableBodies: string[] = [];
  private closed = false;

  constructor(options: IWorldOptions) {
    super(options);
  }

  get appOrigin(): string {
    return this.fixture.appUrl.origin;
  }

  /** The actor for a role, created on first use with a fresh account and its own browser context. */
  async actor(role: string, host: 0 | 1 = 0): Promise<Actor> {
    const existing = this.actors.get(role);
    if (existing) return existing;
    sequence += 1;
    const suffix = `${Date.now().toString(36).slice(-4)}${sequence.toString(36)}`;
    const account = await this.fixture.createAccount(`${role.slice(0, 8)}${suffix}.${host === 0 ? "test" : "test2"}`, host);
    const context = await this.newContext(role);
    await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: this.appOrigin });
    const page = await context.newPage();
    page.setDefaultTimeout(30_000);
    const actor: Actor = { ...account, role, context, page, calls: [] };
    this.recordCalls(actor);
    this.actors.set(role, actor);
    return actor;
  }

  /** A browser context for one session of this scenario. With BDD_VIDEO_DIR set, every page in it is recorded to a video. */
  async newContext(label: string): Promise<BrowserContext> {
    const videoDir = process.env.BDD_VIDEO_DIR;
    const context = await this.browser.newContext(videoDir ? { viewport: VIDEO_SIZE, recordVideo: { dir: videoDir, size: VIDEO_SIZE } } : {});
    this.contexts.push(context);
    if (videoDir) context.on("page", (page) => this.clips.push({ page, label, startedAt: Date.now() }));
    return context;
  }

  /**
   * Records every /api call the actor's page makes into `actor.calls`, in the order their bodies finish. The one recorder
   * for every browser session of a scenario, including sessions on a second app. A body that cannot be read fails the
   * scenario when it ends, except where `ApiCall.body` says the call is recorded headers-only (and a redirect has no body).
   */
  recordCalls(actor: Actor): void {
    actor.page.on("response", (response) => {
      const recording: Promise<void> = this.record(actor, response).catch((error: unknown) => {
        if (!this.closed) this.unreadableBodies.push(`${response.request().method()} ${response.url()}: ${error instanceof Error ? error.message : String(error)}`);
      }).finally(() => this.recordings.delete(recording));
      this.recordings.add(recording);
    });
  }

  private async record(actor: Actor, response: PlaywrightResponse): Promise<void> {
    const url = new URL(response.url());
    if (!url.pathname.startsWith("/api/")) return;
    const request = response.request();
    const status = response.status();
    const call: ApiCall = {
      method: request.method(), path: url.pathname, query: url.search, status, requestBody: request.postData() ?? "", responseBody: "",
      body: (response.headers()["content-type"] ?? "").startsWith("text/event-stream") ? "streamed" : "recorded",
    };
    if (call.body === "recorded" && !(status >= 300 && status < 400)) {
      try {
        call.responseBody = await response.text();
      } catch (error) {
        if (!/navigated away/.test(String(error))) throw error;
        call.body = "navigated-away";
      }
    }
    actor.calls.push(call);
  }

  callsTo(actor: Actor, path: string): ApiCall[] {
    return actor.calls.filter((call) => call.path === path);
  }

  /** Read-only view of the app's own database, for facts only the app records (operation journal, audit trail). */
  withAppDatabase<T>(read: (db: Database.Database) => T): T {
    const db = new Database(this.fixture.databasePath, { readonly: true, fileMustExist: true });
    try { return read(db); } finally { db.close(); }
  }

  /** An authenticated read straight from an account's PDS, independent of the app. */
  async pdsGet<T = Record<string, unknown>>(as: FixtureAccount, nsid: string, params: Record<string, string>): Promise<{ status: number; body: T }> {
    const url = new URL(`/xrpc/${nsid}`, as.pdsUrl);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    const response = await fetch(url, { headers: { authorization: `Bearer ${as.accessJwt}` } });
    const text = await response.text();
    return { status: response.status, body: (text ? JSON.parse(text) : {}) as T };
  }

  async pdsPost(as: FixtureAccount, nsid: string, input: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
    const response = await fetch(new URL(`/xrpc/${nsid}`, as.pdsUrl), {
      method: "POST", headers: { authorization: `Bearer ${as.accessJwt}`, "content-type": "application/json" }, body: JSON.stringify(input),
    });
    const text = await response.text();
    return { status: response.status, body: (text ? JSON.parse(text) : {}) as Record<string, unknown> };
  }

  /** Closes every browser context. Throws afterwards if the recorder could not read a response body it was meant to keep. */
  async closeActors(): Promise<void> {
    await Promise.race([Promise.all([...this.recordings]), new Promise((resolve) => setTimeout(resolve, 10_000).unref())]);
    this.closed = true;
    for (const context of this.contexts) await context.close().catch(() => undefined);
    this.contexts.length = 0;
    this.actors.clear();
    assert.deepEqual(this.unreadableBodies, [], "the recorder could not read these response bodies, so no assertion could have seen them");
  }
}
