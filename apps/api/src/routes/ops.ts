/**
 * @iisl/api — Operator Repair Routes
 * VALIDATION: [STATIC-CONSISTENT]
 *
 * All /ops/* endpoints require operator authentication.
 * Every repair action emits an explicit audit event.
 *
 * POST /ops/issues/:issue_id/rebuild-card-state
 * POST /ops/inbound-events/:event_id/replay
 * PATCH /ops/action-executions/:execution_id/reconcile
 * POST /ops/issues/:issue_id/sync-zendesk
 *
 * Spec reference: Appendix A (Operator Repair Runbook Minimums)
 */
import { FastifyInstance } from "fastify";
import { query, withTransaction } from "../db/pool";
import { writeAuditEvent, writeAuditEventTx, AuditEventType } from "../services/audit";
import { ZendeskAdapter } from "@iisl/connectors";
import { requireAuth } from "../middleware/auth";
import { parseBody, notFound } from "../middleware/errors";
import {
  reconcileBody,
  operatorRepairBody,
  syncZendeskBody,
} from "../schemas";
import { recomputeMatchForIssue } from "../services/matching";
import { rebuildCardState } from "../workers/outboxWorker";
import { ActorType } from "@iisl/shared";

export async function opsRoutes(app: FastifyInstance): Promise<void> {
  // Operator credentials carry their own tenant, so these repair endpoints can
  // only ever touch the tenant the token belongs to.
  app.addHook("onRequest", requireAuth("operator"));

  /**
   * POST /ops/issues/:issue_id/rebuild-card-state
   *
   * Recompute issue_card_state from canonical tables.
   * Blast radius: single issue. Fully idempotent.
   * Post-check: GET /api/v1/card/:zendesk_ticket_id
   */
  app.post<{
    Params: { issue_id: string };
    Body: { reason: string };
  }>("/issues/:issue_id/rebuild-card-state", async (request, reply) => {
    const { tenantId } = request.auth;

    const { issue_id } = request.params;
    const { reason } = parseBody(operatorRepairBody, request.body);

    await withTransaction(async (client) => {
      // Recompute from canonical tables
      await client.query(
        `INSERT INTO issue_card_state
           (tenant_id, issue_id, zendesk_ticket_id, issue_state,
            refund_status, refund_amount_cents, refund_currency, refund_id,
            match_band, confidence_score, evidence_fetched_at, is_source_unavailable,
            last_rebuilt_at)
         SELECT
           i.tenant_id, i.id,
           it.zendesk_ticket_id,
           i.state,
           en.refund_status, en.refund_amount_cents, en.refund_currency, en.refund_id,
           emr.match_band, emr.confidence_score,
           en.fetched_at, en.is_source_unavailable,
           now()
         FROM issues i
         LEFT JOIN issue_tickets it
           ON it.issue_id = i.id AND it.is_primary = true AND it.is_deleted = false
         LEFT JOIN evidence_normalized en
           ON en.issue_id = i.id AND en.tenant_id = i.tenant_id
         LEFT JOIN evidence_match_results emr
           ON emr.evidence_normalized_id = en.id
         WHERE i.id = $1 AND i.tenant_id = $2
         ORDER BY en.fetched_at DESC NULLS LAST
         LIMIT 1
         ON CONFLICT (issue_id) DO UPDATE SET
           issue_state = EXCLUDED.issue_state,
           refund_status = EXCLUDED.refund_status,
           refund_amount_cents = EXCLUDED.refund_amount_cents,
           refund_currency = EXCLUDED.refund_currency,
           refund_id = EXCLUDED.refund_id,
           match_band = EXCLUDED.match_band,
           confidence_score = EXCLUDED.confidence_score,
           evidence_fetched_at = EXCLUDED.evidence_fetched_at,
           is_source_unavailable = EXCLUDED.is_source_unavailable,
           last_rebuilt_at = now(),
           updated_at = now()`,
        [issue_id, tenantId]
      );

      await writeAuditEventTx(client, {
        tenantId,
        issueId: issue_id,
        eventType: AuditEventType.OPERATOR_REBUILD_CARD_STATE,
        actorType: ActorType.OPERATOR,
        payload: {
          reason,
          correlation_id: request.correlationId,
        },
      });
    });

    return reply.send({
      status: "rebuilt",
      issue_id,
      correlation_id: request.correlationId,
      post_check: `GET /api/v1/card/<zendesk_ticket_id>`,
    });
  });

  /**
   * POST /ops/inbound-events/:event_id/replay
   *
   * Re-enqueue an inbound event for reprocessing.
   * Blast radius: single event. Idempotent due to processor deduplication.
   * Post-check: poll GET /ops/inbound-events/:event_id status.
   */
  app.post<{
    Params: { event_id: string };
    Body: { reason: string };
  }>("/inbound-events/:event_id/replay", async (request, reply) => {
    const { tenantId } = request.auth;

    const { event_id } = request.params;
    const { reason } = parseBody(operatorRepairBody, request.body);

    const result = await query<{ id: string; status: string; source_system: string }>(
      `UPDATE inbound_events
       SET status = 'RECEIVED', error = null, processed_at = null
       WHERE id = $1 AND tenant_id = $2
       RETURNING id, status, source_system`,
      [event_id, tenantId]
    );

    if (result.rows.length === 0) {
      throw notFound("Event not found");
    }

    await query(
      `INSERT INTO audit_log
         (tenant_id, event_type, actor_type, payload)
       VALUES ($1, $2, 'operator', $3)`,
      [
        tenantId,
        AuditEventType.OPERATOR_REPLAY_EVENT,
        JSON.stringify({
          event_id,
          reason,
          correlation_id: request.correlationId,
        }),
      ]
    );

    return reply.send({
      status: "re_queued",
      event_id,
      correlation_id: request.correlationId,
      post_check: `GET /ops/inbound-events/${event_id}`,
    });
  });

  /**
   * GET /ops/inbound-events/:event_id
   * Check status of an inbound event.
   */
  app.get<{ Params: { event_id: string } }>(
    "/inbound-events/:event_id",
    async (request, reply) => {
      const { tenantId } = request.auth;
      const result = await query(
        `SELECT id, source_system, source_event_type, status, error, received_at, processed_at
         FROM inbound_events WHERE id = $1 AND tenant_id = $2`,
        [request.params.event_id, tenantId]
      );

      if (result.rows.length === 0) {
        throw notFound("Event not found");
      }
      return reply.send(result.rows[0]);
    }
  );

  /**
   * PATCH /ops/action-executions/:execution_id/reconcile
   *
   * Manually reconcile a FAILED_TERMINAL execution.
   * Status stays FAILED_TERMINAL. Reconciliation stored as metadata.
   * Blast radius: single action_execution. NOT idempotent — second call
   * with conflicting outcome requires explicit override flag.
   *
   * Post-check: audit_log for action_execution_reconciled event.
   */
  app.patch<{
    Params: { execution_id: string };
    Body: {
      external_side_effect_status:
        | "CONFIRMED_OCCURRED"
        | "CONFIRMED_NOT_OCCURRED"
        | "UNKNOWN";
      investigation_notes: string;
      corrective_action_taken?: string;
    };
  }>("/action-executions/:execution_id/reconcile", async (request, reply) => {
    const { tenantId } = request.auth;

    const { execution_id } = request.params;
    const {
      external_side_effect_status,
      investigation_notes,
      corrective_action_taken,
    } = parseBody(reconcileBody, request.body);


    await withTransaction(async (client) => {
      const result = await client.query<{ id: string; issue_id: string; status: string }>(
        `UPDATE action_executions
            SET reconciled_at = now(),
                reconciled_by = $2,
                reconciliation_outcome = $3,
                investigation_notes = $5,
                corrective_action_taken = $6
          WHERE id = $1 AND tenant_id = $4
            AND status IN ('FAILED_TERMINAL', 'BLOCKED_OPERATOR')
            AND reconciled_at IS NULL
          RETURNING id, issue_id, status`,
        [
          execution_id,
          request.auth.principalId,
          external_side_effect_status,
          tenantId,
          investigation_notes,
          corrective_action_taken ?? null,
        ]
      );

      if (result.rows.length === 0) {
        throw new Error(
          "Execution not found, not awaiting reconciliation, or already reconciled"
        );
      }

      await writeAuditEventTx(client, {
        tenantId,
        issueId: result.rows[0].issue_id,
        eventType: AuditEventType.OPERATOR_RECONCILE_EXECUTION,
        actorType: ActorType.OPERATOR,
        actorId: request.auth.principalId,
        payload: {
          execution_id,
          external_side_effect_status,
          investigation_notes,
          corrective_action_taken: corrective_action_taken ?? null,
          correlation_id: request.correlationId,
        },
      });
    });

    return reply.send({
      status: "reconciled",
      execution_id,
      reconciliation_outcome: external_side_effect_status,
      correlation_id: request.correlationId,
      note: "action_executions.status remains FAILED_TERMINAL — reconciliation stored as metadata",
    });
  });

  /**
   * POST /ops/issues/:issue_id/sync-zendesk
   *
   * Force sync Zendesk ticket to target status.
   * Blast radius: single Zendesk ticket. Idempotent (setting same status twice is safe).
   * Do NOT use to change issues.state — use reconcile endpoint for that.
   */
  app.post<{
    Params: { issue_id: string };
    Body: { reason: string; target_status: "open" | "pending" | "solved" };
  }>("/issues/:issue_id/sync-zendesk", async (request, reply) => {
    const { tenantId } = request.auth;

    const { issue_id } = request.params;
    const { reason, target_status } = parseBody(syncZendeskBody, request.body);

    // Get primary ticket ID
    const ticketResult = await query<{ zendesk_ticket_id: string }>(
      `SELECT zendesk_ticket_id FROM issue_tickets
       WHERE issue_id = $1 AND tenant_id = $2 AND is_primary = true AND is_deleted = false`,
      [issue_id, tenantId]
    );

    if (ticketResult.rows.length === 0) {
      return reply.status(404).send({
        error: "No active primary ticket found for this issue",
      });
    }

    const { zendesk_ticket_id } = ticketResult.rows[0];

    const adapter = new ZendeskAdapter();

    try {
      await adapter.updateTicketStatus(zendesk_ticket_id, target_status);
    } catch (err) {
      request.log.error({ err, zendesk_ticket_id }, "Zendesk force-sync failed");
      return reply.status(502).send({
        error: "Zendesk did not accept the status change",
        hint: `Quote correlation id ${request.correlationId} when investigating.`,
        correlation_id: request.correlationId,
      });
    }

    await query(
      `INSERT INTO audit_log (tenant_id, issue_id, event_type, actor_type, payload)
       VALUES ($1, $2, $3, 'operator', $4)`,
      [
        tenantId,
        issue_id,
        AuditEventType.OPERATOR_FORCE_SYNC_ZENDESK,
        JSON.stringify({
          zendesk_ticket_id,
          target_status,
          reason,
          correlation_id: request.correlationId,
        }),
      ]
    );

    return reply.send({
      status: "synced",
      zendesk_ticket_id,
      target_status,
      correlation_id: request.correlationId,
      warning:
        "This syncs Zendesk status only. issues.state is NOT changed. " +
        "Use /ops/action-executions/:id/reconcile if issue state also needs correction.",
    });
  });
  /**
   * POST /ops/issues/:issue_id/recompute-match
   *
   * Recompute the evidence match band from current evidence. Read-only with
   * respect to providers — it re-derives from what is already stored, so it is
   * always safe to run.
   */
  app.post<{
    Params: { issue_id: string };
    Body: { reason?: string };
  }>("/issues/:issue_id/recompute-match", async (request, reply) => {
    const { tenantId } = request.auth;
    const { issue_id } = request.params;

    const match = await recomputeMatchForIssue(tenantId, issue_id);

    if (!match) {
      return reply.status(404).send({
        error: "No evidence on file for this issue",
        hint: "Nothing to match yet — refresh evidence first.",
      });
    }

    await writeAuditEvent({
      tenantId,
      issueId: issue_id,
      eventType: AuditEventType.EVIDENCE_MATCH_COMPUTED,
      actorType: ActorType.OPERATOR,
      actorId: request.auth.principalId,
      matchAlgorithmVersion: "match_v1",
      payload: {
        match_band: match.band,
        confidence_score: match.confidenceScore,
        matched_fields: match.matchedFields,
        reason: request.body?.reason ?? null,
        correlation_id: request.correlationId,
      },
    });

    await rebuildCardState(tenantId, issue_id);

    return reply.send({
      issue_id,
      match_band: match.band,
      confidence_score: match.confidenceScore,
      matched_fields: match.matchedFields,
      notes: match.notes,
      correlation_id: request.correlationId,
    });
  });

}
