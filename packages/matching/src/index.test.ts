/**
 * Matching engine.
 *
 * The score is only as good as its explanation, so these assert on the notes
 * and matched fields as much as the band. Determinism is itself a requirement:
 * the same evidence must always produce the same result, or the audit trail
 * cannot be reconstructed after the fact.
 */
import { describe, it, expect } from "vitest";
import {
  computeMatch,
  MatchBand,
  DEFAULT_MATCH_CONFIG,
  EvidenceFacts,
  MATCH_ALGORITHM_VERSION,
} from "./index";

const NOW = new Date("2026-03-01T12:00:00Z");
const HOUR = 3_600_000;

/** A cleanly corroborated refund: linked, exact, succeeded, prompt. */
function perfect(overrides: Partial<EvidenceFacts> = {}): EvidenceFacts {
  return {
    refundAmountCents: 4999,
    orderTotalCents: 4999,
    currency: "usd",
    refundStatus: "succeeded",
    financialStatus: "refunded",
    chargeId: "ch_001",
    orderId: "order_001",
    ticketOrderReference: "order_001",
    refundCreatedAt: NOW,
    ticketCreatedAt: new Date(NOW.getTime() - 2 * HOUR),
    isSourceUnavailable: false,
    ...overrides,
  };
}

describe("computeMatch", () => {
  it("returns EXACT when every signal corroborates", () => {
    const result = computeMatch(perfect());

    expect(result.band).toBe(MatchBand.EXACT);
    expect(result.confidenceScore).toBe(1);
    expect(result.matchedFields).toEqual([
      "charge_linkage",
      "refund_amount",
      "currency",
      "refund_status",
      "timing",
    ]);
    expect(result.algorithmVersion).toBe(MATCH_ALGORITHM_VERSION);
  });

  it("is deterministic", () => {
    const a = computeMatch(perfect());
    const b = computeMatch(perfect());

    expect(a.confidenceScore).toBe(b.confidenceScore);
    expect(a.notes).toBe(b.notes);
  });

  it("explains what it matched on", () => {
    const result = computeMatch(perfect());

    expect(result.notes).toContain("order_001");
    expect(result.notes).toContain("$49.99");
    expect(result.notes).toContain("USD");
  });

  it("cannot reach HIGH when nothing links the records", () => {
    // Everything else agrees, but no identifier ties them together — resemblance
    // is not identity, and two unrelated refunds can share an amount and a day.
    const result = computeMatch(
      perfect({ ticketOrderReference: null, orderId: null, chargeId: null })
    );

    expect(result.band).toBe(MatchBand.MEDIUM);
    expect(result.matchedFields).not.toContain("charge_linkage");
    expect(result.notes).toContain("No order or charge reference");
  });

  it("holds the no-linkage ceiling as a property of the weights", () => {
    // Every non-linkage signal at full strength must still land below HIGH.
    const best = computeMatch(
      perfect({ ticketOrderReference: null, orderId: null, chargeId: null })
    );

    expect(best.confidenceScore).toBeLessThan(0.85);
  });

  it("treats a contradicting identifier as disqualifying", () => {
    const result = computeMatch(
      perfect({ ticketOrderReference: "order_999" })
    );

    expect(result.band).toBe(MatchBand.NO_MATCH);
    expect(result.confidenceScore).toBeLessThanOrEqual(0.2);
    expect(result.notes).toContain("does not match");
  });

  it("accepts an amount inside tolerance but ranks it below an exact match", () => {
    const exact = computeMatch(perfect());
    const near = computeMatch(
      perfect({ refundAmountCents: 4949, orderTotalCents: 4999 })
    );

    expect(near.matchedFields).toContain("refund_amount");
    expect(near.confidenceScore).toBeLessThan(exact.confidenceScore);
    expect(near.notes).toContain("within 2%");
  });

  it("treats a partial refund as weaker evidence, not a contradiction", () => {
    const partial = computeMatch(
      perfect({ refundAmountCents: 2000, orderTotalCents: 4999 })
    );
    const overpaid = computeMatch(
      perfect({ refundAmountCents: 9000, orderTotalCents: 4999 })
    );

    expect(partial.confidenceScore).toBeGreaterThan(overpaid.confidenceScore);
    expect(partial.notes).toContain("partial amount");
    expect(overpaid.notes).toContain("exceeds the order total");
  });

  it("does not credit a pending refund as a completed one", () => {
    const pending = computeMatch(perfect({ refundStatus: "pending" }));
    const succeeded = computeMatch(perfect());

    expect(pending.matchedFields).not.toContain("refund_status");
    expect(pending.confidenceScore).toBeLessThan(succeeded.confidenceScore);
    expect(pending.notes).toContain("still pending");
  });

  it("penalises a failed refund", () => {
    const result = computeMatch(perfect({ refundStatus: "failed" }));

    expect(result.confidenceScore).toBeLessThan(0.85);
    expect(result.notes).toContain("no completed refund is on record");
  });

  it("caps confidence at MEDIUM when a source record is unavailable", () => {
    const result = computeMatch(perfect({ isSourceUnavailable: true }));

    expect(result.confidenceScore).toBeLessThanOrEqual(0.79);
    expect(result.band).toBe(MatchBand.MEDIUM);
    expect(result.notes).toContain("no longer available");
  });

  it("weakens but does not disqualify a refund outside the timing window", () => {
    const result = computeMatch(
      perfect({ ticketCreatedAt: new Date(NOW.getTime() - 200 * HOUR) })
    );

    expect(result.band).not.toBe(MatchBand.NO_MATCH);
    expect(result.notes).toContain("outside the 72h window");
  });

  it("returns NO_MATCH when there is nothing to go on", () => {
    const result = computeMatch({});

    expect(result.band).toBe(MatchBand.NO_MATCH);
    expect(result.confidenceScore).toBe(0);
    expect(result.matchedFields).toEqual([]);
    expect(result.notes).toContain("No corroborating signals");
  });

  it("never describes the customer, only the records", () => {
    // Denial and low-confidence copy is agent-facing and must stay
    // non-accusatory; the policy engine has the same constraint.
    const cases = [
      computeMatch(perfect({ ticketOrderReference: "order_999" })),
      computeMatch(perfect({ refundStatus: "failed" })),
      computeMatch(perfect({ refundAmountCents: 9000 })),
      computeMatch({}),
    ];

    for (const result of cases) {
      expect(result.notes.toLowerCase()).not.toMatch(
        /fraud|abuse|suspicious|scam|liar|dishonest|customer is/
      );
    }
  });

  it("honours a tenant's amount tolerance", () => {
    const facts = perfect({ refundAmountCents: 4750, orderTotalCents: 4999 });

    const strict = computeMatch(facts, DEFAULT_MATCH_CONFIG);
    const lenient = computeMatch(facts, {
      ...DEFAULT_MATCH_CONFIG,
      amountTolerancePct: 10,
    });

    expect(strict.matchedFields).not.toContain("refund_amount");
    expect(lenient.matchedFields).toContain("refund_amount");
  });

  it("orders bands monotonically as evidence degrades", () => {
    const scores = [
      computeMatch(perfect()).confidenceScore,
      computeMatch(perfect({ refundAmountCents: 4949 })).confidenceScore,
      computeMatch(perfect({ refundStatus: "pending" })).confidenceScore,
      computeMatch(perfect({ ticketOrderReference: null, orderId: null, chargeId: null }))
        .confidenceScore,
      computeMatch({}).confidenceScore,
    ];

    for (let i = 1; i < scores.length; i++) {
      expect(scores[i]).toBeLessThanOrEqual(scores[i - 1]);
    }
  });
});
