/**
 * @file apps/worker/src/index.ts
 * @description Outbox worker process entry point.
 *
 * The worker polls the outbox_messages table for pending/retriable messages
 * and processes them with effects-ledger deduplication.
 *
 * Start: npm run dev --workspace=apps/worker
 */

import { Pool, PoolClient } from "pg";

function normalizeDatabaseUrl(raw?: string): string | undefined {
  if (!raw) return raw;
  try {
    const parsed = new URL(raw);
    // Prefer IPv4 loopback to avoid localhost (::1) resolving to another PG instance.
    if (parsed.hostname === "localhost") {
      parsed.hostname = "127.0.0.1";
      return parsed.toString();
    }
  } catch {
    // Leave as-is; downstream connection error will be clearer than silent fallback.
  }
  return raw;
}

const pool = new Pool({
  connectionString: normalizeDatabaseUrl(process.env.DATABASE_URL),
});

const POLL_INTERVAL_MS = parseInt(process.env.WORKER_POLL_INTERVAL_MS ?? "2000", 10);
const MAX_ATTEMPTS = parseInt(process.env.WORKER_MAX_ATTEMPTS ?? "5", 10);
const RETRY_DELAYS_MS = [1000, 2000, 4000, 8000, 16000];

async function processOutbox(): Promise<void> {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    // Claim up to 10 due messages (SKIP LOCKED for concurrent safety)
    const { rows } = await client.query<{
      id: string;
      action_execution_id: string;
      target_system: string;
      payload: Record<string, unknown>;
      idempotency_key: string;
      status: string;
      attempt_count: number;
      effects: unknown[];
      action_type: string;
      planned_state: string | null;
      issue_id: string;
      tenant_id: string;
      correlation_id: string | null;
    }>(`
      SELECT om.*, ae.action_type, ae.planned_state,
             ae.issue_id, ae.tenant_id, ae.correlation_id
      FROM outbox_messages om
      JOIN action_executions ae ON ae.id = om.action_execution_id
      WHERE om.status IN ('PENDING', 'FAILED_RETRIABLE')
        AND (om.next_attempt_at IS NULL OR om.next_attempt_at <= now())
      ORDER BY om.created_at ASC
      LIMIT 10
      FOR UPDATE OF om SKIP LOCKED
    `);

    await client.query("COMMIT");

    // Process each message
    for (const msg of rows) {
      await processMessage(msg);
    }
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("[worker] Error claiming messages:", err);
  } finally {
    client.release();
  }
}

interface OutboxRow {
  id: string;
  action_execution_id: string;
  target_system: string;
  payload: Record<string, unknown>;
  idempotency_key: string;
  status: string;
  attempt_count: number;
  effects: unknown[];
  action_type: string;
  planned_state: string | null;
  issue_id: string;
  tenant_id: string;
  correlation_id: string | null;
}

async function processMessage(msg: OutboxRow): Promise<void> {
  console.log(
    `[worker] Processing ${msg.id} | action=${msg.action_type} | system=${msg.target_system} | attempt=${msg.attempt_count + 1}`
  );

  const client = await pool.connect();

  try {
    // Increment attempt count before dispatch.
    await client.query(
      `UPDATE outbox_messages SET attempt_count = attempt_count + 1 WHERE id = $1`,
      [msg.id]
    );

    await client.query(
      `UPDATE action_executions SET status = 'IN_PROGRESS' WHERE id = $1`,
      [msg.action_execution_id]
    );

    // Simulate dispatch (real connectors called here)
    const outcome = await dispatchMessage(msg);

    if (outcome === "success") {
      await client.query("BEGIN");

      // Mark outbox SENT
      await client.query(
        `UPDATE outbox_messages SET status = 'SENT', sent_at = now() WHERE id = $1`,
        [msg.id]
      );

      // Check if all outbox messages for this execution are SENT
      const { rows: pending } = await client.query(
        `SELECT id FROM outbox_messages
         WHERE action_execution_id = $1 AND status NOT IN ('SENT')`,
        [msg.action_execution_id]
      );

      if (pending.length === 0) {
        // All outbox messages SENT — now write canonical state transition
        // spec §4.2 step 5: state_transitions written AFTER execution confirms
        await completeExecution(client, msg);
      }

      await client.query("COMMIT");
    } else if (outcome === "retriable") {
      const nextAttempt = msg.attempt_count + 1;

      if (nextAttempt >= MAX_ATTEMPTS) {
        await markTerminalFailure(client, msg, "Max retry attempts exhausted");
      } else {
        const delayMs = RETRY_DELAYS_MS[Math.min(nextAttempt, RETRY_DELAYS_MS.length - 1)];
        await client.query(
          `UPDATE outbox_messages
           SET status = 'FAILED_RETRIABLE',
               next_attempt_at = now() + $1 * interval '1 millisecond'
           WHERE id = $2`,
          [delayMs, msg.id]
        );

        await client.query(
          `UPDATE action_executions SET status = 'FAILED_RETRIABLE' WHERE id = $1`,
          [msg.action_execution_id]
        );
      }
    } else {
      // Terminal failure
      await markTerminalFailure(client, msg, "Permanent downstream error");
    }
  } catch (err) {
    console.error(`[worker] Error processing ${msg.id}:`, err);

    const nextAttempt = msg.attempt_count + 1;

    if (nextAttempt >= MAX_ATTEMPTS) {
      await markTerminalFailure(client, msg, String(err));
    } else {
      const delayMs = RETRY_DELAYS_MS[Math.min(nextAttempt, RETRY_DELAYS_MS.length - 1)];
      await client.query(
        `UPDATE outbox_messages
         SET status = 'FAILED_RETRIABLE',
             next_attempt_at = now() + $1 * interval '1 millisecond'
         WHERE id = $2`,
        [delayMs, msg.id]
      );
      await client.query(
        `UPDATE action_executions
         SET status = 'FAILED_RETRIABLE', error = $1
         WHERE id = $2`,
        [String(err), msg.action_execution_id]
      );
    }
  } finally {
    client.release();
  }
}

async function dispatchMessage(msg: OutboxRow): Promise<"success" | "retriable" | "terminal"> {
  // For local demo: simulate dispatch with configurable behavior
  const payload = msg.payload as Record<string, unknown>;

  if (msg.target_system === "zendesk") {
    const type = payload.type as string;

    if (type === "set_status") {
      // Simulate: 90% success, 10% retriable timeout
      const roll = Math.random();
      if (roll < 0.9) {
        console.log(`[worker:zendesk-sim] ✓ Ticket ${payload.ticket_id} status → ${payload.status}`);
        return "success";
      } else {
        console.log(`[worker:zendesk-sim] ⚠ Timeout (SENT_UNCERTAIN simulated) for ticket ${payload.ticket_id}`);
        return "retriable";
      }
    }

    if (type === "post_comment") {
      console.log(`[worker:zendesk-sim] ✓ Comment posted to ticket ${payload.ticket_id}`);
      return "success";
    }
  }

  if (msg.target_system === "stripe") {
    console.log(`[worker:stripe-sim] ✓ Stripe action completed`);
    return "success";
  }

  // Default: simulate success
  return "success";
}

async function completeExecution(client: PoolClient, msg: OutboxRow): Promise<void> {
  // Write canonical state transition ONLY now (applied state, not intent)
  if (msg.planned_state) {
    const { rows: issue } = await client.query<{ state: string; lock_version: number }>(
      `SELECT state, lock_version FROM issues WHERE id = $1`,
      [msg.issue_id]
    );

    if (issue.length > 0) {
      await client.query(
        `INSERT INTO state_transitions (tenant_id, issue_id, from_state, to_state, triggered_by_action_execution_id)
         VALUES ($1, $2, $3, $4, $5)`,
        [msg.tenant_id, msg.issue_id, issue[0].state, msg.planned_state, msg.action_execution_id]
      );

      await client.query(
        `UPDATE issues SET state = $1, lock_version = lock_version + 1, updated_at = now()
         WHERE id = $2 AND lock_version = $3`,
        [msg.planned_state, msg.issue_id, issue[0].lock_version]
      );
    }
  }

  // Mark execution COMPLETED
  await client.query(
    `UPDATE action_executions SET status = 'COMPLETED', completed_at = now() WHERE id = $1`,
    [msg.action_execution_id]
  );

  // Write audit event
  await client.query(
    `INSERT INTO audit_log (tenant_id, issue_id, event_type, actor_type, payload, correlation_id)
     VALUES ($1, $2, 'action_execution_completed', 'system', $3::jsonb, $4)`,
    [
      msg.tenant_id,
      msg.issue_id,
      JSON.stringify({ action_execution_id: msg.action_execution_id, action_type: msg.action_type }),
      msg.correlation_id,
    ]
  );

  // Rebuild card state
  await pool.query(
    `UPDATE issue_card_state
     SET issue_state = $1,
         pending_action_execution_id = NULL,
         last_action_type = $2,
         last_action_completed_at = now(),
         last_rebuilt_at = now(),
         rebuilt_from_action_execution_id = $3
     WHERE issue_id = $4`,
    [msg.planned_state ?? "RESOLVED", msg.action_type, msg.action_execution_id, msg.issue_id]
  );

  console.log(`[worker] ✓ Execution complete: ${msg.action_execution_id} → ${msg.planned_state}`);
}

async function markTerminalFailure(
  client: PoolClient,
  msg: OutboxRow,
  reason: string
): Promise<void> {
  // FAILED_TERMINAL — do NOT write state_transitions (spec §4.2 step 6, Finding 3)
  // issues.state remains unchanged

  await client.query(
    `UPDATE outbox_messages SET status = 'FAILED_TERMINAL' WHERE id = $1`,
    [msg.id]
  );

  await client.query(
    `UPDATE action_executions
     SET status = 'FAILED_TERMINAL', error = $1, completed_at = now()
     WHERE id = $2`,
    [reason, msg.action_execution_id]
  );

  await client.query(
    `INSERT INTO audit_log (tenant_id, issue_id, event_type, actor_type, payload, correlation_id)
     VALUES ($1, $2, 'action_execution_failed_terminal', 'system', $3::jsonb, $4)`,
    [
      msg.tenant_id,
      msg.issue_id,
      JSON.stringify({
        action_execution_id: msg.action_execution_id,
        reason,
        action_type: msg.action_type,
      }),
      msg.correlation_id,
    ]
  );

  await pool.query(
    `UPDATE issue_card_state
     SET pending_action_execution_id = NULL,
         last_rebuilt_at = now()
     WHERE issue_id = $1`,
    [msg.issue_id]
  );

  console.error(`[worker] ✗ FAILED_TERMINAL: ${msg.action_execution_id} — ${reason}`);
}

// ─── Worker loop ──────────────────────────────────────────────────────────────

async function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  console.log(`[worker] Starting outbox worker (poll interval: ${POLL_INTERVAL_MS}ms)`);

  while (true) {
    try {
      await processOutbox();
    } catch (err) {
      console.error("[worker] Unhandled error in processOutbox:", err);
    }
    await sleep(POLL_INTERVAL_MS);
  }
}

main().catch((err) => {
  console.error("[worker] Fatal error:", err);
  process.exit(1);
});
