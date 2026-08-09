/**
 * @iisl/api — Actions Routes
 * VALIDATION: [STATIC-CONSISTENT]
 *
 * POST /api/v1/actions
 *   Initiate an agent action. Runs synchronous policy evaluation, then
 *   routes to ALLOW / DENY / REQUIRES_APPROVAL per spec Section 1.1.
 *
 * GET /api/v1/actions/:execution_id
 *   Poll action execution status.
 */
import { FastifyInstance } from "fastify";
import { query } from "../db/pool";
import { initiateAction } from "../services/actionService";
import { requireAuth } from "../middleware/auth";
import { ActionType } from "@iisl/shared";

export async function actionsRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("onRequest", requireAuth("agent"));

  /**
   * POST /api/v1/actions
   * Initiate an agent action. Always runs policy evaluation first.
   */
  app.post<{
    Body: {
      action_type: ActionType;
      issue_id: string;
      idempotency_key: string;
      action_params: Record<string, unknown>;
    };
  }>("/", async (request, reply) => {
    // Tenant and agent identity come from the credential, not the request.
    const { tenantId, principalId: agentId } = request.auth;

    const { action_type, issue_id, idempotency_key, action_params } =
      request.body;

    if (!action_type || !issue_id || !idempotency_key) {
      return reply.status(400).send({
        error: "action_type, issue_id, and idempotency_key are required",
      });
    }

    try {
      const result = await initiateAction({
        tenantId,
        issueId: issue_id,
        actionType: action_type,
        agentId,
        idempotencyKey: idempotency_key,
        actionParams: action_params ?? {},
      });

      return reply.status(200).send({
        outcome: result.outcome,
        // True when this key was already used and the original execution was
        // returned rather than a second side effect being queued.
        idempotent_replay: result.isReplay ?? false,
        action_execution_id: result.actionExecutionId ?? null,
        approval_request_id: result.approvalRequestId ?? null,
        policy_rule_id: result.policyRuleId,
        deny_reason: result.denyReason ?? null,
        unblock_path: result.unblockPath ?? null,
        correlation_id: request.correlationId,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      app.log.error({ err, tenantId, issue_id }, "Action initiation failed");
      return reply.status(500).send({ error: msg });
    }
  });

  /**
   * GET /api/v1/actions/:execution_id
   * Poll execution status. Used by sidebar on polling interval.
   */
  app.get<{ Params: { execution_id: string } }>(
    "/:execution_id",
    async (request, reply) => {
      const { tenantId } = request.auth;
      const { execution_id } = request.params;

      const result = await query<ExecutionRow>(
        `SELECT ae.id, ae.status, ae.action_type, ae.planned_state,
                ae.error, ae.attempt_count, ae.completed_at,
                ae.reconciled_at, ae.reconciliation_outcome,
                array_agg(om.status) as outbox_statuses
         FROM action_executions ae
         LEFT JOIN outbox_messages om ON om.action_execution_id = ae.id
         WHERE ae.id = $1 AND ae.tenant_id = $2
         GROUP BY ae.id`,
        [execution_id, tenantId]
      );

      if (result.rows.length === 0) {
        return reply.status(404).send({ error: "Execution not found" });
      }

      const row = result.rows[0];

      return reply.send({
        execution_id: row.id,
        status: row.status,
        action_type: row.action_type,
        planned_state: row.planned_state,
        error: row.error,
        attempt_count: row.attempt_count,
        completed_at: row.completed_at,
        is_reconciled: !!row.reconciled_at,
        reconciliation_outcome: row.reconciliation_outcome,
        correlation_id: request.correlationId,
      });
    }
  );
}

interface ExecutionRow {
  id: string;
  status: string;
  action_type: string;
  planned_state: string | null;
  error: string | null;
  attempt_count: number;
  completed_at: string | null;
  reconciled_at: string | null;
  reconciliation_outcome: string | null;
  outbox_statuses: string[];
}
