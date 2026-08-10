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

  it("loads every demo scenario", async () => {
    // Four scenarios, five issues: the duplicate-refund scenario needs two,
    // since the point of it is what one ticket knows about another.
    const result = await db.driver.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM issues`
    );
    expect(result.rows[0].n).toBe(5);

    const tickets = await db.driver.query<{ zendesk_ticket_id: string }>(
      `SELECT zendesk_ticket_id FROM issue_tickets ORDER BY zendesk_ticket_id`
    );
    expect(tickets.rows.map((r) => r.zendesk_ticket_id)).toEqual([
      "10001",
      "10002",
      "10003",
      "10004",
      "10005",
    ]);
  });

  it("seeds a duplicate-refund case the history layer will catch", async () => {
    // The seeded scenario is only meaningful if the two tickets share a
    // customer and name the same order, and the earlier one records a refund
    // the provider confirmed. Any of those drifting silently turns the demo
    // into a card with no warning on it.
    const result = await db.driver.query<{
      zendesk_ticket_id: string;
      customer_id: string;
      order_reference: string | null;
      refund_status: string | null;
    }>(
      `SELECT t.zendesk_ticket_id, i.customer_id, ctx.order_reference,
              cs.refund_status
         FROM issues i
         JOIN issue_tickets t ON t.issue_id = i.id
         LEFT JOIN issue_context ctx ON ctx.issue_id = i.id
         LEFT JOIN issue_card_state cs ON cs.issue_id = i.id
        WHERE t.zendesk_ticket_id IN ('10004', '10005')
        ORDER BY t.zendesk_ticket_id`
    );

    const [earlier, later] = result.rows;
    expect(earlier.customer_id).toBe(later.customer_id);
    expect(earlier.order_reference).toBe("1001");
    expect(later.order_reference).toBe("1001");
    expect(earlier.refund_status).toBe("succeeded");
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
