/**
 * Schema consistency.
 *
 * The prior schema shipped two disagreeing definitions (a "reference" file that
 * was the only one applied, plus split files the runner skipped), so application
 * SQL referenced columns that did not exist — risk_signals.severity,
 * approval_requests.approved_at, evidence_normalized.refund_amount_cents. These
 * tests apply the real migrations and assert the columns the code queries.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createTestDb, TestDb } from "./helpers/db";

describe("schema", () => {
  let db: TestDb;

  beforeAll(async () => {
    db = await createTestDb();
  });

  afterAll(async () => {
    await db?.close();
  });

  async function columnsOf(table: string): Promise<string[]> {
    const result = await db.driver.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns WHERE table_name = $1`,
      [table]
    );
    return result.rows.map((r) => r.column_name);
  }

  it("applies every migration cleanly", async () => {
    const result = await db.driver.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`
    );
    const tables = result.rows.map((r) => r.table_name);

    expect(tables).toEqual(
      expect.arrayContaining([
        "tenants",
        "tenant_config",
        "tenant_integrations",
        "api_credentials",
        "manager_grants",
        "issues",
        "issue_tickets",
        "evidence_normalized",
        "evidence_match_results",
        "issue_card_state",
        "inbound_events",
        "approval_requests",
        "action_executions",
        "outbox_messages",
        "risk_signals",
        "state_transitions",
        "audit_log",
      ])
    );
  });

  it("does not create the unused commitments table", async () => {
    const result = await db.driver.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = 'commitments'`
    );
    expect(result.rows).toHaveLength(0);
  });

  it("exposes the risk_signals column the policy path reads", async () => {
    // computeAbuseSeverity() groups by severity. The old schema called this
    // abuse_signal_level, so every action initiation raised a 500.
    expect(await columnsOf("risk_signals")).toContain("severity");
  });

  it("exposes the approval columns the approval lifecycle writes", async () => {
    const columns = await columnsOf("approval_requests");
    expect(columns).toEqual(
      expect.arrayContaining([
        "approval_policy_code",
        "assigned_queue",
        "assigned_manager_id",
        "approved_at",
        "denied_at",
        "reason",
        "linked_action_execution_id",
      ])
    );
  });

  it("exposes the refund columns the card read model projects", async () => {
    for (const table of ["evidence_normalized", "issue_card_state"]) {
      expect(await columnsOf(table)).toEqual(
        expect.arrayContaining([
          "refund_status",
          "refund_amount_cents",
          "refund_currency",
          "refund_id",
        ])
      );
    }
  });

  it("uses the state_transitions shape applyStateTransition writes", async () => {
    expect(await columnsOf("state_transitions")).toEqual(
      expect.arrayContaining([
        "action_execution_id",
        "trigger_event",
        "actor_type",
        "actor_id",
      ])
    );
  });

  it("scopes action idempotency per tenant rather than globally", async () => {
    const result = await db.driver.query<{ constraint_name: string }>(
      `SELECT c.conname AS constraint_name
       FROM pg_constraint c
       JOIN pg_class t ON t.oid = c.conrelid
       WHERE t.relname = 'action_executions' AND c.contype = 'u'`
    );
    expect(result.rows.length).toBeGreaterThan(0);

    // Two tenants must be able to use the same idempotency key.
    const t1 = await db.driver.query<{ id: string }>(
      `INSERT INTO tenants (name, subdomain) VALUES ('A', 'a-iso') RETURNING id`
    );
    const t2 = await db.driver.query<{ id: string }>(
      `INSERT INTO tenants (name, subdomain) VALUES ('B', 'b-iso') RETURNING id`
    );
    const i1 = await db.driver.query<{ id: string }>(
      `INSERT INTO issues (tenant_id, state) VALUES ($1, 'OPEN') RETURNING id`,
      [t1.rows[0].id]
    );
    const i2 = await db.driver.query<{ id: string }>(
      `INSERT INTO issues (tenant_id, state) VALUES ($1, 'OPEN') RETURNING id`,
      [t2.rows[0].id]
    );

    const insert = (tenantId: string, issueId: string) =>
      db.driver.query(
        `INSERT INTO action_executions
           (tenant_id, issue_id, action_type, requested_by_agent_id, idempotency_key)
         VALUES ($1, $2, 'close_confirmed', 'agent-1', 'shared-key')`,
        [tenantId, issueId]
      );

    await insert(t1.rows[0].id, i1.rows[0].id);
    await expect(insert(t2.rows[0].id, i2.rows[0].id)).resolves.toBeDefined();
  });

  it("keeps audit_log immutable", async () => {
    const tenant = await db.driver.query<{ id: string }>(
      `INSERT INTO tenants (name, subdomain) VALUES ('C', 'c-immutable') RETURNING id`
    );
    await db.driver.query(
      `INSERT INTO audit_log (tenant_id, event_type, actor_type)
       VALUES ($1, 'policy_decision', 'agent')`,
      [tenant.rows[0].id]
    );

    await expect(
      db.driver.query(`UPDATE audit_log SET event_type = 'tampered'`)
    ).rejects.toThrow(/IMMUTABLE/);
  });

  it("restricts issues.state to the four canonical states", async () => {
    const tenant = await db.driver.query<{ id: string }>(
      `INSERT INTO tenants (name, subdomain) VALUES ('D', 'd-states') RETURNING id`
    );
    await expect(
      db.driver.query(
        `INSERT INTO issues (tenant_id, state) VALUES ($1, 'ESCALATED')`,
        [tenant.rows[0].id]
      )
    ).rejects.toThrow();
  });
});
