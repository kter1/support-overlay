/**
 * Multi-worker contention.
 *
 * These require a real Postgres server (TEST_DATABASE_URL). PGlite is a single
 * connection, so it cannot exercise FOR UPDATE SKIP LOCKED or row locks at all
 * — a suite that "passed" under it would be proving nothing. CI runs a Postgres
 * service so these execute there; locally they skip unless you point at a
 * server.
 *
 * The invariant under test is the one the product is sold on: two workers
 * racing the same backlog must still produce exactly one side effect per
 * effect_key, and exactly one state transition per execution.
 */
import { it, expect, beforeEach, afterEach } from "vitest";
import {
  createTestDb,
  createTenant,
  createIssue,
  describeRealPostgres,
  TestDb,
} from "./helpers/db";
import { processNextBatch } from "../src/workers/outboxWorker";
import { buildEffectsForAction } from "../src/services/effects";
import { stripeSimulator, StripeAdapter } from "@iisl/connectors";
import { ActionType } from "@iisl/shared";
import { randomUUID } from "crypto";

describeRealPostgres("multi-worker contention", () => {
  let db: TestDb;
  let tenantId: string;

  beforeEach(async () => {
    db = await createTestDb();
    stripeSimulator.reset();
    tenantId = await createTenant(db);
  });

  afterEach(async () => {
    await db.close();
  });

  async function queueRefund(chargeId: string): Promise<string> {
    const issueId = await createIssue(db, tenantId);
    const executionId = randomUUID();

    await db.driver.query(
      `INSERT INTO action_executions
         (id, tenant_id, issue_id, action_type, requested_by_agent_id,
          idempotency_key, planned_state, status)
       VALUES ($1, $2, $3, $4, 'agent-1', $5, 'RESOLVED', 'PENDING')`,
      [executionId, tenantId, issueId, ActionType.ISSUE_REFUND, `key-${executionId}`]
    );

    const effects = buildEffectsForAction(ActionType.ISSUE_REFUND, executionId, {
      stripe_charge_id: chargeId,
      refund_amount_cents: 2500,
    });

    for (const effect of effects) {
      await db.driver.query(
        `INSERT INTO outbox_messages
           (tenant_id, action_execution_id, target_system, payload,
            idempotency_key, status, effects)
         VALUES ($1, $2, $3, $4, $5, 'PENDING', $6)`,
        [
          tenantId,
          executionId,
          effect.targetSystem,
          JSON.stringify(effect.payload),
          effect.idempotencyKey,
          JSON.stringify([effect.initialLedgerEntry]),
        ]
      );
    }

    return executionId;
  }

  it("has a real server, so these assertions mean something", () => {
    expect(db.isRealPostgres).toBe(true);
  });

  it("never lets two concurrent workers double-refund one charge", async () => {
    const charge = "ch_race_single";
    await queueRefund(charge);

    // Two workers claiming the same backlog at the same instant.
    await Promise.all([processNextBatch(), processNextBatch()]);

    const refunds = await new StripeAdapter().listRefundsByCharge(charge);
    expect(refunds).toHaveLength(1);
  });

  it("claims each row exactly once across many racing workers", async () => {
    const charges = Array.from({ length: 12 }, (_, i) => `ch_race_${i}`);
    for (const charge of charges) {
      await queueRefund(charge);
    }

    // Six workers against twelve rows, repeatedly, to force overlap.
    await Promise.all(Array.from({ length: 6 }, () => processNextBatch()));
    await Promise.all(Array.from({ length: 6 }, () => processNextBatch()));

    const adapter = new StripeAdapter();
    for (const charge of charges) {
      const refunds = await adapter.listRefundsByCharge(charge);
      expect(refunds, `charge ${charge}`).toHaveLength(1);
    }

    const rows = await db.driver.query<{ status: string; attempt_count: number }>(
      `SELECT status, attempt_count FROM outbox_messages`
    );
    expect(rows.rows).toHaveLength(charges.length);
    for (const row of rows.rows) {
      expect(row.status).toBe("SENT");
      // One claim per row: a second claim would have incremented this again.
      expect(row.attempt_count).toBe(1);
    }
  });

  it("writes exactly one state transition per execution under contention", async () => {
    const executionIds: string[] = [];
    for (let i = 0; i < 6; i++) {
      executionIds.push(await queueRefund(`ch_transition_${i}`));
    }

    await Promise.all(Array.from({ length: 4 }, () => processNextBatch()));
    await Promise.all(Array.from({ length: 4 }, () => processNextBatch()));

    for (const executionId of executionIds) {
      const transitions = await db.driver.query(
        `SELECT id FROM state_transitions WHERE action_execution_id = $1`,
        [executionId]
      );
      expect(transitions.rows, `execution ${executionId}`).toHaveLength(1);
    }

    // And every issue advanced exactly one lock_version step.
    const issues = await db.driver.query<{ lock_version: number; state: string }>(
      `SELECT lock_version, state FROM issues`
    );
    for (const issue of issues.rows) {
      expect(issue.state).toBe("RESOLVED");
      expect(issue.lock_version).toBe(1);
    }
  });

  it("does not re-dispatch when a crashed claim is retried alongside a live worker", async () => {
    const charge = "ch_crash_recovery";
    const executionId = await queueRefund(charge);

    await processNextBatch();
    expect(await new StripeAdapter().listRefundsByCharge(charge)).toHaveLength(1);

    // A crashed worker's row is returned to the queue while another worker runs.
    await db.driver.query(
      `UPDATE outbox_messages
          SET status = 'PENDING', next_attempt_at = NULL
        WHERE action_execution_id = $1`,
      [executionId]
    );

    await Promise.all([processNextBatch(), processNextBatch()]);

    expect(await new StripeAdapter().listRefundsByCharge(charge)).toHaveLength(1);
  });

  it("keeps action idempotency keys unique under a concurrent insert race", async () => {
    const issueId = await createIssue(db, tenantId);
    const key = "concurrent-key";

    const insert = () =>
      db.driver.query(
        `INSERT INTO action_executions
           (tenant_id, issue_id, action_type, requested_by_agent_id, idempotency_key)
         VALUES ($1, $2, 'close_confirmed', 'agent-1', $3)`,
        [tenantId, issueId, key]
      );

    const results = await Promise.allSettled([insert(), insert(), insert()]);
    const succeeded = results.filter((r) => r.status === "fulfilled");

    // The unique constraint is what initiateAction relies on to resolve a
    // concurrent duplicate to the winner's row instead of double-queueing.
    expect(succeeded).toHaveLength(1);
  });
});
