import type { Page } from "@playwright/test";

// What a page's browser does on the network that a page itself cannot see: the CORS preflights it sends, observed through the
// DevTools protocol (K9 of `.ai/plans/platform-refactor.md`).

export type Preflight = { url: string; outcome: string };

/**
 * Every CORS preflight the browser sends for this page and how it ended, observed through the DevTools protocol, so a
 * preflight that fails is seen even when a later request succeeds. A preflight is settled only when loading finishes or
 * fails: an OPTIONS answer can arrive with a 2xx status and still fail the browser's CORS check. Any request the browser
 * refuses on CORS grounds (the preflight itself or the request it guarded) is reported as a failed preflight too.
 */
export async function watchPreflights(page: Page): Promise<Preflight[]> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Network.enable");
  const urls = new Map<string, string>();
  const pending = new Map<string, { url: string; status?: number }>();
  const preflights: Preflight[] = [];
  cdp.on("Network.requestWillBeSent", (event) => {
    urls.set(event.requestId, event.request.url);
    if (event.type === "Preflight" || event.request.method === "OPTIONS") pending.set(event.requestId, { url: event.request.url });
  });
  cdp.on("Network.responseReceived", (event) => {
    const preflight = pending.get(event.requestId);
    if (preflight) preflight.status = event.response.status;
  });
  cdp.on("Network.loadingFinished", (event) => {
    const preflight = pending.get(event.requestId);
    if (!preflight) return;
    pending.delete(event.requestId);
    preflights.push({ url: preflight.url, outcome: String(preflight.status ?? "no response") });
  });
  cdp.on("Network.loadingFailed", (event) => {
    const preflight = pending.get(event.requestId);
    pending.delete(event.requestId);
    const outcome = event.corsErrorStatus ? `CORS ${event.corsErrorStatus.corsError}` : event.errorText;
    if (preflight) preflights.push({ url: preflight.url, outcome });
    else if (event.corsErrorStatus) preflights.push({ url: urls.get(event.requestId) ?? "unknown", outcome });
  });
  return preflights;
}

export function countByOrigin(preflights: Preflight[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const { url } of preflights) counts[new URL(url).origin] = (counts[new URL(url).origin] ?? 0) + 1;
  return counts;
}
