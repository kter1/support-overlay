/**
 * @support-overlay/api — Outbox worker process entry point.
 *
 * Runs as its own process (`npm run dev:worker`) but lives in this package
 * because it shares the service layer — db/pool, audit, actionService. It was
 * previously a separate app that reimplemented outbox processing from scratch,
 * without retry classification, dedupe, or SENT_UNCERTAIN handling, and that
 * reimplementation was the one that actually ran.
 */
import { startOutboxWorker, stopOutboxWorker } from "./workers/outboxWorker";
import { getDriver } from "./db/pool";

async function shutdown(signal: string): Promise<void> {
  console.log(`[worker] ${signal} received — stopping after current batch`);
  stopOutboxWorker();
  try {
    await getDriver().end();
  } catch {
    // Already closed.
  }
  process.exit(0);
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

startOutboxWorker().catch((err) => {
  console.error("[worker] Fatal:", err);
  process.exit(1);
});
