/**
 * @support-overlay/api — Approval routes
 *
 * Approval flow is present but disabled by default
 * (tenant_config.approvals_enabled = false). When disabled these endpoints
 * return 403.
 *
 *   GET  /api/v1/approvals/:approval_id
 *   POST /api/v1/approvals/:approval_id/grant
 *   POST /api/v1/approvals/:approval_id/deny
 *
 * The approving manager is the authenticated principal, checked against
 * manager_grants. It is never read from the request body — previously any
 * caller could approve as any manager by naming them in the payload, which
 * defeated the entire point of the approval gate.
 *
 * Idempotency is enforced by the partial unique index on
 * action_executions(approval_request_id) plus the atomic status transition.
 */
import { FastifyInstance } from "fastify";
import { query, withTransaction } from "../db/pool";
import { completeApprovalAndEnqueue } from "../services/actionService";
import { writeAuditEventTx, AuditEventType } from "../services/audit";
import { requireAuth, isManager } from "../middleware/auth";
import { parseBody, parseParams, notFound, forbidden, conflict } from "../middleware/errors";
import { grantApprovalBody, denyApprovalBody, approvalIdParam } from "../schemas";
import { ActorType } from "@iisl/shared";

async function approvalsEnabled(tenantId: string): Promise<boolean> {
  const result = await query<{ approvals_enabled: boolean }>(
    "SELECT approvals_enabled FROM tenant_config WHERE tenant_id = $1",
    [tenantId]
  );
  return result.rows[0]?.approvals_enabled === true;
}

export async function approvalRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("onRequest", requireAuth("agent", "operator"));

  /**
   * GET /api/v1/approvals/:approval_id
   * Status of a single approval request.
   */
  app.get<{ Params: { approval_id: string } }>(
    "/:approval_id",
    async (request, reply) => {
      const { tenantId } = request.auth;

      const result = await query(
        `SELECT ar.*, ae.status AS execution_status
           FROM approval_requests ar
           LEFT JOIN action_executions ae ON ae.id = ar.linked_action_execution_id
          WHERE ar.id = $1 AND ar.tenant_id = $2`,
        [parseParams(approvalIdParam, request.params).approval_id, tenantId]
      );

      if (result.rows.length === 0) {
        throw notFound("Approval request not found");
      }

      return reply.send(result.rows[0]);
    }
  );

  /**
   * GET /api/v1/approvals
   * Pending approvals for the tenant.
   */
  app.get("/", async (request, reply) => {
    const { tenantId } = request.auth;

    const result = await query(
      `SELECT id, issue_id, action_type, requested_by_agent_id, status,
              approval_policy_code, assigned_queue, expires_at, created_at
         FROM approval_requests
        WHERE tenant_id = $1 AND status = 'PENDING'
        ORDER BY created_at ASC
        LIMIT 100`,
      [tenantId]
    );

    return reply.send({ approvals: result.rows });
  });

  /**
   * POST /api/v1/approvals/:approval_id/grant
   * Grant an approval, creating the action execution atomically.
   */
  app.post<{
    Params: { approval_id: string };
    Body: { notes?: string };
  }>("/:approval_id/grant", async (request, reply) => {
    const { tenantId, principalId } = request.auth;

    if (!(await approvalsEnabled(tenantId))) {
      throw forbidden(
        "Approval flow is not enabled for this tenant",
        "Set tenant_config.approvals_enabled = true to enable approval flows."
      );
    }

    if (!(await isManager(tenantId, principalId))) {
      throw forbidden(
        "This principal is not authorized to approve actions",
        "Approval requires an active manager_grants entry for this tenant."
      );
    }

    const { notes } = parseBody(grantApprovalBody, request.body ?? {});

    try {
      const executionId = await completeApprovalAndEnqueue(
        tenantId,
        parseParams(approvalIdParam, request.params).approval_id,
        principalId,
        notes
      );

      return reply.status(200).send({
        outcome: "APPROVED",
        action_execution_id: executionId,
        approved_by: principalId,
        correlation_id: request.correlationId,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("not found") || msg.includes("expired")) {
        throw conflict(msg);
      }
      throw err;
    }
  });

  /**
   * POST /api/v1/approvals/:approval_id/deny
   * Deny an approval. No action execution is created.
   */
  app.post<{
    Params: { approval_id: string };
    Body: { reason?: string };
  }>("/:approval_id/deny", async (request, reply) => {
    const { tenantId, principalId } = request.auth;

    if (!(await approvalsEnabled(tenantId))) {
      throw forbidden("Approval flow is not enabled for this tenant");
    }

    if (!(await isManager(tenantId, principalId))) {
      throw forbidden("This principal is not authorized to approve actions");
    }

    const { reason } = parseBody(denyApprovalBody, request.body ?? {});

    try {
      await withTransaction(async (client) => {
        const result = await client.query<{ issue_id: string }>(
          `UPDATE approval_requests
              SET status = 'DENIED',
                  denied_at = now(),
                  assigned_manager_id = $2,
                  reason = $3,
                  updated_at = now()
            WHERE id = $1 AND tenant_id = $4 AND status = 'PENDING'
            RETURNING issue_id`,
          [
            parseParams(approvalIdParam, request.params).approval_id,
            principalId,
            reason ?? null,
            tenantId,
          ]
        );

        if (result.rows.length === 0) {
          throw new Error("Approval not found or already resolved");
        }

        await writeAuditEventTx(client, {
          tenantId,
          issueId: result.rows[0].issue_id,
          eventType: AuditEventType.APPROVAL_DENIED,
          actorType: ActorType.OPERATOR,
          actorId: principalId,
          payload: {
            approval_request_id: parseParams(approvalIdParam, request.params).approval_id,
            reason,
          },
        });
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("not found") || msg.includes("already resolved")) {
        throw conflict(msg);
      }
      throw err;
    }

    return reply.send({
      outcome: "DENIED",
      denied_by: principalId,
      correlation_id: request.correlationId,
    });
  });
}
