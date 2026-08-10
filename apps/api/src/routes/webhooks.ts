/**
 * @support-overlay/api — Webhook ingestion
 *
 *   POST /webhooks/zendesk
 *   POST /webhooks/stripe
 *   POST /webhooks/shopify
 *
 * Signatures are verified over the RAW request body. Previously they were
 * computed over JSON.stringify(request.body) — the re-serialized parse — which
 * cannot reproduce the bytes any provider signed, so verification could never
 * succeed against real Zendesk, Stripe, or Shopify traffic.
 *
 * Secrets are per-tenant, read from tenant_integrations.webhook_secret. There is
 * no hardcoded fallback: an unconfigured integration fails verification rather
 * than silently trusting a default that is published in this repository.
 *
 * Tenancy comes from the webhook credential, not from a request header.
 *
 * Idempotency: UNIQUE (tenant_id, source_system, external_event_id).
 * Ordering: uses source_event_at when present, received_at otherwise.
 */
import { FastifyInstance, FastifyRequest } from "fastify";
import { createHmac, timingSafeEqual, createHash } from "crypto";
import { query, withTransaction } from "../db/pool";
import { writeAuditEventTx, AuditEventType } from "../services/audit";
import { requireAuth } from "../middleware/auth";
import { recomputeMatchForIssue } from "../services/matching";
import { ingestTicketContext } from "../services/ingestion";
import { simulatorStore } from "@iisl/connectors";
import { ActorType } from "@iisl/shared";

/** Stripe's recommended tolerance for replayed timestamps. */
const STRIPE_TIMESTAMP_TOLERANCE_SECONDS = 300;

export async function webhookRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("onRequest", requireAuth("webhook"));
  // Zendesk webhook
  app.post<{ Body: Record<string, unknown> }>(
    "/zendesk",
    async (request, reply) => {
      const { tenantId } = request.auth;

      const signatureValid = await verifyZendeskSignature(request, tenantId);
      const externalEventId =
        (request.body?.id as string) ?? generateStableId(request.body);
      const sourceEventType = request.body?.type as string | undefined;
      const sourceEventAt = extractSourceEventAt(request.body);

      await ingestEvent({
        tenantId,
        sourceSystem: "zendesk",
        externalEventId,
        sourceEventType,
        sourceEventAt,
        payload: request.body,
        signatureValid,
        correlationId: request.correlationId,
      });

      return reply.status(200).send({ received: true });
    }
  );

  // Stripe webhook
  app.post<{ Body: Record<string, unknown> }>(
    "/stripe",
    async (request, reply) => {
      const { tenantId } = request.auth;

      const signatureValid = await verifyStripeSignature(request, tenantId);
      const externalEventId = request.body?.id as string;
      const sourceEventType = request.body?.type as string | undefined;
      const sourceEventAt = request.body?.created
        ? new Date((request.body.created as number) * 1000).toISOString()
        : undefined;

      await ingestEvent({
        tenantId,
        sourceSystem: "stripe",
        externalEventId,
        sourceEventType,
        sourceEventAt,
        payload: request.body,
        signatureValid,
        correlationId: request.correlationId,
      });

      return reply.status(200).send({ received: true });
    }
  );

  // Shopify webhook
  app.post<{ Body: Record<string, unknown> }>(
    "/shopify",
    async (request, reply) => {
      const { tenantId } = request.auth;

      const signatureValid = await verifyShopifySignature(request, tenantId);
      const externalEventId =
        (request.body?.id as string) ?? generateStableId(request.body);
      const sourceEventType =
        (request.headers["x-shopify-topic"] as string) ?? undefined;
      const sourceEventAt = request.body?.updated_at as string | undefined;

      await ingestEvent({
        tenantId,
        sourceSystem: "shopify",
        externalEventId,
        sourceEventType,
        sourceEventAt,
        payload: request.body,
        signatureValid,
        correlationId: request.correlationId,
      });

      return reply.status(200).send({ received: true });
    }
  );

  // Fixture injection endpoint (local demo — no real webhook needed)
  app.post<{
    Body: {
      source_system: string;
      event_type: string;
      payload: Record<string, unknown>;
    };
  }>("/fixture", async (request, reply) => {
    const { tenantId } = request.auth;

    const { source_system, event_type, payload } = request.body;
    const externalEventId = `fixture_${Date.now()}_${Math.random().toString(36).slice(2)}`;

    // Give the Zendesk simulator the thread this ticket would have, so the
    // ingestion pipeline reads a real conversation rather than finding nothing.
    // Against a live Zendesk this is unnecessary — the adapter fetches the
    // actual thread — but locally the fixture *is* the source of truth.
    if (source_system === "zendesk" && payload?.id) {
      seedSimulatedConversation(payload);
    }

    await ingestEvent({
      tenantId,
      sourceSystem: source_system,
      externalEventId,
      sourceEventType: event_type,
      payload,
      signatureValid: true, // fixtures are trusted
      correlationId: request.correlationId,
    });

    return reply.status(200).send({
      received: true,
      external_event_id: externalEventId,
      correlation_id: request.correlationId,
    });
  });
}

// ─── Core ingestion ───────────────────────────────────────────────────────────

interface IngestInput {
  tenantId: string;
  sourceSystem: string;
  externalEventId: string;
  sourceEventType?: string;
  sourceEventAt?: string;
  payload: Record<string, unknown>;
  signatureValid: boolean;
  correlationId: string;
}

/**
 * Ingestion work discovered inside a webhook transaction, run after it commits.
 * Provider calls take seconds; holding a transaction open for them would pin a
 * connection and risk the whole event failing over an unrelated outage.
 */
const pendingIngestion: Array<{
  tenantId: string;
  issueId: string;
  ticketId: string;
}> = [];

async function drainPendingIngestion(): Promise<void> {
  while (pendingIngestion.length > 0) {
    const job = pendingIngestion.shift();
    if (!job) break;

    try {
      await ingestTicketContext(job.tenantId, job.issueId, job.ticketId);
    } catch (err) {
      // A failed ingestion leaves the issue with no evidence, which the card
      // renders as "no evidence yet" — correct, and recoverable by the operator
      // refresh endpoint. It must never fail the inbound event.
      console.error(
        `[ingestion] Failed for issue ${job.issueId}:`,
        err instanceof Error ? err.message : err
      );
    }
  }
}

/**
 * Build a simulator thread from a fixture ticket payload.
 *
 * A fixture carries subject, description, and optionally a `comments` array.
 * Turning it into a conversation lets the local demo exercise the real
 * ingestion path — extraction, provider lookup, matching — instead of stopping
 * at "no thread found".
 */
/**
 * A provider timestamp, or null when it cannot be trusted.
 *
 * Returns null rather than a guess: the caller falls back to now(), and a
 * slightly-late timestamp is a much smaller lie than a confidently wrong date
 * rendered next to a refund amount.
 */
function parseTicketTimestamp(value: unknown): string | null {
  if (typeof value !== "string" && typeof value !== "number") return null;

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;

  // A far-future timestamp means a broken clock or a bad feed, not a ticket
  // from next year; it would sort above every real issue in the history list.
  if (parsed.getTime() > Date.now() + 86_400_000) return null;

  return parsed.toISOString();
}

function seedSimulatedConversation(payload: Record<string, unknown>): void {
  const ticketId = String(payload.id);
  const createdAt = String(payload.created_at ?? new Date().toISOString());

  const rawComments = Array.isArray(payload.comments)
    ? (payload.comments as Array<Record<string, unknown>>)
    : [];

  const messages = rawComments.map((comment, index) => ({
    id: String(comment.id ?? `fixture-${index}`),
    body: String(comment.body ?? ""),
    createdAt: String(comment.created_at ?? createdAt),
    authorRole: comment.author_role === "agent" ? ("agent" as const) : ("customer" as const),
    isPublic: comment.public !== false,
  }));

  simulatorStore.seedConversation(ticketId, {
    ticketId,
    subject: String(payload.subject ?? ""),
    description: String(payload.description ?? ""),
    createdAt,
    requesterId: payload.requester_id ? String(payload.requester_id) : null,
    messages,
  });
}

async function ingestEvent(input: IngestInput): Promise<void> {
  const payloadHash = createHash("sha256")
    .update(JSON.stringify(input.payload))
    .digest("hex");

  // A handler may queue ingestion jobs mid-transaction (see handleTicketCreated).
  // If the transaction then fails, those jobs name rows that were just rolled
  // back — draining them would throw. Remember the queue length so a failure
  // can discard exactly what this attempt added, not jobs from elsewhere.
  const queuedBeforeThisAttempt = pendingIngestion.length;

  try {
    await withTransaction(async (client) => {
      // Insert with ON CONFLICT: return existing row if already seen
      const result = await client.query<{ id: string; status: string }>(
        `INSERT INTO inbound_events
           (tenant_id, source_system, external_event_id, source_event_at,
            source_event_type, payload, payload_hash, signature_valid, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'RECEIVED')
         ON CONFLICT (tenant_id, source_system, external_event_id)
         DO UPDATE SET status = 'DUPLICATE'
         RETURNING id, status`,
        [
          input.tenantId,
          input.sourceSystem,
          input.externalEventId,
          input.sourceEventAt ?? null,
          input.sourceEventType ?? null,
          JSON.stringify(input.payload),
          payloadHash,
          input.signatureValid,
        ]
      );

      const row = result.rows[0];

      if (row.status === "DUPLICATE") {
        // Idempotent: already processed, nothing to do
        return;
      }

      if (!input.signatureValid) {
        await client.query(
          `UPDATE inbound_events SET status = 'FAILED', error = 'Invalid signature'
           WHERE id = $1`,
          [row.id]
        );
        return;
      }

      // Route to handler
      await routeEvent(client, input, row.id);

      await client.query(
        `UPDATE inbound_events SET status = 'PROCESSED', processed_at = now()
         WHERE id = $1`,
        [row.id]
      );

      await writeAuditEventTx(client, {
        tenantId: input.tenantId,
        eventType: AuditEventType.INBOUND_EVENT_PROCESSED,
        actorType: ActorType.WEBHOOK,
        payload: {
          source_system: input.sourceSystem,
          event_type: input.sourceEventType,
          external_event_id: input.externalEventId,
          correlation_id: input.correlationId,
        },
      });
    });
  } catch (err) {
    // The transaction rolled back, so any rows its handlers queued work for no
    // longer exist. Discard exactly what this attempt added rather than
    // ingesting against issue ids that were never committed.
    pendingIngestion.length = queuedBeforeThisAttempt;

    // Log but never crash the webhook endpoint: a provider retries on non-2xx,
    // and a poison event would then retry forever.
    const errorMsg = err instanceof Error ? err.message : String(err);
    if (!errorMsg.includes("DUPLICATE")) {
      console.error("[webhook] Ingestion error:", errorMsg);
    }
    return;
  }

  await drainPendingIngestion();
}

// ─── Event routing ────────────────────────────────────────────────────────────

import { PoolClient } from "pg";

async function routeEvent(
  client: PoolClient,
  input: IngestInput,
  _inboundEventId: string
): Promise<void> {
  const { sourceSystem, sourceEventType, payload, tenantId } = input;

  if (sourceSystem === "zendesk") {
    await routeZendeskEvent(client, tenantId, sourceEventType, payload);
  } else if (sourceSystem === "shopify") {
    await routeShopifyEvent(client, tenantId, sourceEventType, payload);
  } else if (sourceSystem === "stripe") {
    await routeStripeEvent(client, tenantId, sourceEventType, payload);
  }
}

async function routeZendeskEvent(
  client: PoolClient,
  tenantId: string,
  eventType: string | undefined,
  payload: Record<string, unknown>
): Promise<void> {
  const ticket = payload.ticket as Record<string, unknown> | undefined;
  const ticketId = String(ticket?.id ?? payload.id ?? "");

  switch (eventType) {
    case "ticket.created":
      // Classify ticket; if refund ticket, create Issue and trigger evidence fetch
      await handleTicketCreated(client, tenantId, ticketId, ticket ?? payload);
      break;

    case "ticket.updated":
      // Re-evaluate classification; detect merge signals
      await handleTicketUpdated(client, tenantId, ticketId, ticket ?? payload);
      break;

    case "ticket.comment.created":
      // Log to audit; no issue state change unless structured trigger tag
      break;

    // Ticket deletion semantic coverage (spec Section 4.2.4, Section 7.1):
    // Native ticket.deleted may not be available on all Zendesk plans.
    // The daily reconciliation job (polling fallback) handles 404s independently.
    // If this event IS received, apply tombstone immediately.
    case "ticket.deleted":
      await handleTicketDeleted(client, tenantId, ticketId);
      break;

    // Merge signal (spec Section 7.1):
    // Native merge webhook is plan-dependent.
    // Also detected in ticket.updated via merged_ticket_ids field (see handleTicketUpdated).
    case "ticket.merged":
      await handleTicketMerged(client, tenantId, ticketId, payload);
      break;

    default:
      // Unknown event type: log and ignore (version drift tolerance)
      console.log(`[webhook] Unknown Zendesk event type: ${eventType} — ignored`);
  }
}

async function handleTicketCreated(
  client: PoolClient,
  tenantId: string,
  ticketId: string,
  ticket: Record<string, unknown>
): Promise<void> {
  // Simple classifier: check for refund-related tags or keywords
  const tags = (ticket.tags as string[]) ?? [];
  const subject = (ticket.subject as string) ?? "";
  const isRefundTicket =
    tags.includes("refund") ||
    tags.includes("refund_request") ||
    /refund|charge|return/i.test(subject);

  if (!isRefundTicket) return;

  // Create Issue
  const issueResult = await client.query<{ id: string }>(
    `INSERT INTO issues
       (tenant_id, customer_id, customer_email, state, playbook_id, opened_at)
     VALUES ($1, $2, $3, 'OPEN', 'refund_v1', COALESCE($4, now()))
     RETURNING id`,
    [
      tenantId,
      // NULL, not "": an empty string is a value, and it would make every
      // ticket with an unknown requester look like the same customer — which
      // would then link strangers' histories to each other.
      ticket.requester_id != null ? String(ticket.requester_id) : null,
      ticket.email != null ? String(ticket.email) : null,
      // When the customer wrote in, not when we processed it. An unparseable
      // value falls back to now() rather than writing a wrong date.
      parseTicketTimestamp(ticket.created_at),
    ]
  );

  const issueId = issueResult.rows[0].id;

  // Queue evidence acquisition. Deliberately after the transaction commits —
  // provider calls are slow and must not hold a webhook transaction open, and a
  // provider outage must not roll back a correctly-created issue.
  pendingIngestion.push({ tenantId, issueId, ticketId });

  await client.query(
    `INSERT INTO issue_tickets (tenant_id, issue_id, zendesk_ticket_id, is_primary)
     VALUES ($1, $2, $3, true)`,
    [tenantId, issueId, ticketId]
  );

  // Initialize card state. Conflict target must match the real constraint —
  // issue_card_state is unique on (tenant_id, issue_id), not issue_id alone.
  // A mismatched target makes Postgres reject the whole statement, which
  // rolled back every ticket-creation transaction that reached this insert.
  await client.query(
    `INSERT INTO issue_card_state (tenant_id, issue_id, zendesk_ticket_id, issue_state)
     VALUES ($1, $2, $3, 'OPEN')
     ON CONFLICT (tenant_id, issue_id) DO NOTHING`,
    [tenantId, issueId, ticketId]
  );

  await writeAuditEventTx(client, {
    tenantId,
    issueId,
    eventType: "issue_created_from_ticket",
    actorType: ActorType.WEBHOOK,
    payload: { zendesk_ticket_id: ticketId },
  });
}

async function handleTicketUpdated(
  client: PoolClient,
  tenantId: string,
  ticketId: string,
  ticket: Record<string, unknown>
): Promise<void> {
  // Detect merge signal in ticket.updated (plan-dependent native merge webhook fallback)
  const mergedTicketIds = ticket.merged_ticket_ids as string[] | undefined;
  if (mergedTicketIds && mergedTicketIds.length > 0) {
    for (const mergedId of mergedTicketIds) {
      await handleTicketMerged(client, tenantId, mergedId, {
        surviving_ticket_id: ticketId,
      });
    }
  }

  // A ticket coming back from solved/closed is a reopen.
  const status = String(ticket.status ?? "").toLowerCase();
  const previousStatus = String(
    (ticket.previous_status as string) ?? (ticket.via_followup_source_id ? "solved" : "")
  ).toLowerCase();

  if (
    (status === "open" || status === "pending") &&
    (previousStatus === "solved" || previousStatus === "closed")
  ) {
    await recordReopen(client, tenantId, ticketId);
  }
}

/**
 * Record a reopen and derive an abuse signal from the trailing count.
 *
 * risk_signals had no writer at all, so computeAbuseSeverity always returned
 * NONE and the abuse rules in the policy engine were unreachable. Repeat
 * reopens are the one signal this system can observe first-hand.
 *
 * Severity is deliberately about the pattern, not the person; the policy engine
 * turns it into "additional review required", never an accusation.
 */
async function recordReopen(
  client: PoolClient,
  tenantId: string,
  ticketId: string
): Promise<void> {
  const issueResult = await client.query<{ issue_id: string }>(
    `SELECT issue_id FROM issue_tickets
      WHERE tenant_id = $1 AND zendesk_ticket_id = $2`,
    [tenantId, ticketId]
  );
  if (issueResult.rows.length === 0) return;

  const issueId = issueResult.rows[0].issue_id;

  await client.query(
    `INSERT INTO reopen_events (tenant_id, issue_id, reason, source)
     VALUES ($1, $2, 'Ticket reopened in Zendesk', 'zendesk')`,
    [tenantId, issueId]
  );

  const countResult = await client.query<{ count: string; gate: number }>(
    `SELECT (SELECT count(*) FROM reopen_events
              WHERE tenant_id = $1 AND issue_id = $2
                AND created_at > now() - interval '30 days') AS count,
            (SELECT reopen_gate_count FROM tenant_config WHERE tenant_id = $1) AS gate`,
    [tenantId, issueId]
  );

  const reopens = parseInt(countResult.rows[0]?.count ?? "0", 10);
  const gate = countResult.rows[0]?.gate ?? 3;

  const severity =
    reopens >= gate ? "HIGH" : reopens >= Math.ceil(gate / 2) ? "MEDIUM" : "LOW";

  await client.query(
    `INSERT INTO risk_signals (tenant_id, issue_id, signal_type, signal_data, severity, source)
     VALUES ($1, $2, 'repeat_reopen', $3, $4, 'zendesk_webhook')`,
    [
      tenantId,
      issueId,
      JSON.stringify({ reopen_count_30d: reopens, reopen_gate_count: gate }),
      severity,
    ]
  );

  await writeAuditEventTx(client, {
    tenantId,
    issueId,
    eventType: AuditEventType.INBOUND_EVENT_PROCESSED,
    actorType: ActorType.WEBHOOK,
    payload: {
      signal: "repeat_reopen",
      reopen_count_30d: reopens,
      severity,
    },
  });
}

async function handleTicketDeleted(
  client: PoolClient,
  tenantId: string,
  ticketId: string
): Promise<void> {
  // Apply tombstone: mark issue_tickets.is_deleted, update card state
  await client.query(
    `UPDATE issue_tickets
     SET is_deleted = true, deleted_at = now()
     WHERE tenant_id = $1 AND zendesk_ticket_id = $2`,
    [tenantId, ticketId]
  );

  // Find affected issue and mark evidence as source unavailable
  const issueResult = await client.query<{ issue_id: string }>(
    `SELECT issue_id FROM issue_tickets WHERE tenant_id = $1 AND zendesk_ticket_id = $2`,
    [tenantId, ticketId]
  );

  if (issueResult.rows.length > 0) {
    const { issue_id } = issueResult.rows[0];
    await client.query(
      `UPDATE evidence_normalized
       SET is_source_unavailable = true, updated_at = now()
       WHERE tenant_id = $1 AND issue_id = $2`,
      [tenantId, issue_id]
    );

    await writeAuditEventTx(client, {
      tenantId,
      issueId: issue_id,
      eventType: AuditEventType.TICKET_SOURCE_DELETED,
      actorType: ActorType.WEBHOOK,
      payload: { zendesk_ticket_id: ticketId },
    });
  }
}

async function handleTicketMerged(
  client: PoolClient,
  tenantId: string,
  secondaryTicketId: string,
  payload: Record<string, unknown>
): Promise<void> {
  // Secondary ticket merged into primary — mark secondary as not primary
  await client.query(
    `UPDATE issue_tickets
     SET is_primary = false
     WHERE tenant_id = $1 AND zendesk_ticket_id = $2`,
    [tenantId, secondaryTicketId]
  );

  const issueResult = await client.query<{ issue_id: string }>(
    `SELECT issue_id FROM issue_tickets WHERE tenant_id = $1 AND zendesk_ticket_id = $2`,
    [tenantId, secondaryTicketId]
  );

  if (issueResult.rows.length > 0) {
    await writeAuditEventTx(client, {
      tenantId,
      issueId: issueResult.rows[0].issue_id,
      eventType: AuditEventType.TICKET_MERGED,
      actorType: ActorType.WEBHOOK,
      payload: {
        secondary_ticket_id: secondaryTicketId,
        surviving_ticket_id: payload.surviving_ticket_id,
      },
    });
  }
}

/**
 * Project a Shopify order event onto the evidence row for that order.
 *
 * The order side is half of what the matcher compares — without a total and a
 * financial status there is nothing to check a refund against, so the band can
 * never rise above what payment evidence alone supports.
 */
async function routeShopifyEvent(
  client: PoolClient,
  tenantId: string,
  eventType: string | undefined,
  payload: Record<string, unknown>
): Promise<void> {
  const orderId = String(payload.id ?? "");
  if (!orderId) return;

  // Archived orders tombstone rather than disappear: the case record is
  // preserved and the card shows the last known state.
  if (eventType === "orders/updated" && payload.status === "archived") {
    const archived = await client.query<{ issue_id: string }>(
      `UPDATE evidence_normalized
          SET is_source_unavailable = true,
              source_unavailable_reason = 'Shopify order archived — last known state shown.',
              updated_at = now()
        WHERE tenant_id = $1
          AND source_system = 'shopify'
          AND (order_id = $2 OR source_record_id = $2)
        RETURNING issue_id`,
      [tenantId, orderId]
    );

    await writeAuditEventTx(client, {
      tenantId,
      issueId: archived.rows[0]?.issue_id,
      eventType: AuditEventType.ORDER_ARCHIVED,
      actorType: ActorType.WEBHOOK,
      payload: { shopify_order_id: orderId, rows_updated: archived.rows.length },
    });

    await recomputeAffected(client, tenantId, archived.rows);
    return;
  }

  if (eventType !== "orders/updated" && eventType !== "orders/paid") return;

  // Shopify sends money as a decimal string; the rest of the system is cents.
  const totalCents = toCents(payload.total_price);
  const financialStatus = stringValue(payload.financial_status);

  const updated = await client.query<{ issue_id: string }>(
    `UPDATE evidence_normalized
        SET normalized_data = normalized_data
              || jsonb_build_object(
                   'shopifyOrderId', $2::text,
                   'shopifyOrderName', $3::text,
                   'shopifyOrderTotal', $4::int,
                   'shopifyOrderCurrency', $5::text,
                   'shopifyFinancialStatus', $6::text,
                   'shopifyFulfillmentStatus', $7::text
                 ),
            order_id = COALESCE(order_id, $2),
            refund_currency = COALESCE($5, refund_currency),
            fetched_at = now(),
            updated_at = now()
      WHERE tenant_id = $1
        AND source_system = 'shopify'
        AND (order_id = $2 OR source_record_id = $2)
      RETURNING issue_id`,
    [
      tenantId,
      orderId,
      stringValue(payload.name),
      totalCents,
      stringValue(payload.currency),
      financialStatus,
      stringValue(payload.fulfillment_status),
    ]
  );

  await writeAuditEventTx(client, {
    tenantId,
    issueId: updated.rows[0]?.issue_id,
    eventType: AuditEventType.EVIDENCE_FETCHED,
    actorType: ActorType.WEBHOOK,
    payload: {
      shopify_event_type: eventType,
      shopify_order_id: orderId,
      financial_status: financialStatus,
      evidence_rows_updated: updated.rows.length,
    },
  });

  await recomputeAffected(client, tenantId, updated.rows);
}

/** Recompute the match band for every issue whose evidence just changed. */
async function recomputeAffected(
  client: PoolClient,
  tenantId: string,
  rows: Array<{ issue_id: string }>
): Promise<void> {
  const seen = new Set<string>();

  for (const row of rows) {
    if (!row.issue_id || seen.has(row.issue_id)) continue;
    seen.add(row.issue_id);

    const match = await recomputeMatchForIssue(tenantId, row.issue_id, client);
    if (!match) continue;

    await writeAuditEventTx(client, {
      tenantId,
      issueId: row.issue_id,
      eventType: AuditEventType.EVIDENCE_MATCH_COMPUTED,
      actorType: ActorType.SYSTEM,
      payload: {
        match_band: match.band,
        confidence_score: match.confidenceScore,
        matched_fields: match.matchedFields,
      },
    });
  }
}

/** Shopify money is a decimal string ("49.99"); everything else uses cents. */
function toCents(value: unknown): number | null {
  const amount = typeof value === "string" ? Number.parseFloat(value) : NaN;
  return Number.isFinite(amount) ? Math.round(amount * 100) : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

/**
 * Project a Stripe refund event onto the evidence row for the matching charge.
 *
 * This previously discarded the payload and left a comment saying evidence
 * would be refreshed by a pull cycle that does not exist, so a refund
 * completing in Stripe never reached the card.
 */
async function routeStripeEvent(
  client: PoolClient,
  tenantId: string,
  eventType: string | undefined,
  payload: Record<string, unknown>
): Promise<void> {
  if (eventType !== "charge.refunded" && eventType !== "refund.updated") {
    return;
  }

  const object = (payload.data as { object?: Record<string, unknown> } | undefined)
    ?.object;
  if (!object) return;

  // A refund event carries the refund; a charge event carries the charge.
  const isRefund = object.object === "refund";
  const chargeId = String(isRefund ? object.charge ?? "" : object.id ?? "");
  const refundId = isRefund ? String(object.id ?? "") : null;
  const status = isRefund ? String(object.status ?? "") : "succeeded";
  const amountCents = Number(
    isRefund ? object.amount : object.amount_refunded
  );

  if (!chargeId) return;

  const updated = await client.query<{ issue_id: string }>(
    `UPDATE evidence_normalized
        SET refund_status = $3,
            refund_id = COALESCE($4, refund_id),
            refund_amount_cents = COALESCE($5, refund_amount_cents),
            fetched_at = now(),
            updated_at = now()
      WHERE tenant_id = $1 AND charge_id = $2
      RETURNING issue_id`,
    [
      tenantId,
      chargeId,
      ["succeeded", "pending", "failed"].includes(status) ? status : "pending",
      refundId,
      Number.isFinite(amountCents) ? amountCents : null,
    ]
  );

  await writeAuditEventTx(client, {
    tenantId,
    issueId: updated.rows[0]?.issue_id,
    eventType: AuditEventType.EVIDENCE_FETCHED,
    actorType: ActorType.WEBHOOK,
    payload: {
      stripe_event_type: eventType,
      charge_id: chargeId,
      refund_id: refundId,
      refund_status: status,
      evidence_rows_updated: updated.rows.length,
    },
  });

  // Evidence changed, so the confidence band is stale until recomputed.
  await recomputeAffected(client, tenantId, updated.rows);
}

// ─── Signature verification ───────────────────────────────────────────────────

/**
 * Per-tenant signing secret. Returns null when the integration is not
 * configured — callers must treat that as verification failure, never as a
 * reason to skip the check.
 */
async function webhookSecretFor(
  tenantId: string,
  sourceSystem: string
): Promise<string | null> {
  const result = await query<{ webhook_secret: string | null }>(
    `SELECT webhook_secret FROM tenant_integrations
      WHERE tenant_id = $1 AND source_system = $2 AND is_active = true
      LIMIT 1`,
    [tenantId, sourceSystem]
  );
  return result.rows[0]?.webhook_secret ?? null;
}

/** Constant-time compare of two same-encoding digests. */
function safeEqual(a: Buffer, b: Buffer): boolean {
  if (a.length !== b.length || a.length === 0) return false;
  return timingSafeEqual(a, b);
}

/**
 * The exact bytes the provider signed. Fastify's JSON parser is configured in
 * server.ts to retain them; without this, the HMAC is computed over a
 * re-serialization and never matches.
 */
function rawBodyOf(request: FastifyRequest): Buffer | null {
  const raw = (request as FastifyRequest & { rawBody?: Buffer }).rawBody;
  return Buffer.isBuffer(raw) ? raw : null;
}

async function verifyZendeskSignature(
  request: FastifyRequest,
  tenantId: string
): Promise<boolean> {
  const signature = request.headers["x-zendesk-webhook-signature"];
  const timestamp = request.headers["x-zendesk-webhook-signature-timestamp"];
  const raw = rawBodyOf(request);
  if (typeof signature !== "string" || !raw) return false;

  const secret = await webhookSecretFor(tenantId, "zendesk");
  if (!secret) return false;

  // Zendesk signs timestamp + body, base64-encoded.
  const signed = Buffer.concat([
    Buffer.from(typeof timestamp === "string" ? timestamp : "", "utf8"),
    raw,
  ]);
  const expected = createHmac("sha256", secret).update(signed).digest("base64");

  return safeEqual(Buffer.from(signature, "utf8"), Buffer.from(expected, "utf8"));
}

async function verifyStripeSignature(
  request: FastifyRequest,
  tenantId: string
): Promise<boolean> {
  const sigHeader = request.headers["stripe-signature"];
  const raw = rawBodyOf(request);
  if (typeof sigHeader !== "string" || !raw) return false;

  const secret = await webhookSecretFor(tenantId, "stripe");
  if (!secret) return false;

  const parts = new Map<string, string>();
  for (const segment of sigHeader.split(",")) {
    const [key, value] = segment.split("=");
    if (key && value) parts.set(key.trim(), value.trim());
  }

  const timestamp = parts.get("t");
  const signature = parts.get("v1");
  if (!timestamp || !signature) return false;

  // Reject replays outside the tolerance window. Without this, a captured
  // request stays valid forever.
  const age = Math.abs(Date.now() / 1000 - Number(timestamp));
  if (!Number.isFinite(age) || age > STRIPE_TIMESTAMP_TOLERANCE_SECONDS) {
    return false;
  }

  const signed = Buffer.concat([
    Buffer.from(`${timestamp}.`, "utf8"),
    raw,
  ]);
  const expected = createHmac("sha256", secret).update(signed).digest("hex");

  return safeEqual(Buffer.from(signature, "hex"), Buffer.from(expected, "hex"));
}

async function verifyShopifySignature(
  request: FastifyRequest,
  tenantId: string
): Promise<boolean> {
  const hmac = request.headers["x-shopify-hmac-sha256"];
  const raw = rawBodyOf(request);
  if (typeof hmac !== "string" || !raw) return false;

  const secret = await webhookSecretFor(tenantId, "shopify");
  if (!secret) return false;

  const expected = createHmac("sha256", secret).update(raw).digest("base64");

  return safeEqual(Buffer.from(hmac, "utf8"), Buffer.from(expected, "utf8"));
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function generateStableId(payload: Record<string, unknown>): string {
  return createHash("sha256")
    .update(JSON.stringify(payload))
    .digest("hex")
    .slice(0, 16);
}

function extractSourceEventAt(
  payload: Record<string, unknown>
): string | undefined {
  const candidates = [
    payload.updated_at,
    payload.created_at,
    payload.event_time,
    (payload.ticket as Record<string, unknown>)?.updated_at,
  ];
  for (const c of candidates) {
    if (typeof c === "string" && c) return c;
  }
  return undefined;
}
