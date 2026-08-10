/**
 * @support-overlay/api — reading extracted conversation context
 *
 * The extractor writes `issue_context`; this reads it back for the card. Kept
 * separate from ingestion so a read path never pulls in the connectors.
 *
 * The card shows highlights rather than the raw thread. Each one carries the
 * exact text it came from, because "we think the customer wants a refund" is
 * only actionable next to the sentence that says so — an agent has to be able
 * to check the claim in one glance, and a wrong highlight has to be visibly
 * wrong rather than quietly authoritative.
 */
import { query } from "../db/pool";

export interface ContextHighlight {
  kind: string;
  display: string;
  confidence: number;
  authorRole: string;
  sourceId: string;
  sourceKind: string;
  excerpt: string;
  rule: string;
}

export interface IssueContext {
  extractorVersion: string;
  paymentReference: string | null;
  orderReference: string | null;
  claimedAmountCents: number | null;
  claimedCurrency: string | null;
  primaryAsk: string | null;
  highlights: ContextHighlight[];
  messageCount: number;
  extractedAt: string;
}

interface StoredHighlight {
  kind?: string;
  display?: string;
  confidence?: number;
  author_role?: string;
  source_id?: string;
  source_kind?: string;
  excerpt?: string;
  rule?: string;
}

interface ContextRow {
  extractor_version: string;
  payment_reference: string | null;
  order_reference: string | null;
  claimed_amount_cents: number | null;
  claimed_currency: string | null;
  primary_ask: string | null;
  highlights: StoredHighlight[] | null;
  message_count: number;
  extracted_at: string;
}

/**
 * Load the current extraction for an issue.
 *
 * Null when the ticket has not been ingested — an issue can exist before
 * extraction runs, and the card must render either way.
 */
export async function loadIssueContext(
  tenantId: string,
  issueId: string
): Promise<IssueContext | null> {
  const result = await query<ContextRow>(
    `SELECT extractor_version, payment_reference, order_reference,
            claimed_amount_cents, claimed_currency, primary_ask,
            highlights, message_count, extracted_at
       FROM issue_context
      WHERE tenant_id = $1 AND issue_id = $2`,
    [tenantId, issueId]
  );

  const row = result.rows[0];
  if (!row) return null;

  return {
    extractorVersion: row.extractor_version,
    paymentReference: row.payment_reference,
    orderReference: row.order_reference,
    claimedAmountCents: row.claimed_amount_cents,
    claimedCurrency: row.claimed_currency,
    primaryAsk: row.primary_ask,
    // Stored as JSONB written by an earlier extractor version, so every field
    // is treated as optional: a highlight missing its provenance is dropped
    // rather than rendered as an unsourced claim.
    highlights: (row.highlights ?? []).flatMap(toHighlight),
    messageCount: row.message_count,
    extractedAt: row.extracted_at,
  };
}

function toHighlight(stored: StoredHighlight): ContextHighlight[] {
  if (!stored.kind || !stored.display || !stored.excerpt) return [];

  return [
    {
      kind: stored.kind,
      display: stored.display,
      confidence: typeof stored.confidence === "number" ? stored.confidence : 0,
      authorRole: stored.author_role ?? "unknown",
      sourceId: stored.source_id ?? "",
      sourceKind: stored.source_kind ?? "comment",
      excerpt: stored.excerpt,
      rule: stored.rule ?? "",
    },
  ];
}
