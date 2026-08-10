/**
 * Match results are computed, not seeded.
 *
 * The confidence band on the card used to exist only in db/seed.sql — every
 * runtime reference was a LEFT JOIN against a table nothing ever wrote, so a
 * live tenant would have shown null. These tests assert the band is derived
 * from evidence in the database.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createTestDb, createTenant, createIssue, TestDb } from "./helpers/db";
import { recomputeMatchForIssue } from "../src/services/matching";

describe("evidence matching", () => {
  let db: TestDb;
  let tenantId: string;
  let issueId: string;

  beforeEach(async () => {
    db = await createTestDb();
    tenantId = await createTenant(db);
    issueId = await createIssue(db, tenantId);
  });

  afterEach(async () => {
    await db.close();
  });

  async function addStripeEvidence(opts: {
    amountCents?: number;
    status?: string;
    chargeId?: string;
    currency?: string;
  } = {}): Promise<void> {
    await db.driver.query(
      `INSERT INTO evidence_normalized
         (tenant_id, issue_id, source_system, source_record_id, normalizer_version,
          normalized_data, refund_status, refund_amount_cents, refund_currency,
          refund_id, charge_id, fetched_at)
       VALUES ($1, $2, 'stripe', 're_1', 'v1', '{}', $3, $4, $5, 're_1', $6, now())`,
      [
        tenantId,
        issueId,
        opts.status ?? "succeeded",
        opts.amountCents ?? 4999,
        opts.currency ?? "usd",
        opts.chargeId ?? "ch_1",
      ]
    );
  }

  async function addShopifyEvidence(opts: {
    orderTotalCents?: number;
    financialStatus?: string;
    orderId?: string;
    unavailable?: boolean;
  } = {}): Promise<void> {
    await db.driver.query(
      `INSERT INTO evidence_normalized
         (tenant_id, issue_id, source_system, source_record_id, normalizer_version,
          normalized_data, order_id, fetched_at, is_source_unavailable)
       VALUES ($1, $2, 'shopify', $3, 'v1', $4, $3, now(), $5)`,
      [
        tenantId,
        issueId,
        opts.orderId ?? "ch_1",
        JSON.stringify({
          shopifyOrderTotal: opts.orderTotalCents ?? 4999,
          shopifyFinancialStatus: opts.financialStatus ?? "refunded",
          shopifyOrderCurrency: "usd",
        }),
        opts.unavailable ?? false,
      ]
    );
  }

  async function storedMatch() {
    const result = await db.driver.query<{
      match_band: string;
      confidence_score: string;
      matched_fields: string[];
      match_notes: string;
      match_algorithm_version: string;
    }>(
      `SELECT match_band, confidence_score, matched_fields, match_notes,
              match_algorithm_version
         FROM evidence_match_results
        WHERE issue_id = $1
        ORDER BY computed_at DESC
        LIMIT 1`,
      [issueId]
    );
    return result.rows[0];
  }

  it("returns null when there is no evidence yet", async () => {
    // Not the same as NO_MATCH: we have not looked, rather than looked and
    // found a contradiction.
    expect(await recomputeMatchForIssue(tenantId, issueId)).toBeNull();

    const rows = await db.driver.query(
      `SELECT id FROM evidence_match_results WHERE issue_id = $1`,
      [issueId]
    );
    expect(rows.rows).toHaveLength(0);
  });

  it("persists a computed band from corroborating evidence", async () => {
    await addStripeEvidence();
    await addShopifyEvidence();

    const result = await recomputeMatchForIssue(tenantId, issueId);
    expect(result).not.toBeNull();

    const stored = await storedMatch();
    expect(stored.match_band).toBe("EXACT");
    expect(parseFloat(stored.confidence_score)).toBeGreaterThan(0.9);
    expect(stored.matched_fields).toContain("refund_amount");
    expect(stored.match_algorithm_version).toBe("match_v1");
  });

  it("stores an explanation an agent can act on", async () => {
    await addStripeEvidence();
    await addShopifyEvidence();

    await recomputeMatchForIssue(tenantId, issueId);

    const stored = await storedMatch();
    expect(stored.match_notes).toContain("$49.99");
    expect(stored.match_notes.length).toBeGreaterThan(20);
  });

  it("lowers the band when the amounts disagree", async () => {
    await addStripeEvidence({ amountCents: 500 });
    await addShopifyEvidence({ orderTotalCents: 4999 });

    await recomputeMatchForIssue(tenantId, issueId);

    const stored = await storedMatch();
    expect(["MEDIUM", "LOW", "NO_MATCH"]).toContain(stored.match_band);
    expect(stored.match_notes).toContain("partial amount");
  });

  it("caps the band when a source record is unavailable", async () => {
    await addStripeEvidence();
    await addShopifyEvidence({ unavailable: true });

    await recomputeMatchForIssue(tenantId, issueId);

    const stored = await storedMatch();
    expect(parseFloat(stored.confidence_score)).toBeLessThanOrEqual(0.79);
    expect(stored.match_notes).toContain("no longer available");
  });

  it("does not credit a pending refund", async () => {
    await addStripeEvidence({ status: "pending" });
    await addShopifyEvidence();

    await recomputeMatchForIssue(tenantId, issueId);

    const stored = await storedMatch();
    expect(stored.matched_fields).not.toContain("refund_status");
    expect(stored.match_notes).toContain("still pending");
  });

  it("honours the tenant's configured amount tolerance", async () => {
    await db.driver.query(
      `UPDATE tenant_config SET refund_amount_tolerance_pct = 25 WHERE tenant_id = $1`,
      [tenantId]
    );
    await addStripeEvidence({ amountCents: 4000 });
    await addShopifyEvidence({ orderTotalCents: 4999 });

    await recomputeMatchForIssue(tenantId, issueId);

    const stored = await storedMatch();
    expect(stored.matched_fields).toContain("refund_amount");
  });

  it("keeps every recompute as history rather than overwriting", async () => {
    await addStripeEvidence();
    await addShopifyEvidence();

    await recomputeMatchForIssue(tenantId, issueId);
    await recomputeMatchForIssue(tenantId, issueId);

    const rows = await db.driver.query(
      `SELECT id FROM evidence_match_results WHERE issue_id = $1`,
      [issueId]
    );
    // Bands change as evidence arrives; the sequence is part of the record.
    expect(rows.rows).toHaveLength(2);
  });
});
