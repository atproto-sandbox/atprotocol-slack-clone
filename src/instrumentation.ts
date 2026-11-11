/**
 * Runs once when a server process starts. The operator renews its change-notice registrations then, so one that lapsed while
 * the operator was down is restored at start instead of at the next scheduled reconcile.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { sweepRegistrations } = await import("@/operator/registrations");
  sweepRegistrations().then(
    (report) => {
      if (report) console.info(`notice registrations at start: ${report.registered} registered, ${report.failed} failed, ${report.skipped.length} workspaces skipped`);
    },
    (error: unknown) => console.error("ALERT notice registration sweep at start failed:", error instanceof Error ? error.name : "unknown error"),
  );
}
