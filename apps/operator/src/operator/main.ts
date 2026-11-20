import { isLoopback } from "@flock/deployment/config";
import { getAuthorityClientKeys, getOperatorConfig } from "../config";
import { getRawDb } from "../lib/db";
import {
  flushPendingRenewals,
  RENEW_LOOP_INTERVAL_MS,
  SWEEP_INTERVAL_SECONDS,
  sweepDueRegistrations,
  sweepRegistrations,
} from "./registrations";
import { createOperatorApp } from "./server";

// The operator's process: serves its methods, its authority flow and its did:web document at OPERATOR_URL, runs a fast 60s
// SQL-first renewal loop so 10-minute inline space notification credentials stay continuously active, and runs the 30-minute
// workspace discovery backfill sweep.

// A configuration the operator cannot run with (or a database it cannot open) stops it here, not at the first request.
const { operatorUrl } = getOperatorConfig();
getAuthorityClientKeys();
getRawDb();
// Behind a proxy that terminates TLS, PORT is where the proxy sends; on loopback development, the URL's own host and port.
const port = Number(process.env.PORT || operatorUrl.port || (operatorUrl.protocol === "https:" ? 443 : 80));
const host = isLoopback(operatorUrl.hostname) ? operatorUrl.hostname.replace(/^\[|\]$/g, "") : "0.0.0.0";

function logSweep(label: string, promise: Promise<{ registered: number; failed: number; skipped: unknown[] } | null>): void {
  promise.then(
    (report) => {
      if (report && (report.registered > 0 || report.failed > 0 || report.skipped.length > 0)) {
        console.info(`${label}: ${report.registered} registered, ${report.failed} failed, ${report.skipped.length} skipped`);
      }
    },
    (error: unknown) => console.error(`ALERT ${label} failed:`, error instanceof Error ? error.name : "unknown error"),
  );
}

let renewInterval: ReturnType<typeof setInterval> | undefined;
let discoveryInterval: ReturnType<typeof setInterval> | undefined;

const server = createOperatorApp().listen(port, host, () => {
  console.info(`operator serving ${operatorUrl.origin} on ${host}:${port}`);
  logSweep("notice due renewals at start", sweepDueRegistrations());
  logSweep("notice discovery sweep at start", sweepRegistrations());

  renewInterval = setInterval(() => {
    logSweep("notice due renewals", sweepDueRegistrations());
  }, RENEW_LOOP_INTERVAL_MS);
  renewInterval.unref();

  discoveryInterval = setInterval(() => {
    logSweep("notice discovery sweep", sweepRegistrations());
  }, SWEEP_INTERVAL_SECONDS * 1000);
  discoveryInterval.unref();
});

let shuttingDown = false;
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    if (shuttingDown) return;
    shuttingDown = true;
    if (renewInterval) clearInterval(renewInterval);
    if (discoveryInterval) clearInterval(discoveryInterval);
    server.close(() => {
      flushPendingRenewals().finally(() => process.exit(0));
    });
  });
}
