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
import { seedDemoProviderRecords } from "./demo-records";
import {
  loadCustomerCorpus,
  resolveSpan,
  EMPTY_CORPUS,
  CustomerCorpus,
} from "../../apps/api/src/services/corpus";

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
  // The provider side of the demo. Without it a hover over "8/1" or "$39" has
  // nothing to find, which is the exact moment the overlay exists to show.
  seedDemoProviderRecords();

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

  // Resolve every span the way production does — against the customer's real
  // records, through the same code path. A demo that resolved by some other
  // route would be a demo of something the product does not do.
  const corpusByIssue = new Map<string, CustomerCorpus>();
  for (const issueId of byIssue.keys()) {
    const customerId = await customerFor(client, issueId);
    corpusByIssue.set(
      issueId,
      customerId
        ? await loadCustomerCorpus(customerId, process.env.SHOPIFY_SHOP ?? "demo")
        : EMPTY_CORPUS
    );
  }

  for (const [issueId, rows] of byIssue) {
    const sources: TextSource[] = rows.map((row) => ({
      id: row.source_id,
      kind: row.kind,
      authorRole: row.author_role,
      createdAt: new Date(row.created_at),
      text: row.body,
    }));

    const context = readConversation(sources);
    const corpus = corpusByIssue.get(issueId) ?? EMPTY_CORPUS;

    const annotations = context.signals.map((signal) => {
      const resolution = resolveSpan(signal, corpus, new Map());

      return {
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
        candidates: resolution.candidates,
        matched_on: resolution.matchedOn,
      };
    });

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

/** The customer an issue belongs to, or null for an anonymous ticket. */
async function customerFor(
  client: SeedClient,
  issueId: string
): Promise<string | null> {
  const result = (await client.query(
    `SELECT customer_id FROM issues WHERE id = $1`,
    [issueId]
  )) as { rows: Array<{ customer_id: string | null }> };

  const customerId = result.rows[0]?.customer_id ?? null;
  return customerId && customerId.trim() !== "" ? customerId : null;
}
