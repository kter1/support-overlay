/**
 * @iisl/api — Card Routes
 * VALIDATION: [COMPILE-PENDING]
 *
 * GET /api/v1/card/:zendesk_ticket_id
 * Returns the Resolution Card state for a given Zendesk ticket.
 *
 * Freshness is computed at read time from timestamps.
 * is_source_unavailable is a separate persisted flag (not freshness).
 */
import { FastifyInstance } from "fastify";
import { query } from "../db/pool";
import { computeFreshness } from "../services/freshness";
import { requireAuth } from "../middleware/auth";
import { notFound } from "../middleware/errors";
import { assembleCustomerHistory } from "../services/history";
import { loadIssueContext } from "../services/context";

export async function cardRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("onRequest", requireAuth("agent"));

  /**
   * GET /api/v1/card/:zendesk_ticket_id
   * Returns card state for the given Zendesk ticket.
   * Used by sidebar app on load and polling interval.
   */
  app.get<{ Params: { zendesk_ticket_id: string } }>(
    "/:zendesk_ticket_id",
    async (request, reply) => {
      const { zendesk_ticket_id } = request.params;
      const { tenantId } = request.auth;

      // Fetch card state from denormalized read model
      const cardResult = await query<CardStateRow>(
        `SELECT
           cs.*,
           COALESCE(
             (to_jsonb(cs) ->> 'pending_action_execution_id'),
             (to_jsonb(cs) ->> 'pending_execution_id')
           ) AS pending_execution_id_unified,
           COALESCE(
             (to_jsonb(cs) ->> 'pending_approval_request_id'),
             (to_jsonb(cs) ->> 'pending_approval_id')
           ) AS pending_approval_id_unified,
           (to_jsonb(cs) ->> 'last_action_type') AS last_action_type_unified,
           (to_jsonb(cs) ->> 'last_action_completed_at') AS last_action_completed_at_unified,
           (to_jsonb(cs) -> 'evidence_summary') AS evidence_summary_unified,
           tc.evidence_freshness_seconds,
           tc.approvals_enabled
         FROM issue_card_state cs
         JOIN tenant_config tc ON tc.tenant_id = cs.tenant_id
         WHERE cs.zendesk_ticket_id = $1
           AND cs.tenant_id = $2`,
        [zendesk_ticket_id, tenantId]
      );

      if (cardResult.rows.length === 0) {
        throw notFound(
          "No resolution record exists for this ticket yet."
        );
      }

      const card = cardResult.rows[0];

      // Freshness computed at read time (NOT stored as a flag)
      const freshness = computeFreshness({
        fetchedAt: card.evidence_fetched_at
          ? new Date(card.evidence_fetched_at)
          : null,
        freshnessWindowSeconds: card.evidence_freshness_seconds,
        isSourceUnavailable: card.is_source_unavailable,
      });
      const pendingExecutionId =
        card.pending_execution_id_unified ?? card.pending_execution_id ?? null;
      const pendingApprovalId =
        card.pending_approval_id_unified ?? card.pending_approval_id ?? null;
      const pendingActionType = card.pending_action_type ?? card.last_action_type_unified ?? null;
      const pendingActionStatus = card.pending_action_status ?? null;
      const hasPendingAction =
        !!pendingExecutionId || !!pendingApprovalId || !!pendingActionType;

      // What the customer actually said, and whether we have been here before
      // with them. Both are reads against indexed keys and are fetched together
      // so the card is one round trip's worth of latency, not three.
      const [context, history] = await Promise.all([
        loadIssueContext(tenantId, card.issue_id),
        assembleCustomerHistory(tenantId, card.issue_id),
      ]);

      // Emit card_loaded audit event for bypass detection
      await query(
        `INSERT INTO audit_log
           (tenant_id, issue_id, event_type, actor_type, actor_id, payload)
         VALUES ($1, $2, 'card_loaded', 'system', $3, $4)`,
        [
          tenantId,
          card.issue_id,
          request.headers["x-agent-id"] ?? "unknown",
          JSON.stringify({
            zendesk_ticket_id,
            correlation_id: request.correlationId,
          }),
        ]
      );

      return reply.send({
        issue_id: card.issue_id,
        zendesk_ticket_id: card.zendesk_ticket_id,
        issue_state: card.issue_state,
        evidence: {
          refund_status: card.refund_status,
          refund_amount_cents: card.refund_amount_cents,
          refund_currency: card.refund_currency,
          refund_id: card.refund_id,
          match_band: card.match_band,
          confidence_score: card.confidence_score
            ? parseFloat(card.confidence_score)
            : null,
        },
        freshness: {
          is_fresh: freshness.isFresh,
          age_seconds: freshness.ageSeconds,
          is_usable_despite_stale: freshness.isUsableDespiteStale,
          is_source_unavailable: freshness.isSourceUnavailable,
        },
        pending_action: hasPendingAction
          ? {
              action_type: pendingActionType,
              status: pendingActionStatus,
              execution_id: pendingExecutionId,
              approval_id: pendingApprovalId,
            }
          : null,
        evidence_fetched_at: card.evidence_fetched_at,
        evidence_summary: card.evidence_summary_unified,
        context: context
          ? {
              primary_ask: context.primaryAsk,
              payment_reference: context.paymentReference,
              order_reference: context.orderReference,
              claimed_amount_cents: context.claimedAmountCents,
              claimed_currency: context.claimedCurrency,
              message_count: context.messageCount,
              extractor_version: context.extractorVersion,
              extracted_at: context.extractedAt,
              highlights: context.highlights.map((h) => ({
                kind: h.kind,
                display: h.display,
                confidence: h.confidence,
                author_role: h.authorRole,
                source_kind: h.sourceKind,
                excerpt: h.excerpt,
              })),
            }
          : null,
        customer_history: {
          prior_issue_count: history.priorIssueCount,
          truncated: history.truncated,
          notices: history.notices.map((n) => ({
            severity: n.severity,
            code: n.code,
            message: n.message,
          })),
          prior_interactions: history.priorInteractions.map((i) => ({
            zendesk_ticket_id: i.zendeskTicketId,
            opened_at: i.openedAt,
            state: i.state,
            primary_ask: i.primaryAsk,
            order_reference: i.orderReference,
            match_band: i.matchBand,
            refunded_amount_cents: i.refundedAmountCents,
            refund_currency: i.refundCurrency,
            refund_status: i.refundStatus,
            same_subject: i.sameSubject,
            actions_taken: i.actionsTaken.map((a) => a.actionType),
          })),
        },
        pending_action_execution_id: pendingExecutionId,
        pending_approval_request_id: pendingApprovalId,
        last_action_type: card.last_action_type_unified,
        last_action_completed_at: card.last_action_completed_at_unified,
        approvals_enabled: card.approvals_enabled,
        last_rebuilt_at: card.last_rebuilt_at,
        correlation_id: request.correlationId,
      });
    }
  );
}

interface CardStateRow {
  issue_id: string;
  zendesk_ticket_id: string;
  issue_state: string;
  refund_status: string | null;
  refund_amount_cents: number | null;
  refund_currency: string | null;
  refund_id: string | null;
  match_band: string | null;
  confidence_score: string | null;
  evidence_fetched_at: string | null;
  is_source_unavailable: boolean;
  pending_action_type: string | null;
  pending_action_status: string | null;
  pending_execution_id: string | null;
  pending_approval_id: string | null;
  pending_execution_id_unified: string | null;
  pending_approval_id_unified: string | null;
  last_action_type_unified: string | null;
  last_action_completed_at_unified: string | null;
  evidence_summary_unified: Record<string, unknown> | null;
  evidence_freshness_seconds: number;
  approvals_enabled: boolean;
  last_rebuilt_at: string;
}
