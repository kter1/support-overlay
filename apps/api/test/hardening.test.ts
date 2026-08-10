/**
 * Request handling hardening.
 *
 * Two properties matter here. Bad input is rejected with a description of what
 * was wrong with *the request*, and internal failures never describe the
 * system: routes used to return thrown error messages verbatim, which put raw
 * Postgres text — table and constraint names — in front of any caller who could
 * trigger a 500.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Fastify, { FastifyInstance } from "fastify";
import { createTestDb, createTenant, createIssue, TestDb } from "./helpers/db";
import { hashToken } from "../src/middleware/auth";
import { correlationIdMiddleware } from "../src/middleware/correlationId";
import { registerErrorHandling, ApiError } from "../src/middleware/errors";
import { actionsRoutes } from "../src/routes/actions";

const AGENT_TOKEN = "agent-token-hardening";

function buildApp(): FastifyInstance {
  const app = Fastify();
  app.addHook("onRequest", correlationIdMiddleware);
  registerErrorHandling(app);
  app.register(actionsRoutes, { prefix: "/api/v1/actions" });
  return app;
}

describe("request hardening", () => {
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
       VALUES ($1, 'agent', $2, 'agent-1')`,
      [tenantId, hashToken(AGENT_TOKEN)]
    );

    app = buildApp();
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    await db.close();
  });

  const post = (payload: unknown, token = AGENT_TOKEN) =>
    app.inject({
      method: "POST",
      url: "/api/v1/actions",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      payload: payload as object,
    });

  it("rejects a body with the wrong shape and says which field", async () => {
    const response = await post({ action_type: "close_confirmed" });

    expect(response.statusCode).toBe(400);
    const body = response.json();
    expect(body.error).toContain("not valid");
    const fields = body.details.map((d: { field: string }) => d.field);
    expect(fields).toContain("issue_id");
    expect(fields).toContain("idempotency_key");
  });

  it("rejects an unknown action type by listing the valid ones", async () => {
    const response = await post({
      action_type: "delete_everything",
      issue_id: issueId,
      idempotency_key: "key-12345678",
    });

    expect(response.statusCode).toBe(400);
    expect(JSON.stringify(response.json())).toContain("close_confirmed");
  });

  it("rejects a non-UUID issue id", async () => {
    const response = await post({
      action_type: "close_confirmed",
      issue_id: "'; DROP TABLE issues; --",
      idempotency_key: "key-12345678",
    });

    expect(response.statusCode).toBe(400);

    // And the table is still there.
    const issues = await db.driver.query(`SELECT id FROM issues`);
    expect(issues.rows.length).toBeGreaterThan(0);
  });

  it("bounds the idempotency key", async () => {
    const response = await post({
      action_type: "close_confirmed",
      issue_id: issueId,
      idempotency_key: "x".repeat(5000),
    });

    expect(response.statusCode).toBe(400);
  });

  it("rejects malformed JSON without echoing the parse error", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/actions",
      headers: {
        authorization: `Bearer ${AGENT_TOKEN}`,
        "content-type": "application/json",
      },
      payload: "{not json",
    });

    expect(response.statusCode).toBe(400);
    expect(JSON.stringify(response.json())).not.toContain("JSON.parse");
  });

  it("never leaks internal detail from an unexpected failure", async () => {
    const failing = Fastify();
    failing.addHook("onRequest", correlationIdMiddleware);
    registerErrorHandling(failing);
    failing.get("/boom", async () => {
      throw new Error(
        'duplicate key value violates unique constraint "uix_action_executions_approval"'
      );
    });
    await failing.ready();

    const response = await failing.inject({ method: "GET", url: "/boom" });
    const body = response.json();

    expect(response.statusCode).toBe(500);
    expect(body.error).toBe("Internal error");
    expect(JSON.stringify(body)).not.toContain("unique constraint");
    expect(JSON.stringify(body)).not.toContain("uix_action_executions");
    // The caller gets a handle for support instead of the detail itself.
    expect(body.correlation_id).toBeTruthy();
    expect(body.hint).toContain(body.correlation_id);

    await failing.close();
  });

  it("passes through messages that were explicitly marked safe", async () => {
    const explicit = Fastify();
    explicit.addHook("onRequest", correlationIdMiddleware);
    registerErrorHandling(explicit);
    explicit.get("/known", async () => {
      throw new ApiError(409, "Approval already resolved", "Reload the ticket.");
    });
    await explicit.ready();

    const response = await explicit.inject({ method: "GET", url: "/known" });

    expect(response.statusCode).toBe(409);
    expect(response.json().error).toBe("Approval already resolved");
    expect(response.json().hint).toBe("Reload the ticket.");

    await explicit.close();
  });

  it("returns a structured 404 for an unknown endpoint", async () => {
    const response = await app.inject({ method: "GET", url: "/nope" });

    expect(response.statusCode).toBe(404);
    expect(response.json().error).toBe("No such endpoint");
    expect(response.json().correlation_id).toBeTruthy();
  });

  it("echoes the caller's correlation id so logs can be joined up", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/actions",
      headers: {
        authorization: `Bearer ${AGENT_TOKEN}`,
        "content-type": "application/json",
        "x-correlation-id": "trace-abc-123",
      },
      payload: {},
    });

    expect(response.headers["x-correlation-id"]).toBe("trace-abc-123");
    expect(response.json().correlation_id).toBe("trace-abc-123");
  });

  it("accepts a valid body", async () => {
    const response = await post({
      action_type: "close_confirmed",
      issue_id: issueId,
      idempotency_key: "valid-key-1234",
      action_params: { zendesk_ticket_id: "10001" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().outcome).toBeTruthy();
  });
});
