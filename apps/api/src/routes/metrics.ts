/**
 * @iisl/api — Metrics Routes (Observability Thin Slice)
 * VALIDATION: [STATIC-CONSISTENT]
 *
 * Minimal metrics computed from DB queries. No external metrics server required.
 * Instrumented per spec Section 10 phasing:
 * - Weeks 4-6: webhook lag, stale evidence rate, source outage detection
 * - Weeks 9-10: action_executions failure rate (added when lifecycle built)
 *
 * Note: action_executions failure rate is present here since the lifecycle
 * IS implemented in this build. The spec phasing was for incremental delivery;
 * the full build includes it from the start.
 */
import { FastifyInstance } from "fastify";
import { query } from "../db/pool";
import { requireAuth } from "../middleware/auth";

export async function metricsRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("onRequest", requireAuth("agent", "operator"));

  app.get("/", async (request, reply) => {
    const { tenantId } = request.auth;

    const [
      webhookLag,
      staleEvidence,
      outboxBacklog,
      executionFailureRate,
      cardStateDrift,
    ] = await Promise.all([
      getWebhookLagMetric(tenantId),
      getStaleEvidenceRate(tenantId),
      getOutboxBacklog(tenantId),
      getExecutionFailureRate(tenantId),
      getCardStateDrift(tenantId),
    ]);

    return reply.send({
      tenant_id: tenantId,
      computed_at: new Date().toISOString(),
      metrics: {
        webhook_processing_lag: webhookLag,
        stale_evidence_rate: staleEvidence,
        outbox_backlog: outboxBacklog,
        action_execution_failure_rate: executionFailureRate,
        card_state_drift: cardStateDrift,
      },
      alerts: buildAlerts({
        webhookLag,
        staleEvidence,
        outboxBacklog,
        executionFailureRate,
      }),
    });
  });
}

// ─── Metric implementations ───────────────────────────────────────────────────

async function getWebhookLagMetric(
  tenantId: string
): Promise<{ avg_seconds: number; max_seconds: number; sample_count: number }> {
  const result = await query<{
    avg_lag: string;
    max_lag: string;
    count: string;
  }>(
    `SELECT
       EXTRACT(EPOCH FROM AVG(processed_at - received_at))::numeric(10,2) as avg_lag,
       EXTRACT(EPOCH FROM MAX(processed_at - received_at))::numeric(10,2) as max_lag,
       COUNT(*) as count
     FROM inbound_events
     WHERE tenant_id = $1
       AND status = 'PROCESSED'
       AND processed_at IS NOT NULL
       AND received_at > now() - interval '1 hour'`,
    [tenantId]
  );

  const row = result.rows[0];
  return {
    avg_seconds: parseFloat(row.avg_lag) || 0,
    max_seconds: parseFloat(row.max_lag) || 0,
    sample_count: parseInt(row.count),
  };
}

async function getStaleEvidenceRate(
  tenantId: string
): Promise<{
  source_unavailable_count: number;
  active_issue_count: number;
  rate_pct: number;
}> {
  const result = await query<{
    unavailable: string;
    total: string;
  }>(
    `SELECT
       COUNT(*) FILTER (WHERE en.is_source_unavailable = true) as unavailable,
       COUNT(*) as total
     FROM issues i
     LEFT JOIN evidence_normalized en ON en.issue_id = i.id AND en.tenant_id = i.tenant_id
     WHERE i.tenant_id = $1 AND i.state != 'RESOLVED'`,
    [tenantId]
  );

  const { unavailable, total } = result.rows[0];
  const unavailableCount = parseInt(unavailable);
  const totalCount = parseInt(total);
  const rate = totalCount > 0 ? (unavailableCount / totalCount) * 100 : 0;

  return {
    source_unavailable_count: unavailableCount,
    active_issue_count: totalCount,
    rate_pct: Math.round(rate * 100) / 100,
  };
}

async function getOutboxBacklog(
  tenantId: string
): Promise<{ pending_count: number; failed_retriable_count: number }> {
  const result = await query<{ status: string; count: string }>(
    `SELECT status, COUNT(*) as count
     FROM outbox_messages
     WHERE tenant_id = $1 AND status IN ('PENDING', 'FAILED_RETRIABLE')
     GROUP BY status`,
    [tenantId]
  );

  const counts: Record<string, number> = {};
  for (const row of result.rows) {
    counts[row.status] = parseInt(row.count);
  }

  return {
    pending_count: counts["PENDING"] ?? 0,
    failed_retriable_count: counts["FAILED_RETRIABLE"] ?? 0,
  };
}

async function getExecutionFailureRate(
  tenantId: string
): Promise<{ terminal_count: number; total_count: number; rate_pct: number }> {
  const result = await query<{ status: string; count: string }>(
    `SELECT status, COUNT(*) as count
     FROM action_executions
     WHERE tenant_id = $1
       AND created_at > now() - interval '1 hour'
       AND status IN ('COMPLETED', 'FAILED_TERMINAL')
     GROUP BY status`,
    [tenantId]
  );

  const counts: Record<string, number> = {};
  for (const row of result.rows) counts[row.status] = parseInt(row.count);

  const terminal = counts["FAILED_TERMINAL"] ?? 0;
  const completed = counts["COMPLETED"] ?? 0;
  const total = terminal + completed;
  const rate = total > 0 ? (terminal / total) * 100 : 0;

  return {
    terminal_count: terminal,
    total_count: total,
    rate_pct: Math.round(rate * 100) / 100,
  };
}

async function getCardStateDrift(
  tenantId: string
): Promise<{ drift_count: number; description: string }> {
  // Detect issues where issues.state != issue_card_state.issue_state
  const result = await query<{ count: string }>(
    `SELECT COUNT(*) as count
     FROM issues i
     JOIN issue_card_state cs ON cs.issue_id = i.id
     WHERE i.tenant_id = $1 AND i.state != cs.issue_state`,
    [tenantId]
  );

  const count = parseInt(result.rows[0].count);
  return {
    drift_count: count,
    description:
      count > 0
        ? `${count} issue(s) have mismatched state between issues.state and issue_card_state`
        : "No drift detected",
  };
}

// ─── Alert thresholds ─────────────────────────────────────────────────────────

interface AlertInputs {
  webhookLag: { avg_seconds: number };
  staleEvidence: { rate_pct: number };
  outboxBacklog: { failed_retriable_count: number };
  executionFailureRate: { rate_pct: number };
}

function buildAlerts(inputs: AlertInputs): string[] {
  const alerts: string[] = [];

  if (inputs.webhookLag.avg_seconds > 30) {
    alerts.push(
      `ALERT: webhook processing lag ${inputs.webhookLag.avg_seconds}s > 30s threshold`
    );
  }

  if (inputs.staleEvidence.rate_pct > 10) {
    alerts.push(
      `ALERT: source unavailable rate ${inputs.staleEvidence.rate_pct}% > 10% threshold`
    );
  }

  if (inputs.outboxBacklog.failed_retriable_count > 50) {
    alerts.push(
      `ALERT: outbox FAILED_RETRIABLE backlog ${inputs.outboxBacklog.failed_retriable_count} > 50 threshold`
    );
  }

  if (inputs.executionFailureRate.rate_pct > 2) {
    alerts.push(
      `ALERT: action execution FAILED_TERMINAL rate ${inputs.executionFailureRate.rate_pct}% > 2% threshold`
    );
  }

  return alerts;
}
