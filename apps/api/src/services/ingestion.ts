/**
 * @support-overlay/api — evidence ingestion
 *
 * Stage one of the pipeline: acquire evidence, so the rest of the system has
 * something to reason about.
 *
 *   ingest → match → policy → execute
 *
 * Until this existed, evidence rows came only from db/seed.sql. A real ticket
 * produced an issue, a ticket link, and an empty card — the matcher had nothing
 * to compare and the card had nothing to show.
 *
 * The flow:
 *   1. Read the ticket thread from Zendesk.
 *   2. Extract points of importance — amounts, dates, order and payment
 *      references, and what the customer is asking for — each carrying the span
 *      of text it came from.
 *   3. Use the strongest reference to look up the real records in Stripe and
 *      Shopify.
 *   4. Persist raw snapshots and normalized evidence.
 *   5. Recompute the match band.
 *
 * Every step is recorded. When the card later says HIGH confidence, the chain
 * back to "the customer wrote ch_3AbC… in their second reply" is intact.
 */
import { PoolClient } from "pg";
import { createHash } from "crypto";
import { query, withTransaction } from "../db/pool";
import { writeAuditEventTx, AuditEventType } from "./audit";
import { recomputeMatchForIssue } from "./matching";
import { rebuildCardState } from "../workers/outboxWorker";
import {
  ZendeskAdapter,
  StripeAdapter,
  ShopifyAdapter,
  SourceUnavailableError,
  TicketConversation,
} from "@iisl/connectors";
import {
  readConversation,
  ConversationContext,
  TextSource,
  EXTRACTOR_VERSION,
} from "@iisl/extraction";
import { ActorType, SourceSystem, isTimeoutError } from "@iisl/shared";
import {
  loadCustomerCorpus,
  resolveSpan,
  CustomerCorpus,
  CandidateRecord,
  EMPTY_CORPUS,
} from "./corpus";

const NORMALIZER_VERSION = "normalize_v1";

export interface IngestionResult {
  issueId: string;
  context: ConversationContext;
  /** Providers we successfully read from. */
  evidenceFrom: string[];
  /** Providers we tried and could not read, with why. */
  unavailable: Array<{ system: string; reason: string }>;
  matchBand: string | null;
  confidenceScore: number | null;
}

/**
 * Ingest everything knowable about one ticket.
 *
 * Never throws for a provider being unreachable: partial evidence is the normal
 * case, and the matching engine already caps confidence when a source is
 * missing. Throwing would leave the issue with no evidence at all rather than
 * with the half we could get.
 */
export async function ingestTicketContext(
  tenantId: string,
  issueId: string,
  zendeskTicketId: string
): Promise<IngestionResult> {
  const unavailable: Array<{ system: string; reason: string }> = [];
  const evidenceFrom: string[] = [];

  // ── 1. Read the conversation ──────────────────────────────────────────────
  const conversation = await readTicket(zendeskTicketId, unavailable);
  const sources = toTextSources(conversation, zendeskTicketId);

  // ── 2. Read what this customer has bought ─────────────────────────────────
  //
  // Before extraction, not after: a span like "8/1" or "$39" can only be
  // resolved against real records, and merchant recognition needs to know which
  // merchants this customer has actually used. Skipped entirely for an
  // anonymous ticket — see loadCustomerCorpus.
  const corpus = await loadCorpusForIssue(tenantId, issueId);

  const context = readConversation(sources);

  await recordExtraction(tenantId, issueId, zendeskTicketId, context);

  // ── 3. Look up records named outright in the text ─────────────────────────
  //
  // Kept alongside the corpus: a charge the customer names may be older than
  // the corpus window, and an explicit identifier deserves a direct read.
  const stripe = await lookupStripe(context, unavailable);
  const shopify = await lookupShopify(context, unavailable);

  // ── 3. Persist ────────────────────────────────────────────────────────────
  await withTransaction(async (client) => {
    // The thread and its annotations go in together: a span whose message is
    // missing cannot be rendered, and a message whose spans are stale would be
    // marked in the wrong places.
    await persistThread(client, tenantId, issueId, sources);
    await persistContext(
      client,
      tenantId,
      issueId,
      context,
      corpus,
      explicitRecords(stripe, shopify)
    );

    if (stripe) {
      await upsertEvidence(client, {
        tenantId,
        issueId,
        sourceSystem: SourceSystem.STRIPE,
        sourceRecordId: stripe.refundId ?? stripe.chargeId,
        raw: stripe.raw,
        normalized: {
          stripeChargeId: stripe.chargeId,
          stripeRefundId: stripe.refundId,
          stripeRefundStatus: stripe.refundStatus,
          stripeChargeAmount: stripe.chargeAmountCents,
        },
        refundStatus: stripe.refundStatus,
        refundAmountCents: stripe.refundAmountCents,
        refundCurrency: stripe.currency,
        refundId: stripe.refundId,
        chargeId: stripe.chargeId,
        orderId: null,
        isSourceUnavailable: false,
        unavailableReason: null,
      });
      evidenceFrom.push("stripe");
    }

    if (shopify) {
      await upsertEvidence(client, {
        tenantId,
        issueId,
        sourceSystem: SourceSystem.SHOPIFY,
        sourceRecordId: shopify.orderId,
        raw: shopify.raw,
        normalized: {
          shopifyOrderId: shopify.orderId,
          shopifyOrderName: shopify.orderName,
          shopifyOrderTotal: shopify.orderTotalCents,
          shopifyOrderCurrency: shopify.currency,
          shopifyFinancialStatus: shopify.financialStatus,
          shopifyFulfillmentStatus: shopify.fulfillmentStatus,
        },
        refundStatus: null,
        refundAmountCents: null,
        refundCurrency: shopify.currency,
        refundId: null,
        chargeId: null,
        orderId: shopify.orderId,
        isSourceUnavailable: shopify.archived,
        unavailableReason: shopify.archived
          ? "Shopify order archived — last known state shown."
          : null,
      });
      evidenceFrom.push("shopify");
    }
  });

  // ── 4. Recompute the band from whatever we managed to gather ──────────────
  const match = await recomputeMatchForIssue(tenantId, issueId);
  await rebuildCardState(tenantId, issueId);

  await writeAuditEvent(tenantId, issueId, {
    eventType: AuditEventType.EVIDENCE_FETCHED,
    payload: {
      zendesk_ticket_id: zendeskTicketId,
      evidence_from: evidenceFrom,
      unavailable,
      match_band: match?.band ?? null,
      extractor_version: EXTRACTOR_VERSION,
    },
  });

  return {
    issueId,
    context,
    evidenceFrom,
    unavailable,
    matchBand: match?.band ?? null,
    confidenceScore: match?.confidenceScore ?? null,
  };
}

// ─── Conversation ─────────────────────────────────────────────────────────────

async function readTicket(
  ticketId: string,
  unavailable: Array<{ system: string; reason: string }>
): Promise<TicketConversation | null> {
  try {
    return await new ZendeskAdapter().getConversation(ticketId);
  } catch (err) {
    unavailable.push({
      system: "zendesk",
      reason: isTimeoutError(err)
        ? "Zendesk did not respond in time"
        : "Could not read the ticket thread",
    });
    return null;
  }
}

/** Flatten a ticket into the ordered text the extractor reads. */
function toTextSources(
  conversation: TicketConversation | null,
  ticketId: string
): TextSource[] {
  if (!conversation) return [];

  const created = new Date(conversation.createdAt);
  const sources: TextSource[] = [
    {
      id: `ticket:${ticketId}:subject`,
      kind: "ticket_subject",
      authorRole: "customer",
      createdAt: created,
      text: conversation.subject,
    },
  ];

  if (conversation.description) {
    sources.push({
      id: `ticket:${ticketId}:description`,
      kind: "ticket_description",
      authorRole: "customer",
      createdAt: created,
      text: conversation.description,
    });
  }

  for (const message of conversation.messages) {
    // Internal notes are staff-to-staff and often speculative; they should not
    // become the customer's claim.
    if (!message.isPublic && message.authorRole === "agent") continue;

    sources.push({
      id: `comment:${message.id}`,
      kind: "comment",
      authorRole: message.authorRole,
      createdAt: new Date(message.createdAt),
      text: message.body,
    });
  }

  return sources;
}

// ─── Provider lookups ─────────────────────────────────────────────────────────

interface StripeEvidence {
  chargeId: string;
  refundId: string | null;
  refundStatus: string | null;
  refundAmountCents: number | null;
  chargeAmountCents: number | null;
  currency: string | null;
  raw: unknown;
}

/**
 * Resolve payment evidence from whatever reference the conversation gave.
 *
 * A charge id resolves directly. A refund id resolves to its charge. With
 * neither, we do not guess: searching Stripe by amount would happily return
 * somebody else's refund for the same price.
 */
async function lookupStripe(
  context: ConversationContext,
  unavailable: Array<{ system: string; reason: string }>
): Promise<StripeEvidence | null> {
  const reference = context.leads.paymentReference;
  if (!reference) return null;

  const adapter = new StripeAdapter();

  try {
    if (reference.startsWith("re_")) {
      const refund = await adapter.getRefund(reference);
      if (!refund) return null;

      return {
        chargeId: refund.charge,
        refundId: refund.id,
        refundStatus: refund.status,
        refundAmountCents: refund.amount,
        chargeAmountCents: null,
        currency: refund.currency,
        raw: refund,
      };
    }

    const charge = await adapter.getCharge(reference);
    if (!charge) return null;

    // A charge may have refunds already; the most recent one is what the
    // customer is most likely asking about.
    const refunds = await adapter.listRefundsByCharge(charge.id);
    const latest = refunds.sort((a, b) => b.created - a.created)[0] ?? null;

    return {
      chargeId: charge.id,
      refundId: latest?.id ?? null,
      refundStatus: latest?.status ?? null,
      refundAmountCents: latest?.amount ?? null,
      chargeAmountCents: charge.amount,
      currency: charge.currency,
      raw: { charge, refunds },
    };
  } catch (err) {
    unavailable.push({
      system: "stripe",
      reason: isTimeoutError(err)
        ? "Stripe did not respond in time"
        : "Could not read the payment record",
    });
    return null;
  }
}

interface ShopifyEvidence {
  orderId: string;
  orderName: string | null;
  orderTotalCents: number | null;
  currency: string | null;
  financialStatus: string | null;
  fulfillmentStatus: string | null;
  archived: boolean;
  raw: unknown;
}

async function lookupShopify(
  context: ConversationContext,
  unavailable: Array<{ system: string; reason: string }>
): Promise<ShopifyEvidence | null> {
  const reference = context.leads.orderReference;
  if (!reference) return null;

  const shop = process.env.SHOPIFY_SHOP ?? "demo";

  try {
    const order = await new ShopifyAdapter().getOrder(reference, shop);

    return {
      orderId: String(order.id),
      orderName: order.name ?? null,
      orderTotalCents: toCents(order.total_price),
      currency: order.currency ?? null,
      financialStatus: order.financial_status ?? null,
      fulfillmentStatus: order.fulfillment_status ?? null,
      archived: false,
      raw: order,
    };
  } catch (err) {
    // An archived order is a tombstone, not a failure: we keep the reference
    // and mark the source unavailable so the card shows last known state.
    if ((err as Error)?.name === SourceUnavailableError.name) {
      return {
        orderId: reference,
        orderName: null,
        orderTotalCents: null,
        currency: null,
        financialStatus: null,
        fulfillmentStatus: null,
        archived: true,
        raw: null,
      };
    }

    unavailable.push({
      system: "shopify",
      reason: isTimeoutError(err)
        ? "Shopify did not respond in time"
        : "Could not read the order record",
    });
    return null;
  }
}

function toCents(value: unknown): number | null {
  const amount = typeof value === "string" ? Number.parseFloat(value) : NaN;
  return Number.isFinite(amount) ? Math.round(amount * 100) : null;
}

// ─── Persistence ──────────────────────────────────────────────────────────────

interface EvidenceInput {
  tenantId: string;
  issueId: string;
  sourceSystem: SourceSystem;
  sourceRecordId: string;
  raw: unknown;
  normalized: Record<string, unknown>;
  refundStatus: string | null;
  refundAmountCents: number | null;
  refundCurrency: string | null;
  refundId: string | null;
  chargeId: string | null;
  orderId: string | null;
  isSourceUnavailable: boolean;
  unavailableReason: string | null;
}

/**
 * Write one provider's evidence, replacing any previous read for the same
 * record. Raw snapshots are kept separately so a normalizer change can be
 * re-run against what the provider actually returned.
 */
async function upsertEvidence(
  client: PoolClient,
  input: EvidenceInput
): Promise<void> {
  let snapshotId: string | null = null;

  if (input.raw !== null) {
    const serialized = JSON.stringify(input.raw);
    // Hashed here rather than in SQL: the same placeholder cannot be both jsonb
    // and text, and the hash must survive the row being redacted for retention.
    const hash = createHash("sha256").update(serialized).digest("hex");

    const snapshot = await client.query<{ id: string }>(
      `INSERT INTO evidence_raw_snapshots
         (tenant_id, issue_id, source_system, source_record_id,
          normalizer_version, raw_data, raw_data_hash)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id`,
      [
        input.tenantId,
        input.issueId,
        input.sourceSystem,
        input.sourceRecordId,
        NORMALIZER_VERSION,
        serialized,
        hash,
      ]
    );
    snapshotId = snapshot.rows[0].id;
  }

  // One normalized row per (issue, source system): the latest read wins, and
  // history lives in evidence_raw_snapshots.
  await client.query(
    `DELETE FROM evidence_normalized
      WHERE tenant_id = $1 AND issue_id = $2 AND source_system = $3`,
    [input.tenantId, input.issueId, input.sourceSystem]
  );

  await client.query(
    `INSERT INTO evidence_normalized
       (tenant_id, issue_id, source_system, source_record_id, raw_snapshot_id,
        normalizer_version, normalized_data, refund_status, refund_amount_cents,
        refund_currency, refund_id, order_id, charge_id, fetched_at,
        is_source_unavailable, source_unavailable_reason)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, now(), $14, $15)`,
    [
      input.tenantId,
      input.issueId,
      input.sourceSystem,
      input.sourceRecordId,
      snapshotId,
      NORMALIZER_VERSION,
      JSON.stringify(input.normalized),
      input.refundStatus,
      input.refundAmountCents,
      input.refundCurrency,
      input.refundId,
      input.orderId,
      input.chargeId,
      input.isSourceUnavailable,
      input.unavailableReason,
    ]
  );
}

/**
 * Store the thread the extractor read.
 *
 * Persisted because an annotation is meaningless without the text it points
 * into: offsets alone cannot be rendered, and re-fetching the ticket at read
 * time would race the provider and change under the agent mid-decision. The
 * rows carry the same `source_id` the extractor records in provenance, which
 * is what lets a span find its message.
 *
 * Replaces rather than appends. The current thread is a read model; the
 * append-only history lives in audit_log.
 */
async function persistThread(
  client: PoolClient,
  tenantId: string,
  issueId: string,
  sources: TextSource[]
): Promise<void> {
  await client.query(
    `DELETE FROM issue_messages WHERE tenant_id = $1 AND issue_id = $2`,
    [tenantId, issueId]
  );

  for (const [position, source] of sources.entries()) {
    await client.query(
      `INSERT INTO issue_messages
         (tenant_id, issue_id, source_id, kind, author_role, body, position,
          created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        tenantId,
        issueId,
        source.id,
        source.kind,
        source.authorRole,
        source.text,
        position,
        source.createdAt,
      ]
    );
  }
}


/**
 * Records named outright in the ticket text, looked up by identifier.
 *
 * Kept separate from the corpus because they take precedence: a charge the
 * customer wrote down deserves the record for *that* charge, even if it falls
 * outside the window of recent history.
 */
function explicitRecords(
  stripe: StripeEvidence | null,
  shopify: ShopifyEvidence | null
): Map<string, CandidateRecord> {
  const records = new Map<string, CandidateRecord>();

  if (stripe) {
    for (const reference of [stripe.chargeId, stripe.refundId]) {
      if (!reference) continue;
      records.set(reference, {
        provider: "stripe",
        recordType: reference === stripe.refundId ? "refund" : "charge",
        reference,
        status: stripe.refundStatus,
        amountCents: stripe.refundAmountCents ?? stripe.chargeAmountCents,
        currency: stripe.currency,
        occurredAt: null,
        description: null,
      });
    }
  }

  if (shopify) {
    // The customer writes the order *name* ("1001"); the provider answers with
    // its own id. Key both so the span resolves whichever the text carried.
    for (const reference of [
      shopify.orderId,
      shopify.orderName?.replace(/^#/, ""),
    ]) {
      if (!reference) continue;
      records.set(reference, {
        provider: "shopify",
        recordType: "order",
        reference: shopify.orderName ?? shopify.orderId,
        status: shopify.financialStatus,
        amountCents: shopify.orderTotalCents,
        currency: shopify.currency,
        occurredAt: null,
        description: null,
      });
    }
  }

  return records;
}

/**
 * Read this issue's customer, then their recent history.
 *
 * The customer id lives on the issue rather than in the conversation, so this
 * is a database read before any provider call. A missing customer yields an
 * empty corpus, which is the correct answer for an anonymous ticket.
 */
async function loadCorpusForIssue(
  tenantId: string,
  issueId: string
): Promise<CustomerCorpus> {
  const result = await query<{ customer_id: string | null }>(
    `SELECT customer_id FROM issues WHERE tenant_id = $1 AND id = $2`,
    [tenantId, issueId]
  );

  const customerId = result.rows[0]?.customer_id ?? null;
  if (!customerId) return EMPTY_CORPUS;

  try {
    return await loadCustomerCorpus(customerId, process.env.SHOPIFY_SHOP ?? "demo");
  } catch {
    // A corpus buys annotations, not correctness. Losing it must never cost the
    // ticket, so an unreadable history degrades to an unannotated message.
    return EMPTY_CORPUS;
  }
}

/**
 * Write the read model the card renders: every signal, with the span of text it
 * came from and what it turned out to be.
 *
 * Every signal, not the top six. The six were a display budget for a list
 * beside the message; marking text in place has no such budget, and a span the
 * extractor found but the panel silently dropped is the one an agent would
 * most want to see.
 */
async function persistContext(
  client: PoolClient,
  tenantId: string,
  issueId: string,
  context: ConversationContext,
  corpus: CustomerCorpus,
  explicit: Map<string, CandidateRecord>
): Promise<void> {
  const annotations = context.signals.map((signal) => {
    const reference =
      signal.kind === "payment_reference" || signal.kind === "order_reference"
        ? (signal.value as { id: string }).id
        : null;

    const resolution = resolveSpan(signal, corpus, explicit);

    // A year the customer never wrote, settled by an actual purchase. The
    // display has to follow, or the panel shows one year and its own evidence
    // shows another.
    const display =
      resolution.resolvedYear !== null
        ? signal.display.replace(/\b\d{4}\b/, String(resolution.resolvedYear))
        : signal.display;

    return {
      kind: signal.kind,
      display,
      confidence: signal.confidence,
      author_role: signal.authorRole,
      observed_at: signal.observedAt,
      source_id: signal.provenance.sourceId,
      source_kind: signal.provenance.sourceKind,
      // The offsets. Everything in this feature rests on
      // body.slice(start, end) === excerpt holding all the way to the browser.
      start: signal.provenance.start,
      end: signal.provenance.end,
      excerpt: signal.provenance.excerpt,
      rule: signal.provenance.rule,
      // Kept whether or not the lookup succeeded: history matches on what the
      // customer wrote, so a span must stay flaggable without a provider hit.
      reference,
      // Every record the span could mean, never narrowed to one. Two orders on
      // the same day is a question for the agent, not something to resolve by
      // picking the first.
      candidates: resolution.candidates,
      matched_on: resolution.matchedOn,
    };
  });

  await client.query(
    `INSERT INTO issue_context
       (tenant_id, issue_id, extractor_version, payment_reference,
        order_reference, claimed_amount_cents, claimed_currency, primary_ask,
        annotations, message_count, extracted_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, now())
     ON CONFLICT (tenant_id, issue_id) DO UPDATE SET
       extractor_version    = EXCLUDED.extractor_version,
       payment_reference    = EXCLUDED.payment_reference,
       order_reference      = EXCLUDED.order_reference,
       claimed_amount_cents = EXCLUDED.claimed_amount_cents,
       claimed_currency     = EXCLUDED.claimed_currency,
       primary_ask          = EXCLUDED.primary_ask,
       annotations          = EXCLUDED.annotations,
       message_count        = EXCLUDED.message_count,
       extracted_at         = now()`,
    [
      tenantId,
      issueId,
      context.extractorVersion,
      context.leads.paymentReference,
      context.leads.orderReference,
      context.leads.claimedAmountCents,
      context.leads.claimedCurrency ?? null,
      context.leads.primaryAsk?.value.ask ?? null,
      JSON.stringify(annotations),
      context.messageCount,
    ]
  );
}

/**
 * Record what was extracted, with provenance, before any lookup happens.
 *
 * This is the append-only answer to "why did you look up that charge?" — it
 * must survive a later re-ingestion overwriting the current view, and it must
 * be written before the lookup it explains.
 */
async function recordExtraction(
  tenantId: string,
  issueId: string,
  ticketId: string,
  context: ConversationContext
): Promise<void> {
  await writeAuditEvent(tenantId, issueId, {
    eventType: AuditEventType.CONTEXT_EXTRACTED,
    payload: {
      zendesk_ticket_id: ticketId,
      extractor_version: context.extractorVersion,
      leads: {
        payment_reference: context.leads.paymentReference,
        order_reference: context.leads.orderReference,
        claimed_amount_cents: context.leads.claimedAmountCents,
        primary_ask: context.leads.primaryAsk?.value.ask ?? null,
      },
      highlights: context.highlights.map((signal) => ({
        kind: signal.kind,
        display: signal.display,
        confidence: signal.confidence,
        author_role: signal.authorRole,
        source_id: signal.provenance.sourceId,
        excerpt: signal.provenance.excerpt,
        rule: signal.provenance.rule,
      })),
    },
  });
}

async function writeAuditEvent(
  tenantId: string,
  issueId: string,
  event: { eventType: string; payload: Record<string, unknown> }
): Promise<void> {
  await query(
    `INSERT INTO audit_log
       (tenant_id, issue_id, event_type, actor_type, payload, normalizer_version)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      tenantId,
      issueId,
      event.eventType,
      ActorType.SYSTEM,
      JSON.stringify(event.payload),
      NORMALIZER_VERSION,
    ]
  );
}

/** Exported for the transaction-scoped caller in the webhook path. */
export { writeAuditEventTx };
