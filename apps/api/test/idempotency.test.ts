/**
 * Action idempotency.
 *
 * The key was stored and never used: a replayed submit hit the unique
 * constraint and surfaced as a 500 with a raw Postgres error, and the
 * constraint was global rather than per tenant.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  createTestDb,
  createTenant,
  createIssue,
  createEvidence,
  TestDb,
} from "./helpers/db";
import { initiateAction } from "../src/services/actionService";
import { ActionType, PolicyOutcome } from "@iisl/shared";

describe("action idempotency", () => {
  let db: TestDb;
  let tenantId: string;
  let issueId: string;

  beforeEach(async () => {
    db = await createTestDb();
    tenantId = await createTenant(db);
    issueId = await createIssue(db, tenantId);
    await createEvidence(db, tenantId, issueId, { refundAmountCents: 2500 });
  });

  afterEach(async () => {
    await db.close();
  });

  const submit = (key: string) =>
    initiateAction({
      tenantId,
      issueId,
      actionType: ActionType.CLOSE_CONFIRMED,
      agentId: "agent-1",
      idempotencyKey: key,
      actionParams: { zendesk_ticket_id: "10001" },
    });

  it("returns the original execution when a key is replayed", async () => {
    const first = await submit("same-key");
    const second = await submit("same-key");

    expect(first.outcome).toBe(PolicyOutcome.ALLOW);
    expect(second.actionExecutionId).toBe(first.actionExecutionId);
    expect(second.isReplay).toBe(true);
    expect(first.isReplay).toBeFalsy();
  });

  it("queues the side effect only once across replays", async () => {
    await submit("same-key");
    await submit("same-key");
    await submit("same-key");

    const executions = await db.driver.query(
      `SELECT id FROM action_executions WHERE tenant_id = $1`,
      [tenantId]
    );
    expect(executions.rows).toHaveLength(1);

    const outbox = await db.driver.query<{ idempotency_key: string }>(
      `SELECT idempotency_key FROM outbox_messages WHERE tenant_id = $1`,
      [tenantId]
    );
    const distinct = new Set(outbox.rows.map((r) => r.idempotency_key));
    expect(distinct.size).toBe(outbox.rows.length);
  });

  it("treats different keys as different actions", async () => {
    const first = await submit("key-1");
    const second = await submit("key-2");

    expect(second.actionExecutionId).not.toBe(first.actionExecutionId);
    expect(second.isReplay).toBeFalsy();
  });

  it("scopes keys per tenant so one tenant cannot block another", async () => {
    const otherTenant = await createTenant(db);
    const otherIssue = await createIssue(db, otherTenant);
    await createEvidence(db, otherTenant, otherIssue);

    const mine = await submit("shared-key");
    const theirs = await initiateAction({
      tenantId: otherTenant,
      issueId: otherIssue,
      actionType: ActionType.CLOSE_CONFIRMED,
      agentId: "agent-2",
      idempotencyKey: "shared-key",
      actionParams: { zendesk_ticket_id: "20001" },
    });

    expect(theirs.outcome).toBe(PolicyOutcome.ALLOW);
    expect(theirs.isReplay).toBeFalsy();
    expect(theirs.actionExecutionId).not.toBe(mine.actionExecutionId);
  });

  it("does not log a second policy decision for a replay", async () => {
    await submit("same-key");
    await submit("same-key");

    const decisions = await db.driver.query(
      `SELECT id FROM audit_log
        WHERE tenant_id = $1 AND event_type = 'policy_decision'`,
      [tenantId]
    );
    expect(decisions.rows).toHaveLength(1);
  });
});
