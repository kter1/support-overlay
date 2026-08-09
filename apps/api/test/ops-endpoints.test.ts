/**
 * Operator read/config endpoints.
 *
 * The audit export is the artifact the whole system exists to produce, and it
 * was documented in DEMO.md without existing — found when the live run 404ed.
 * These keep the documented operator surface real.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Fastify, { FastifyInstance } from "fastify";
import { createTestDb, createTenant, createIssue, TestDb } from "./helpers/db";
import { hashToken } from "../src/middleware/auth";
import { correlationIdMiddleware } from "../src/middleware/correlationId";
import { registerErrorHandling } from "../src/middleware/errors";
import { opsRoutes } from "../src/routes/ops";

const OPERATOR_TOKEN = "operator-token-ops-suite";

describe("operator endpoints", () => {
  let db: TestDb;
  let app: FastifyInstance;
  let tenantId: string;
  let issueId: string;

  beforeEach(async () => {
    db = await createTestDb();
    tenantId = await createTenant(db);
    issueId = await createIssue(db, tenantId);

    await db.driver.query(
      `INSERT INTO api_credentials (tenant_id, role, token_sha256, principal_id)
       VALUES ($1, 'operator', $2, 'op-1')`,
      [tenantId, hashToken(OPERATOR_TOKEN)]
    );

    app = Fastify();
    app.addHook("onRequest", correlationIdMiddleware);
    registerErrorHandling(app);
    app.register(opsRoutes, { prefix: "/ops" });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    await db.close();
  });

  const get = (url: string) =>
    app.inject({
      method: "GET",
      url,
      headers: { authorization: `Bearer ${OPERATOR_TOKEN}` },
    });

  it("exports the audit trail for an issue, oldest first", async () => {
    for (const event of ["policy_decision", "action_execution_created"]) {
      await db.driver.query(
        `INSERT INTO audit_log (tenant_id, issue_id, event_type, actor_type, policy_rule_id)
         VALUES ($1, $2, $3, 'agent', 'rule_x')`,
        [tenantId, issueId, event]
      );
    }

    const response = await get(`/ops/audit/${issueId}`);

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.event_count).toBe(2);
    expect(body.events[0].event_type).toBe("policy_decision");
    expect(body.events[0].policy_rule_id).toBe("rule_x");
  });

  it("does not export another tenant's audit rows", async () => {
    const otherTenant = await createTenant(db);
    const otherIssue = await createIssue(db, otherTenant);
    await db.driver.query(
      `INSERT INTO audit_log (tenant_id, issue_id, event_type, actor_type)
       VALUES ($1, $2, 'policy_decision', 'agent')`,
      [otherTenant, otherIssue]
    );

    const response = await get(`/ops/audit/${otherIssue}`);

    // The issue id is real, but it is not this credential's tenant.
    expect(response.json().event_count).toBe(0);
  });

  it("lists executions filtered by status", async () => {
    await db.driver.query(
      `INSERT INTO action_executions
         (tenant_id, issue_id, action_type, requested_by_agent_id, idempotency_key, status)
       VALUES ($1, $2, 'close_confirmed', 'a', 'k1', 'COMPLETED'),
              ($1, $2, 'issue_refund', 'a', 'k2', 'FAILED_TERMINAL')`,
      [tenantId, issueId]
    );

    const response = await get("/ops/action-executions?status=FAILED_TERMINAL");

    const executions = response.json().executions;
    expect(executions).toHaveLength(1);
    expect(executions[0].action_type).toBe("issue_refund");
  });

  it("updates tenant config and audits before/after", async () => {
    const response = await app.inject({
      method: "PATCH",
      url: "/ops/tenant-config",
      headers: {
        authorization: `Bearer ${OPERATOR_TOKEN}`,
        "content-type": "application/json",
      },
      payload: { approvals_enabled: true },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().config.approvals_enabled).toBe(true);

    const audit = await db.driver.query<{ payload: { before: { approvals_enabled: boolean }; after: { approvals_enabled: boolean } }; actor_id: string }>(
      `SELECT payload, actor_id FROM audit_log
        WHERE tenant_id = $1 AND event_type = 'tenant_config_changed'`,
      [tenantId]
    );
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0].actor_id).toBe("op-1");
    expect(audit.rows[0].payload.before.approvals_enabled).toBe(false);
    expect(audit.rows[0].payload.after.approvals_enabled).toBe(true);
  });

  it("rejects an empty config update", async () => {
    const response = await app.inject({
      method: "PATCH",
      url: "/ops/tenant-config",
      headers: {
        authorization: `Bearer ${OPERATOR_TOKEN}`,
        "content-type": "application/json",
      },
      payload: {},
    });

    expect(response.statusCode).toBe(400);
  });
});
