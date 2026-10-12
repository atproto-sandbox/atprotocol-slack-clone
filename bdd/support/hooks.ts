import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { After, AfterAll, BeforeAll, Before, Status, setDefaultTimeout, setWorldConstructor, type ITestCaseHookParameter } from "@cucumber/cucumber";
import { chromium, type Browser } from "@playwright/test";
import { startAppFixture, type AppFixture } from "../../protocol-tests/support/app-fixture";
import { AppWorld } from "./world";

setWorldConstructor(AppWorld);
setDefaultTimeout(180_000);

let fixture: AppFixture | undefined;
let browser: Browser | undefined;

BeforeAll({ timeout: 180_000 }, async () => {
  fixture = await startAppFixture();
  // BDD_HEADED=1 opens a visible window; BDD_BROWSER_CHANNEL=chrome drives the installed Google Chrome instead of bundled Chromium.
  browser = await chromium.launch({ headless: process.env.BDD_HEADED !== "1", channel: process.env.BDD_BROWSER_CHANNEL || undefined });
});

AfterAll({ timeout: 60_000 }, async () => {
  try {
    await browser?.close();
  } finally {
    await fixture?.stop();
  }
});

Before(function (this: AppWorld) {
  this.startedAt = Date.now();
  if (!fixture || !browser) throw new Error("The app fixture did not start.");
  this.fixture = fixture;
  this.browser = browser;
});

After(async function (this: AppWorld, scenario) {
  if (scenario.result?.status === Status.FAILED) {
    for (const actor of this.actors.values()) {
      this.attach(await actor.page.screenshot({ fullPage: true }).catch(() => Buffer.from("")), "image/png");
      this.attach(`[${actor.role}] ${actor.page.url()}\n${(await actor.page.locator("body").innerText().catch(() => "")).slice(0, 4_000)}`, "text/plain");
    }
    this.attach(`App server output (tail):\n${this.fixture.serverOutput().slice(-4_000)}`, "text/plain");
  }
  try {
    await this.closeActors();
  } finally {
    await saveSessionClips(this, scenario);
  }
});

let recordedScenarios = 0;

/** With BDD_VIDEO_DIR set: names each recorded page after its scenario and lists them in manifest.jsonl for scripts/render-bdd-video.ts. */
async function saveSessionClips(world: AppWorld, scenario: ITestCaseHookParameter): Promise<void> {
  const directory = process.env.BDD_VIDEO_DIR;
  if (!directory) return;
  mkdirSync(directory, { recursive: true });
  recordedScenarios += 1;
  const index = String(recordedScenarios).padStart(3, "0");
  const clips: Array<{ file: string; label: string; offsetMs: number }> = [];
  for (const [position, clip] of world.clips.entries()) {
    const video = clip.page.video();
    if (!video) continue;
    const file = `${index}-${position + 1}.webm`;
    await video.saveAs(join(directory, file));
    await video.delete();
    clips.push({ file, label: clip.label, offsetMs: clip.startedAt - world.startedAt });
  }
  appendFileSync(join(directory, "manifest.jsonl"), `${JSON.stringify({
    index: recordedScenarios, feature: scenario.gherkinDocument.feature?.name ?? "", name: scenario.pickle.name,
    status: scenario.result?.status ?? "UNKNOWN", clips,
  })}\n`);
}
