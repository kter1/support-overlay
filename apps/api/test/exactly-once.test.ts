/**
 * Exactly-once side effects.
 *
 * This is the product claim, so it is the test that matters most. Each case
 * drives a real failure through the adapter and asserts on the effects ledger
 * and the provider's own record of what happened.
 *
 * The defects these cover were all live before: the worker with retry
 * classification was never invoked, TimeoutError was never thrown so
 * SENT_UNCERTAIN was unreachable, and the running worker had no dedupe at all.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createTestDb, createTenant, createIssue, TestDb } from "./helpers/db";
import { processNextBatch } from "../src/workers/outboxWorker";
import { buildEffectsForAction } from "../src/services/effects";
import { stripeSimulator, StripeAdapter } from "@iisl/connectors";
import { ActionType, TimeoutError, PermanentError } from "@iisl/shared";
import { randomUUID } from "crypto";

const CHARGE = "ch_test_exactly_once";

describe("exactly-once side effects", () => {
  let db: TestDb;
  let tenantId: string;
  let issueId: string;

  beforeEach(async () => {
    db = await createTestDb();
    stripeSimulator.reset();
    tenantId = await createTenant(db);
    issueId = await createIssue(db, tenantId);
  });

  afterEach(async () => {
    await db.close();
  });

  /** Queue a refund the way initiateAction does, and return the execution id. */
  async function queueRefund(amountCents = 2500): Promise<string> {
    const executionId = randomUUID();

    await db.driver.query(
      `INSERT INTO action_executions
         (id, tenant_id, issue_id, action_type, requested_by_agent_id,
          idempotency_key, planned_state, status)
       VALUES ($1, $2, $3, $4, 'agent-1', $5, 'RESOLVED', 'PENDING')`,
      [executionId, tenantId, issueId, ActionType.ISSUE_REFUND, `key-${executionId}`]
    );

    const effects = buildEffectsForAction(ActionType.ISSUE_REFUND, executionId, {
      stripe_charge_id: CHARGE,
      refund_amount_cents: amountCents,
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

  async function refundsOnCharge(): Promise<number> {
    return new StripeAdapter().listRefundsByCharge(CHARGE).then((r) => r.length);
  }

  async function outboxRow(executionId: string) {
    const result = await db.driver.query<{
      status: string;
      effects: Array<{ effect_key: string; outcome_status: string }>;
      attempt_count: number;
      effect_settled_at: string | null;
    }>(
      `SELECT status, effects, attempt_count, effect_settled_at
         FROM outbox_messages WHERE action_execution_id = $1`,
      [executionId]
    );
    return result.rows[0];
  }

  async function executionStatus(executionId: string): Promise<string> {
    const result = await db.driver.query<{ status: string }>(
      `SELECT status FROM action_executions WHERE id = $1`,
      [executionId]
    );
    return result.rows[0].status;
  }

  it("issues exactly one refund on the happy path", async () => {
    const executionId = await queueRefund();

    await processNextBatch();

    expect(await refundsOnCharge()).toBe(1);
    expect(await executionStatus(executionId)).toBe("COMPLETED");
    expect((await outboxRow(executionId)).status).toBe("SENT");
  });

  it("never re-sends a refund whose outcome is unknown", async () => {
    // The request reached Stripe and the refund was created, but the response
    // was lost. This is the case that produces duplicate refunds in systems
    // that treat a timeout as a retriable failure.
    stripeSimulator.failNext(new TimeoutError("connection reset after send"));

    const executionId = await queueRefund();

    await processNextBatch();
    // Additional polling cycles must not produce a second refund.
    await processNextBatch();
    await processNextBatch();

    expect(await refundsOnCharge()).toBe(1);

    const row = await outboxRow(executionId);
    // Reconciliation found the refund by effect_key, so this is a confirmed
    // effect rather than an unresolved one.
    expect(row.status).toBe("SENT");
    expect(row.effects.some((e) => e.outcome_status === "SENT_UNCERTAIN")).toBe(true);
    expect(row.effects.some((e) => e.outcome_status === "CONFIRMED")).toBe(true);
  });

  it("parks for an operator when an uncertain refund cannot be confirmed", async () => {
    const executionId = await queueRefund();

    // Timeout where the effect genuinely did not land: nothing to reconcile
    // against, so the only safe outcome is to stop and ask a human.
    stripeSimulator.failNext(new TimeoutError("gateway timeout"), {
      effectLanded: false,
    });

    await processNextBatch();

    // No refund was recorded, and the execution is blocked rather than retried.
    expect(await refundsOnCharge()).toBe(0);

    const row = await outboxRow(executionId);
    expect(row.status).toBe("BLOCKED_OPERATOR");
    expect(await executionStatus(executionId)).toBe("FAILED_TERMINAL");

    // Further polling must not dispatch it again.
    await processNextBatch();
    expect(await refundsOnCharge()).toBe(0);
  });

  it("does not re-dispatch an effect that is already settled", async () => {
    const executionId = await queueRefund();
    await processNextBatch();
    expect(await refundsOnCharge()).toBe(1);

    // Simulate a crash that left the row claimable again after the provider
    // had already acted.
    await db.driver.query(
      `UPDATE outbox_messages
          SET status = 'PENDING', next_attempt_at = NULL
        WHERE action_execution_id = $1`,
      [executionId]
    );

    await processNextBatch();

    expect(await refundsOnCharge()).toBe(1);
    expect((await outboxRow(executionId)).status).toBe("SENT");
  });

  it("stops permanently on a provider rejection without retrying", async () => {
    stripeSimulator.failNext(new PermanentError("charge already fully refunded"));

    const executionId = await queueRefund();
    await processNextBatch();

    expect(await refundsOnCharge()).toBe(0);
    expect(await executionStatus(executionId)).toBe("FAILED_TERMINAL");

    const row = await outboxRow(executionId);
    expect(row.status).toBe("FAILED_TERMINAL");
    expect(row.effects.some((e) => e.outcome_status === "FAILED_TERMINAL")).toBe(true);

    await processNextBatch();
    expect(await refundsOnCharge()).toBe(0);
  });

  it("writes no state transition when an execution fails terminally", async () => {
    stripeSimulator.failNext(new PermanentError("charge not refundable"));

    const executionId = await queueRefund();
    await processNextBatch();

    const transitions = await db.driver.query(
      `SELECT id FROM state_transitions WHERE action_execution_id = $1`,
      [executionId]
    );
    expect(transitions.rows).toHaveLength(0);

    // The issue state is untouched: nothing was applied.
    const issue = await db.driver.query<{ state: string }>(
      `SELECT state FROM issues WHERE id = $1`,
      [issueId]
    );
    expect(issue.rows[0].state).toBe("OPEN");
  });

  it("writes exactly one state transition on success", async () => {
    const executionId = await queueRefund();
    await processNextBatch();

    const transitions = await db.driver.query(
      `SELECT id FROM state_transitions WHERE action_execution_id = $1`,
      [executionId]
    );
    expect(transitions.rows).toHaveLength(1);

    const issue = await db.driver.query<{ state: string }>(
      `SELECT state FROM issues WHERE id = $1`,
      [issueId]
    );
    expect(issue.rows[0].state).toBe("RESOLVED");
  });
});
