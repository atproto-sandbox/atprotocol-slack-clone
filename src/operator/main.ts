import { getAuthorityClientKeys, getOperatorConfig, isLoopback } from "@/lib/config";
import { getRawDb } from "@/lib/db";
import { sweepRegistrations } from "./registrations";
import { createOperatorApp } from "./server";

// The operator's process: serves its methods, its authority flow and its did:web document at OPERATOR_URL, and renews its
// change-notice registrations at start, so one that lapsed while it was down is restored then, not at the next reconcile.

// A configuration the operator cannot run with (or a database it cannot open) stops it here, not at the first request.
const { operatorUrl } = getOperatorConfig();
getAuthorityClientKeys();
getRawDb();
// Behind a proxy that terminates TLS, PORT is where the proxy sends; on loopback development, the URL's own host and port.
const port = Number(process.env.PORT || operatorUrl.port || (operatorUrl.protocol === "https:" ? 443 : 80));
const host = isLoopback(operatorUrl.hostname) ? operatorUrl.hostname.replace(/^\[|\]$/g, "") : "0.0.0.0";

const server = createOperatorApp().listen(port, host, () => {
  console.info(`operator serving ${operatorUrl.origin} on ${host}:${port}`);
  sweepRegistrations().then(
    (report) => {
      if (report) console.info(`notice registrations at start: ${report.registered} registered, ${report.failed} failed, ${report.skipped.length} workspaces skipped`);
    },
    (error: unknown) => console.error("ALERT notice registration sweep at start failed:", error instanceof Error ? error.name : "unknown error"),
  );
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => server.close(() => process.exit(0)));
}
