/**
 * @file scripts/lib/seed-annotations.ts
 * @description Produce the demo's annotations by running the real extractor.
 *
 * `db/seed.sql` seeds the message bodies but not the spans. Offsets typed by
 * hand are correct on the day they are typed and silently wrong after any
 * change to a rule — and a demo that highlights the wrong words is worse than
 * one that highlights none, because it looks authoritative either way.
 *
 * Shared between `scripts/seed.ts` and the test fixture so both arrive at the
 * same state. When they diverged, tests asserted against a database no user
 * would ever have.
 */
import { readConversation, TextSource } from "@iisl/extraction";

/** The slice of a database client this needs. */
export interface SeedClient {
  query(sql: string, params?: unknown[]): Promise<{ rows: unknown[] }>;
}

interface MessageRow {
  tenant_id: string;
  issue_id: string;
  source_id: string;
  kind: TextSource["kind"];
  author_role: "customer" | "agent";
  body: string;
  created_at: Date | string;
}

/**
 * Extract from every seeded conversation and store the resulting spans.
 *
 * Returns the number of conversations processed so callers can report it.
 */
export async function generateSeedAnnotations(client: SeedClient): Promise<number> {
  const messages = (await client.query(
    `SELECT tenant_id, issue_id, source_id, kind, author_role, body, created_at
       FROM issue_messages
      WHERE body IS NOT NULL
      ORDER BY issue_id, position`
  )) as { rows: MessageRow[] };

  const byIssue = new Map<string, MessageRow[]>();
  for (const row of messages.rows) {
    const rows = byIssue.get(row.issue_id) ?? [];
    rows.push(row);
    byIssue.set(row.issue_id, rows);
  }

  // The demo already has provider evidence seeded. Attaching it to the spans
  // that name it is what makes a click on "order #1001" answer the question it
  // raises; without it the popover can only report that nothing was found,
  // which is true of the fixture but not of the product.
  const resolutions = await loadResolutions(client);

  for (const [issueId, rows] of byIssue) {
    const sources: TextSource[] = rows.map((row) => ({
      id: row.source_id,
      kind: row.kind,
      authorRole: row.author_role,
      createdAt: new Date(row.created_at),
      text: row.body,
    }));

    const context = readConversation(sources);

    const annotations = context.signals.map((signal) => ({
      kind: signal.kind,
      display: signal.display,
      confidence: signal.confidence,
      author_role: signal.authorRole,
      source_id: signal.provenance.sourceId,
      source_kind: signal.provenance.sourceKind,
      start: signal.provenance.start,
      end: signal.provenance.end,
      excerpt: signal.provenance.excerpt,
      rule: signal.provenance.rule,
      // The identifier as written, kept whether or not a provider confirmed
      // it: history matches on what the customer typed, so a span must be
      // flaggable even when the lookup found nothing.
      reference: isReference(signal.kind)
        ? (signal.value as { id: string }).id
        : null,
      resolved: isReference(signal.kind)
        ? resolutions.get(issueId)?.get((signal.value as { id: string }).id) ?? null
        : null,
    }));

    // Insert, not update: only two of the seeded issues carried a context row,
    // so an UPDATE silently left the rest with no thread to render.
    await client.query(
      `INSERT INTO issue_context
         (tenant_id, issue_id, extractor_version, payment_reference,
          order_reference, claimed_amount_cents, claimed_currency, primary_ask,
          annotations, message_count)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT (tenant_id, issue_id) DO UPDATE SET
         extractor_version = EXCLUDED.extractor_version,
         annotations       = EXCLUDED.annotations,
         message_count     = EXCLUDED.message_count`,
      [
        rows[0].tenant_id,
        issueId,
        context.extractorVersion,
        context.leads.paymentReference,
        context.leads.orderReference,
        context.leads.claimedAmountCents,
        context.leads.claimedCurrency,
        context.leads.primaryAsk?.value.ask ?? null,
        JSON.stringify(annotations),
        context.messageCount,
      ]
    );
  }

  return byIssue.size;
}

function isReference(kind: string): boolean {
  return kind === "order_reference" || kind === "payment_reference";
}

interface ResolvedReference {
  provider: string;
  recordType: string;
  reference: string;
  status: string | null;
  amountCents: number | null;
  currency: string | null;
}

interface EvidenceRow {
  issue_id: string;
  source_system: string;
  refund_status: string | null;
  refund_amount_cents: number | null;
  refund_currency: string | null;
  order_id: string | null;
  charge_id: string | null;
  normalized_data: Record<string, unknown> | null;
}

/**
 * Index the seeded provider evidence by the reference a customer would write.
 *
 * Keyed by both the provider's id and the order *name* the customer sees,
 * because those differ and the text can carry either.
 */
async function loadResolutions(
  client: SeedClient
): Promise<Map<string, Map<string, ResolvedReference>>> {
  const result = (await client.query(
    `SELECT issue_id, source_system, refund_status, refund_amount_cents,
            refund_currency, order_id, charge_id, normalized_data
       FROM evidence_normalized`
  )) as { rows: EvidenceRow[] };

  const byIssue = new Map<string, Map<string, ResolvedReference>>();

  for (const row of result.rows) {
    const forIssue = byIssue.get(row.issue_id) ?? new Map<string, ResolvedReference>();
    const data = row.normalized_data ?? {};
    const orderName = typeof data.shopifyOrderName === "string" ? data.shopifyOrderName : null;

    if (row.charge_id) {
      forIssue.set(row.charge_id, {
        provider: "stripe",
        recordType: "charge",
        reference: row.charge_id,
        status: row.refund_status,
        amountCents: row.refund_amount_cents,
        currency: row.refund_currency,
      });
    }

    for (const key of [row.order_id, orderName?.replace(/^#/, "")]) {
      if (!key) continue;
      forIssue.set(key, {
        provider: "shopify",
        recordType: "order",
        reference: orderName ?? key,
        status:
          typeof data.shopifyFinancialStatus === "string"
            ? data.shopifyFinancialStatus
            : row.refund_status,
        amountCents:
          typeof data.shopifyOrderTotal === "number"
            ? data.shopifyOrderTotal
            : row.refund_amount_cents,
        currency: row.refund_currency,
      });
    }

    byIssue.set(row.issue_id, forIssue);
  }

  return byIssue;
}
