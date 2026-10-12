import { execFile } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { chromium } from "@playwright/test";

// Turns the per-session recordings of a BDD run (BDD_VIDEO_DIR, see bdd/support/hooks.ts) into one mp4: for each
// scenario a title card followed by its browser sessions side by side, aligned on the moment each session opened,
// with a chapter and a subtitle line per scenario. Usage: node --import tsx scripts/render-bdd-video.ts <video-dir>

const run = promisify(execFile);
const FPS = 25;
const CARD_SECONDS = 2.5;
const MAX_TILES = 4;

type Clip = { file: string; label: string; offsetMs: number };
type Entry = { index: number; feature: string; name: string; status: string; clips: Clip[] };

const escapeHtml = (value: string): string => value.replace(/[&<>"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[character]!);

function readManifest(directory: string): Entry[] {
  const path = join(directory, "manifest.jsonl");
  if (!existsSync(path)) throw new Error(`No manifest.jsonl in ${directory}; run the suite with BDD_VIDEO_DIR set.`);
  return readFileSync(path, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as Entry);
}

async function titleCards(directory: string, entries: Entry[]): Promise<void> {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
    for (const entry of entries) {
      const passed = entry.status === "PASSED";
      const legend = `${entry.clips.length > 1 ? "left to right, top to bottom: " : ""}${entry.clips.slice(0, MAX_TILES).map((clip) => clip.label).join("  ·  ")}`;
      await page.setContent(`<body style="margin:0;height:1080px;display:flex;flex-direction:column;justify-content:center;padding:0 160px;background:#14121c;color:#f4f2fa;font-family:-apple-system,Helvetica,sans-serif">
        <div style="font-size:34px;letter-spacing:.12em;color:#a79fc2;text-transform:uppercase">${escapeHtml(entry.feature)} · scenario ${entry.index}</div>
        <div style="font-size:78px;font-weight:700;line-height:1.15;margin:28px 0">${escapeHtml(entry.name)}</div>
        <div style="font-size:36px;color:${passed ? "#7be0a4" : "#ff8a8a"}">${passed ? "PASSED" : escapeHtml(entry.status)}</div>
        <div style="font-size:30px;color:#a79fc2;margin-top:48px">${escapeHtml(legend)}</div></body>`);
      await page.screenshot({ path: join(directory, `card-${String(entry.index).padStart(3, "0")}.png`) });
    }
  } finally {
    await browser.close();
  }
}

/** The ffmpeg filter graph for one scenario: the title card, then its sessions tiled and aligned in time. */
function segmentArguments(directory: string, entry: Entry, output: string): string[] {
  const clips = entry.clips.slice(0, MAX_TILES);
  const tile = clips.length === 1 ? { width: 1920, height: 1080 } : { width: 960, height: 540 };
  const filters = [`[0:v]scale=1920:1080,fps=${FPS},format=yuv420p,setsar=1[card]`];
  clips.forEach((clip, position) => {
    const delay = Math.max(0, clip.offsetMs) / 1000;
    filters.push(`[${position + 1}:v]fps=${FPS},scale=${tile.width}:${tile.height}:force_original_aspect_ratio=decrease,pad=${tile.width}:${tile.height}:(ow-iw)/2:(oh-ih)/2,`
      + `tpad=start_duration=${delay.toFixed(3)}:color=black,setsar=1,format=yuv420p[tile${position}]`);
  });
  if (clips.length === 1) filters.push("[tile0]null[scene]");
  else {
    const layout = ["0_0", "w0_0", "0_h0", "w0_h0"].slice(0, clips.length).join("|");
    const inputs = clips.map((_, position) => `[tile${position}]`).join("");
    filters.push(`${inputs}xstack=inputs=${clips.length}:layout=${layout}:fill=black[stacked]`);
    filters.push(`[stacked]pad=1920:1080:0:${clips.length === 2 ? 270 : 0}:black[scene]`);
  }
  filters.push("[card][scene]concat=n=2:v=1:a=0[out]");
  return [
    "-y", "-hide_banner", "-loglevel", "error",
    "-loop", "1", "-framerate", String(FPS), "-t", String(CARD_SECONDS), "-i", join(directory, `card-${String(entry.index).padStart(3, "0")}.png`),
    ...clips.flatMap((clip) => ["-i", join(directory, clip.file)]),
    "-filter_complex", filters.join(";"),
    "-map", "[out]", "-c:v", "libx264", "-preset", "veryfast", "-crf", "24", "-pix_fmt", "yuv420p", "-r", String(FPS), output,
  ];
}

async function durationSeconds(file: string): Promise<number> {
  const { stdout } = await run("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", file]);
  return Number(stdout.trim());
}

const srtTime = (seconds: number): string => {
  const milliseconds = Math.round(seconds * 1000);
  const part = (value: number, width: number) => String(value).padStart(width, "0");
  return `${part(Math.floor(milliseconds / 3_600_000), 2)}:${part(Math.floor(milliseconds / 60_000) % 60, 2)}:${part(Math.floor(milliseconds / 1000) % 60, 2)},${part(milliseconds % 1000, 3)}`;
};

const metadataText = (value: string): string => value.replace(/[=;#\\\n]/g, (character) => `\\${character}`);

async function main(): Promise<void> {
  const directory = resolve(process.argv[2] ?? "");
  if (!process.argv[2]) throw new Error("Usage: render-bdd-video.ts <video-dir>");
  const entries = readManifest(directory).filter((entry) => entry.clips.length > 0);
  await titleCards(directory, entries);

  const segments: string[] = [];
  const chapters: string[] = [";FFMETADATA1"];
  const subtitles: string[] = [];
  let elapsed = 0;
  for (const entry of entries) {
    const segment = join(directory, `segment-${String(entry.index).padStart(3, "0")}.mp4`);
    await run("ffmpeg", segmentArguments(directory, entry, segment), { maxBuffer: 16 * 1024 * 1024 });
    const length = await durationSeconds(segment);
    segments.push(segment);
    chapters.push("[CHAPTER]", "TIMEBASE=1/1000", `START=${Math.round(elapsed * 1000)}`, `END=${Math.round((elapsed + length) * 1000)}`,
      `title=${metadataText(`${entry.index}. ${entry.name} (${entry.status === "PASSED" ? "passed" : entry.status.toLowerCase()})`)}`);
    subtitles.push(String(entry.index), `${srtTime(elapsed)} --> ${srtTime(elapsed + length)}`, `${entry.feature} — ${entry.name}`, "");
    elapsed += length;
    process.stdout.write(`rendered scenario ${entry.index}/${entries.length}: ${entry.name} (${length.toFixed(1)} s)\n`);
  }

  writeFileSync(join(directory, "segments.txt"), segments.map((segment) => `file '${segment}'`).join("\n"));
  writeFileSync(join(directory, "chapters.ffmeta"), chapters.join("\n"));
  writeFileSync(join(directory, "scenarios.srt"), subtitles.join("\n"));
  const output = join(directory, "bdd-session.mp4");
  await run("ffmpeg", [
    "-y", "-hide_banner", "-loglevel", "error",
    "-f", "concat", "-safe", "0", "-i", join(directory, "segments.txt"),
    "-i", join(directory, "chapters.ffmeta"), "-i", join(directory, "scenarios.srt"),
    "-map", "0:v", "-map", "2:s", "-map_metadata", "1", "-c:v", "copy", "-c:s", "mov_text", "-metadata:s:s:0", "language=eng",
    "-movflags", "+faststart", output,
  ], { maxBuffer: 16 * 1024 * 1024 });
  process.stdout.write(`\n${output}\n${entries.length} scenarios, ${(elapsed / 60).toFixed(1)} minutes\n`);
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exit(1);
});
