/**
 * Authentication and tenant isolation.
 *
 * Before this, every route except /ops derived tenancy from a client-supplied
 * x-tenant-id header, and the approval endpoint took the approving manager's id
 * from the request body. These tests exist so neither can come back.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createTestDb, createTenant, TestDb } from "./helpers/db";
import { hashToken, resolveToken, isManager } from "../src/middleware/auth";

async function grantToken(
  db: TestDb,
  tenantId: string,
  role: "agent" | "operator" | "webhook",
  token: string,
  principalId: string
): Promise<void> {
  await db.driver.query(
    `INSERT INTO api_credentials (tenant_id, role, token_sha256, principal_id)
     VALUES ($1, $2, $3, $4)`,
    [tenantId, role, hashToken(token), principalId]
  );
}

describe("authentication", () => {
  let db: TestDb;
  let tenantA: string;
  let tenantB: string;

  beforeEach(async () => {
    db = await createTestDb();
    tenantA = await createTenant(db);
    tenantB = await createTenant(db);
  });

  afterEach(async () => {
    await db.close();
  });

  it("resolves a token to its own tenant", async () => {
    await grantToken(db, tenantA, "agent", "token-a", "agent-a");

    const auth = await resolveToken("token-a");

    expect(auth).not.toBeNull();
    expect(auth?.tenantId).toBe(tenantA);
    expect(auth?.role).toBe("agent");
    expect(auth?.principalId).toBe("agent-a");
  });

  it("never lets one tenant's token resolve to another tenant", async () => {
    await grantToken(db, tenantA, "agent", "token-a", "agent-a");
    await grantToken(db, tenantB, "agent", "token-b", "agent-b");

    expect((await resolveToken("token-a"))?.tenantId).toBe(tenantA);
    expect((await resolveToken("token-b"))?.tenantId).toBe(tenantB);
    expect(tenantA).not.toBe(tenantB);
  });

  it("rejects an unknown token", async () => {
    expect(await resolveToken("never-issued")).toBeNull();
  });

  it("rejects a revoked token", async () => {
    await grantToken(db, tenantA, "agent", "token-revoked", "agent-a");
    await db.driver.query(
      `UPDATE api_credentials SET revoked_at = now() WHERE token_sha256 = $1`,
      [hashToken("token-revoked")]
    );

    expect(await resolveToken("token-revoked")).toBeNull();
  });

  it("rejects a deactivated token", async () => {
    await grantToken(db, tenantA, "agent", "token-inactive", "agent-a");
    await db.driver.query(
      `UPDATE api_credentials SET is_active = false WHERE token_sha256 = $1`,
      [hashToken("token-inactive")]
    );

    expect(await resolveToken("token-inactive")).toBeNull();
  });

  it("stores only the hash, never the token", async () => {
    await grantToken(db, tenantA, "agent", "super-secret-token", "agent-a");

    const result = await db.driver.query<{ token_sha256: string }>(
      `SELECT token_sha256 FROM api_credentials WHERE tenant_id = $1`,
      [tenantA]
    );

    expect(result.rows[0].token_sha256).not.toContain("super-secret-token");
    expect(result.rows[0].token_sha256).toHaveLength(64);
  });

  it("keeps a tenant's roles distinct", async () => {
    await grantToken(db, tenantA, "agent", "tok-agent", "agent-a");
    await grantToken(db, tenantA, "operator", "tok-operator", "op-a");
    await grantToken(db, tenantA, "webhook", "tok-webhook", "hook-a");

    expect((await resolveToken("tok-agent"))?.role).toBe("agent");
    expect((await resolveToken("tok-operator"))?.role).toBe("operator");
    expect((await resolveToken("tok-webhook"))?.role).toBe("webhook");
  });
});

describe("approval authority", () => {
  let db: TestDb;
  let tenantId: string;

  beforeEach(async () => {
    db = await createTestDb();
    tenantId = await createTenant(db, { approvalsEnabled: true });
  });

  afterEach(async () => {
    await db.close();
  });

  it("recognises a granted manager", async () => {
    await db.driver.query(
      `INSERT INTO manager_grants (tenant_id, principal_id) VALUES ($1, $2)`,
      [tenantId, "manager-1"]
    );

    expect(await isManager(tenantId, "manager-1")).toBe(true);
  });

  it("refuses a principal with no grant", async () => {
    // The old endpoint accepted any manager_id in the body, so this was the
    // whole approval gate: name a manager and you were one.
    expect(await isManager(tenantId, "manager-i-made-up")).toBe(false);
  });

  it("refuses a manager granted on a different tenant", async () => {
    const otherTenant = await createTenant(db);
    await db.driver.query(
      `INSERT INTO manager_grants (tenant_id, principal_id) VALUES ($1, $2)`,
      [otherTenant, "manager-x"]
    );

    expect(await isManager(tenantId, "manager-x")).toBe(false);
  });

  it("refuses a deactivated grant", async () => {
    await db.driver.query(
      `INSERT INTO manager_grants (tenant_id, principal_id, is_active)
       VALUES ($1, $2, false)`,
      [tenantId, "manager-retired"]
    );

    expect(await isManager(tenantId, "manager-retired")).toBe(false);
  });
});
