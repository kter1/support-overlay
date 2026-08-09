/**
 * The demo seed must stay in step with the schema. It previously referenced
 * columns and an issue state that the applied schema did not have.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createTestDb, TestDb } from "./helpers/db";

describe("demo seed", () => {
  let db: TestDb;

  beforeAll(async () => {
    db = await createTestDb();
    await db.seed();
  });

  afterAll(async () => {
    await db?.close();
  });

  it("loads the three demo scenarios", async () => {
    const result = await db.driver.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM issues`
    );
    expect(result.rows[0].n).toBe(3);
  });

  it("projects refund evidence the card model reads", async () => {
    const result = await db.driver.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM evidence_normalized
        WHERE refund_amount_cents IS NOT NULL`
    );
    expect(result.rows[0].n).toBeGreaterThan(0);
  });

  it("links every match result to its evidence row", async () => {
    const result = await db.driver.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM evidence_match_results
        WHERE evidence_normalized_id IS NULL`
    );
    expect(result.rows[0].n).toBe(0);
  });

  it("seeds no usable API credential", async () => {
    // Tokens come from the environment via scripts/seed.ts; a committed one
    // would be a published credential.
    const result = await db.driver.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM api_credentials`
    );
    expect(result.rows[0].n).toBe(0);
  });

  it("settles the reconciliation scenario so it can never be re-dispatched", async () => {
    const result = await db.driver.query<{ status: string; settled: string | null }>(
      `SELECT status, effect_settled_at AS settled FROM outbox_messages`
    );
    expect(result.rows[0].status).toBe("BLOCKED_OPERATOR");
    expect(result.rows[0].settled).not.toBeNull();
  });
});
