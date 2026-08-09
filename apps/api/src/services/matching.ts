/**
 * @support-overlay/api — evidence matching
 *
 * Turns the normalized evidence rows for an issue into a stored match result.
 *
 * This is what makes the confidence band on the card a computed fact rather
 * than seed data. It runs whenever evidence changes — a Stripe webhook, an
 * operator refresh — so the band reflects what the system currently knows.
 */
import { DbClient, query } from "../db/pool";
import { computeMatch, EvidenceFacts, MatchConfig } from "@iisl/matching";

interface EvidenceRow {
  id: string;
  source_system: string;
  source_record_id: string;
  refund_status: string | null;
  refund_amount_cents: number | null;
  refund_currency: string | null;
  refund_id: string | null;
  order_id: string | null;
  charge_id: string | null;
  normalized_data: Record<string, unknown> | null;
  fetched_at: string;
  is_source_unavailable: boolean;
}

export interface RecomputeResult {
  band: string;
  confidenceScore: number;
  matchedFields: string[];
  notes: string;
}

/**
 * Recompute and persist the match result for one issue.
 *
 * Returns null when the issue has no evidence at all — there is nothing to
 * match, and writing a NO_MATCH row would imply we looked and found a
 * contradiction rather than that we have not looked yet.
 */
export async function recomputeMatchForIssue(
  tenantId: string,
  issueId: string,
  client?: DbClient
): Promise<RecomputeResult | null> {
  const run = client ?? { query };

  const evidenceResult = await run.query<EvidenceRow>(
    `SELECT id, source_system, source_record_id, refund_status,
            refund_amount_cents, refund_currency, refund_id, order_id, charge_id,
            normalized_data, fetched_at, is_source_unavailable
       FROM evidence_normalized
      WHERE tenant_id = $1 AND issue_id = $2
      ORDER BY fetched_at DESC`,
    [tenantId, issueId]
  );

  if (evidenceResult.rows.length === 0) return null;

  const configResult = await run.query<{
    refund_amount_tolerance_pct: string;
  }>(
    `SELECT refund_amount_tolerance_pct FROM tenant_config WHERE tenant_id = $1`,
    [tenantId]
  );

  const ticketResult = await run.query<{ created_at: string }>(
    `SELECT created_at FROM issue_tickets
      WHERE tenant_id = $1 AND issue_id = $2 AND is_primary = true
      LIMIT 1`,
    [tenantId, issueId]
  );

  const facts = buildFacts(
    evidenceResult.rows,
    ticketResult.rows[0]?.created_at ?? null
  );

  const config: Partial<MatchConfig> = {};
  const tolerance = parseFloat(
    configResult.rows[0]?.refund_amount_tolerance_pct ?? ""
  );
  if (Number.isFinite(tolerance)) config.amountTolerancePct = tolerance;

  const result = computeMatch(facts, {
    amountTolerancePct: config.amountTolerancePct ?? 2,
    timingWindowHours: 72,
  });

  // The payment-side row is the anchor: it is the record a refund actually
  // exists on, so the match result hangs off it.
  const anchor =
    evidenceResult.rows.find((r) => r.source_system === "stripe") ??
    evidenceResult.rows[0];

  await run.query(
    `INSERT INTO evidence_match_results
       (tenant_id, issue_id, evidence_normalized_id, match_algorithm_version,
        match_band, confidence_score, matched_fields, match_notes)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      tenantId,
      issueId,
      anchor.id,
      result.algorithmVersion,
      result.band,
      result.confidenceScore,
      result.matchedFields,
      result.notes,
    ]
  );

  return {
    band: result.band,
    confidenceScore: result.confidenceScore,
    matchedFields: result.matchedFields,
    notes: result.notes,
  };
}

/**
 * Collapse per-provider evidence rows into the flat set of facts the matcher
 * compares. Payment fields come from the payment provider, order fields from
 * commerce — taking an order total from the refund row would compare a value
 * against itself and manufacture agreement.
 */
function buildFacts(
  rows: EvidenceRow[],
  ticketCreatedAt: string | null
): EvidenceFacts {
  const stripe = rows.find((r) => r.source_system === "stripe");
  const shopify = rows.find((r) => r.source_system === "shopify");

  const shopifyData = (shopify?.normalized_data ?? {}) as Record<string, unknown>;
  const stripeData = (stripe?.normalized_data ?? {}) as Record<string, unknown>;

  const orderTotalCents =
    numberOf(shopifyData.shopifyOrderTotal) ??
    (shopify?.refund_amount_cents ?? null);

  return {
    refundAmountCents: stripe?.refund_amount_cents ?? null,
    orderTotalCents,
    currency: stripe?.refund_currency ?? stringOf(shopifyData.shopifyOrderCurrency),
    refundStatus: stripe?.refund_status ?? null,
    financialStatus: stringOf(shopifyData.shopifyFinancialStatus),
    chargeId: stripe?.charge_id ?? stringOf(stripeData.stripeChargeId),
    orderId: shopify?.order_id ?? shopify?.source_record_id ?? null,
    // The ticket's own reference to an order. Absent that, fall back to the
    // commerce record so a Stripe-only issue still has something to link to.
    ticketOrderReference:
      shopify?.order_id ?? shopify?.source_record_id ?? stripe?.charge_id ?? null,
    refundCreatedAt: stripe ? new Date(stripe.fetched_at) : null,
    orderCreatedAt: shopify ? new Date(shopify.fetched_at) : null,
    ticketCreatedAt: ticketCreatedAt ? new Date(ticketCreatedAt) : null,
    isSourceUnavailable: rows.some((r) => r.is_source_unavailable),
  };
}

function numberOf(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function stringOf(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}
