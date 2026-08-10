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
  const context = readConversation(toTextSources(conversation, zendeskTicketId));

  await recordExtraction(tenantId, issueId, zendeskTicketId, context);

  // ── 2. Look up the real records ───────────────────────────────────────────
  const stripe = await lookupStripe(context, unavailable);
  const shopify = await lookupShopify(context, unavailable);

  // ── 3. Persist ────────────────────────────────────────────────────────────
  await withTransaction(async (client) => {
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
 * Record what was extracted, with provenance, before any lookup happens.
 *
 * This is the audit answer to "why did you look up that charge?" — the trail
 * shows the exact sentence the reference came from.
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
