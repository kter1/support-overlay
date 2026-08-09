/**
 * @iisl/api — Action Execution Service
 * VALIDATION: [STATIC-CONSISTENT]
 *
 * Implements the core action execution lifecycle per spec Section 4.2:
 *
 * Step 1: Policy evaluation (synchronous, blocking)
 * Step 2: Atomic DB transaction (action_executions + outbox_messages)
 *         NOTE: state_transitions is NOT written here.
 *         planned_state is stored in action_executions.
 * Step 3: Return action_execution_id to agent immediately
 * Step 4: Background worker picks up outbox_messages
 * Step 5: On completion: write state_transitions, update issues.state
 * Step 6: On FAILED_TERMINAL: do NOT write state_transitions
 *
 * Approval toggle:
 * - If tenant_config.approvals_enabled = false: REQUIRES_APPROVAL never returned
 * - If approvals_enabled = true: full approval lifecycle runs
 */
import { PoolClient } from "pg";
import { randomUUID } from "crypto";
import { query, withTransaction } from "../db/pool";
import { writeAuditEventTx, AuditEventType } from "./audit";
import { evaluate } from "@iisl/policy";
import {
  PolicyOutcome,
  ActionType,
  ActorType,
  DegradedState,
  AbuseSeverity,
  IssueState,
} from "@iisl/shared";
import { buildEffectsForAction } from "./effects";
import { computeFreshness } from "./freshness";

export interface InitiateActionInput {
  tenantId: string;
  issueId: string;
  actionType: ActionType;
  agentId: string;
  /** Caller-supplied idempotency key (e.g. UUID from sidebar) */
  idempotencyKey: string;
  /** Action-specific parameters */
  actionParams: Record<string, unknown>;
}

export interface InitiateActionResult {
  outcome: PolicyOutcome;
  actionExecutionId?: string;
  approvalRequestId?: string;
  policyRuleId: string;
  denyReason?: string;
  unblockPath?: string;
  /** True when the idempotency key matched an existing execution. */
  isReplay?: boolean;
}

/**
 * Initiate an agent action. This is the single entry point for all
 * agent-triggered actions. It enforces the mandatory evaluation sequence.
 */
export async function initiateAction(
  input: InitiateActionInput
): Promise<InitiateActionResult> {
  // ── 0. Idempotency ───────────────────────────────────────────────────────
  // A replayed submit (double-click, client retry) must resolve to the original
  // execution rather than queueing a second side effect or 500-ing on the
  // unique constraint.
  const replay = await findExecutionByIdempotencyKey(
    input.tenantId,
    input.idempotencyKey
  );

  if (replay) {
    return {
      outcome: PolicyOutcome.ALLOW,
      actionExecutionId: replay.id,
      policyRuleId: replay.policy_rule_id ?? "rule_idempotent_replay",
      isReplay: true,
    };
  }

  // ── 1. Load issue + tenant config ────────────────────────────────────────
  // Columns are listed explicitly: `i.*, tc.*` collided on id/tenant_id, and
  // node-postgres keeps the last column of a given name, so issue.id was
  // actually tenant_config.id.
  const issueRow = await query<IssueRow>(
    `SELECT i.id, i.tenant_id, i.state, i.lock_version,
            tc.evidence_freshness_seconds,
            tc.refund_amount_tolerance_pct,
            tc.reopen_gate_count,
            tc.manager_approval_threshold_cents,
            tc.manager_approval_group_id,
            tc.approvals_enabled,
            tc.macro_prefix_resolved,
            tc.macro_prefix_pending
       FROM issues i
       JOIN tenant_config tc ON tc.tenant_id = i.tenant_id
      WHERE i.id = $1 AND i.tenant_id = $2`,
    [input.issueId, input.tenantId]
  );

  if (issueRow.rows.length === 0) {
    throw new Error(`Issue ${input.issueId} not found for tenant ${input.tenantId}`);
  }

  const issue = issueRow.rows[0];

  // ── 2. Compute degraded state and abuse severity ──────────────────────────
  const { degradedState, isSourceUnavailable } =
    await computeDegradedState(input.tenantId, input.issueId);
  const abuseSeverity = await computeAbuseSeverity(
    input.tenantId,
    input.issueId
  );

  // ── 3. Load evidence context ──────────────────────────────────────────────
  const evidenceRow = await query<EvidenceRow>(
    `SELECT en.refund_amount_cents, en.is_source_unavailable, en.fetched_at,
            emr.match_band, emr.confidence_score
     FROM evidence_normalized en
     LEFT JOIN evidence_match_results emr ON emr.evidence_normalized_id = en.id
     WHERE en.issue_id = $1 AND en.tenant_id = $2
     ORDER BY en.fetched_at DESC LIMIT 1`,
    [input.issueId, input.tenantId]
  );

  const evidence = evidenceRow.rows[0];
  const evidenceFreshnessSeconds = issue.evidence_freshness_seconds ?? 300;
  const amountMatchTolerancePct = parseFloat(issue.refund_amount_tolerance_pct ?? "2");
  const freshness = computeFreshness({
    fetchedAt: evidence?.fetched_at ? new Date(evidence.fetched_at) : null,
    freshnessWindowSeconds: evidenceFreshnessSeconds,
    isSourceUnavailable: evidence?.is_source_unavailable ?? false,
  });

  // ── 4. Build tenant config for policy engine ──────────────────────────────
  const tenantConfig = {
    evidenceFreshnessSeconds,
    amountMatchTolerancePct,
    reopenGateCount: issue.reopen_gate_count ?? 3,
    managerApprovalThresholdCents: issue.manager_approval_threshold_cents ?? 5000,
    managerApprovalGroupId: issue.manager_approval_group_id ?? null,
    approvalsEnabled: issue.approvals_enabled ?? false,
    macroPrefixResolved: issue.macro_prefix_resolved ?? "",
    macroPrefixPending: issue.macro_prefix_pending ?? "",
  };

  // ── 5. Policy evaluation (synchronous, blocking) ──────────────────────────
  const policyResult = evaluate({
    tenantId: input.tenantId,
    issueId: input.issueId,
    actionType: input.actionType,
    agentId: input.agentId,
    degradedState,
    abuseSeverity,
    context: {
      refundAmountCents: evidence?.refund_amount_cents ?? undefined,
      evidenceFresh: freshness.isFresh,
      matchBand: evidence?.match_band ?? undefined,
      isSourceUnavailable,
    },
    tenantConfig,
  });

  // ── 6. Log policy decision to audit (EVERY evaluation, mandatory) ─────────
  await query(
    `INSERT INTO audit_log
       (tenant_id, issue_id, event_type, actor_type, actor_id, payload,
        policy_rule_id, policy_version)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      input.tenantId,
      input.issueId,
      AuditEventType.POLICY_DECISION,
      ActorType.AGENT,
      input.agentId,
      JSON.stringify({
        action_type: input.actionType,
        outcome: policyResult.outcome,
        degraded_state: degradedState,
        abuse_severity: abuseSeverity,
        idempotency_key: input.idempotencyKey,
      }),
      policyResult.policyRuleId,
      policyResult.policyVersion,
    ]
  );

  // ── 7. Route by policy outcome ────────────────────────────────────────────

  if (policyResult.outcome === PolicyOutcome.DENY) {
    // Log denial — no action_executions row created
    return {
      outcome: PolicyOutcome.DENY,
      policyRuleId: policyResult.policyRuleId,
      denyReason: policyResult.denyReason,
      unblockPath: policyResult.unblockPath,
    };
  }

  if (policyResult.outcome === PolicyOutcome.REQUIRES_APPROVAL) {
    // Create approval_requests row — no action_executions row yet
    const approvalId = await createApprovalRequest(input, issue, policyResult);
    return {
      outcome: PolicyOutcome.REQUIRES_APPROVAL,
      approvalRequestId: approvalId,
      policyRuleId: policyResult.policyRuleId,
    };
  }

  // PolicyOutcome.ALLOW → create action_executions + outbox atomically
  try {
    const executionId = await createActionExecution(input, issue, policyResult);

    return {
      outcome: PolicyOutcome.ALLOW,
      actionExecutionId: executionId,
      policyRuleId: policyResult.policyRuleId,
    };
  } catch (err) {
    // Two concurrent submits with the same key: the loser resolves to the
    // winner's execution instead of surfacing a constraint violation.
    if (isUniqueViolation(err)) {
      const existing = await findExecutionByIdempotencyKey(
        input.tenantId,
        input.idempotencyKey
      );
      if (existing) {
        return {
          outcome: PolicyOutcome.ALLOW,
          actionExecutionId: existing.id,
          policyRuleId: existing.policy_rule_id ?? policyResult.policyRuleId,
          isReplay: true,
        };
      }
    }
    throw err;
  }
}

/** Postgres unique_violation. */
function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { code?: string }).code === "23505"
  );
}

async function findExecutionByIdempotencyKey(
  tenantId: string,
  idempotencyKey: string
): Promise<{ id: string; policy_rule_id: string | null } | null> {
  const result = await query<{ id: string; policy_rule_id: string | null }>(
    `SELECT id, policy_rule_id FROM action_executions
      WHERE tenant_id = $1 AND idempotency_key = $2
      LIMIT 1`,
    [tenantId, idempotencyKey]
  );
  return result.rows[0] ?? null;
}

// ─── Create action_executions + outbox_messages atomically ───────────────────

async function createActionExecution(
  input: InitiateActionInput,
  issue: IssueRow,
  policyResult: { policyRuleId: string; policyVersion: string },
  approvalRequestId?: string,
  /**
   * Existing transaction to join. Callers already inside a transaction must
   * pass their client — opening a nested withTransaction() would check out a
   * second pooled connection, so the approval update and the execution insert
   * would land in separate transactions and could not roll back together.
   */
  existingClient?: PoolClient
): Promise<string> {
  const run = async (client: PoolClient): Promise<string> => {
    const executionId = randomUUID();
    const plannedState = deriveTargetState(input.actionType);

    // Insert action_executions row (PENDING)
    // planned_state is stored here — NOT written to state_transitions
    await client.query(
      `INSERT INTO action_executions
         (id, tenant_id, issue_id, action_type, requested_by_agent_id,
          idempotency_key, planned_state, status, policy_rule_id, policy_version,
          approval_request_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'PENDING', $8, $9, $10)`,
      [
        executionId,
        input.tenantId,
        input.issueId,
        input.actionType,
        input.agentId,
        input.idempotencyKey,
        plannedState,
        policyResult.policyRuleId,
        policyResult.policyVersion,
        approvalRequestId ?? null,
      ]
    );

    // Insert outbox_messages for each required external call
    const effects = buildEffectsForAction(
      input.actionType,
      executionId,
      input.actionParams
    );

    for (const effect of effects) {
      await client.query(
        `INSERT INTO outbox_messages
           (tenant_id, action_execution_id, target_system, payload,
            idempotency_key, status, effects)
         VALUES ($1, $2, $3, $4, $5, 'PENDING', $6)`,
        [
          input.tenantId,
          executionId,
          effect.targetSystem,
          JSON.stringify(effect.payload),
          effect.idempotencyKey,
          JSON.stringify([effect.initialLedgerEntry]),
        ]
      );
    }

    // Audit: action execution created
    await writeAuditEventTx(client, {
      tenantId: input.tenantId,
      issueId: input.issueId,
      eventType: AuditEventType.ACTION_EXECUTION_CREATED,
      actorType: ActorType.AGENT,
      actorId: input.agentId,
      payload: {
        action_execution_id: executionId,
        action_type: input.actionType,
        planned_state: plannedState,
        approval_request_id: approvalRequestId ?? null,
      },
      policyRuleId: policyResult.policyRuleId,
      policyVersion: policyResult.policyVersion,
    });

    return executionId;
  };

  return existingClient ? run(existingClient) : withTransaction(run);
}

// ─── Create approval_requests row ────────────────────────────────────────────

async function createApprovalRequest(
  input: InitiateActionInput,
  issue: IssueRow,
  policyResult: { policyRuleId: string; policyVersion: string }
): Promise<string> {
  return withTransaction(async (client) => {
    const approvalId = randomUUID();
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24h TTL

    await client.query(
      `INSERT INTO approval_requests
         (id, tenant_id, issue_id, requested_by_agent_id, action_type,
          action_payload, approval_policy_code, assigned_queue, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        approvalId,
        input.tenantId,
        input.issueId,
        input.agentId,
        input.actionType,
        JSON.stringify(input.actionParams),
        policyResult.policyRuleId,
        issue.manager_approval_group_id ?? "default_manager_queue",
        expiresAt.toISOString(),
      ]
    );

    await writeAuditEventTx(client, {
      tenantId: input.tenantId,
      issueId: input.issueId,
      eventType: AuditEventType.ACTION_REQUIRES_APPROVAL,
      actorType: ActorType.AGENT,
      actorId: input.agentId,
      payload: {
        approval_request_id: approvalId,
        action_type: input.actionType,
        expires_at: expiresAt.toISOString(),
      },
      policyRuleId: policyResult.policyRuleId,
      policyVersion: policyResult.policyVersion,
    });

    return approvalId;
  });
}

/**
 * Complete an approved action: atomically transition approval, create execution row.
 * Called by approval grant endpoint.
 */
export async function completeApprovalAndEnqueue(
  tenantId: string,
  approvalId: string,
  managerId: string,
  notes?: string
): Promise<string> {
  return withTransaction(async (client) => {
    // Load and lock approval request
    const approvalResult = await client.query<ApprovalRow>(
      `SELECT * FROM approval_requests
       WHERE id = $1 AND tenant_id = $2 AND status = 'PENDING'
       FOR UPDATE`,
      [approvalId, tenantId]
    );

    if (approvalResult.rows.length === 0) {
      throw new Error(
        `Approval ${approvalId} not found, not pending, or already processed`
      );
    }

    const approval = approvalResult.rows[0];

    // Check expiry
    if (approval.expires_at && new Date(approval.expires_at) < new Date()) {
      await client.query(
        `UPDATE approval_requests
         SET status = 'EXPIRED', updated_at = now()
         WHERE id = $1`,
        [approvalId]
      );
      throw new Error(`Approval ${approvalId} has expired`);
    }

    // Mark approval as APPROVED
    await client.query(
      `UPDATE approval_requests
          SET status = 'APPROVED',
              approved_at = now(),
              assigned_manager_id = $2,
              reason = COALESCE($3, reason),
              updated_at = now()
        WHERE id = $1`,
      [approvalId, managerId, notes ?? null]
    );

    // The issue's real current state drives planned_state. Passing a hardcoded
    // OPEN here meant planned_state was derived from the wrong base, and the
    // later state transition would fail its from-state guard.
    const issueResult = await client.query<{ state: IssueState }>(
      `SELECT state FROM issues WHERE id = $1 AND tenant_id = $2`,
      [approval.issue_id, tenantId]
    );

    if (issueResult.rows.length === 0) {
      throw new Error(`Issue ${approval.issue_id} not found`);
    }

    // Create action_executions row (atomically with approval status change)
    const executionId = await createActionExecution(
      {
        tenantId,
        issueId: approval.issue_id,
        actionType: approval.action_type as ActionType,
        agentId: approval.requested_by_agent_id,
        idempotencyKey: `approval_${approvalId}`,
        actionParams: approval.action_payload,
      },
      { state: issueResult.rows[0].state } as IssueRow,
      { policyRuleId: approval.approval_policy_code, policyVersion: "approval_grant" },
      approvalId,
      client
    );

    // Link approval to execution
    await client.query(
      `UPDATE approval_requests
       SET linked_action_execution_id = $2
       WHERE id = $1`,
      [approvalId, executionId]
    );

    await writeAuditEventTx(client, {
      tenantId,
      issueId: approval.issue_id,
      eventType: AuditEventType.APPROVAL_GRANTED,
      actorType: ActorType.OPERATOR,
      actorId: managerId,
      payload: {
        approval_request_id: approvalId,
        action_execution_id: executionId,
        action_type: approval.action_type,
      },
    });

    return executionId;
  });
}

// ─── Apply completed state transition to canonical tables ────────────────────

/**
 * Called by the worker AFTER external execution confirms.
 * ONLY point where state_transitions is written.
 * issues.state updated via lock_version guard.
 */
export async function applyStateTransition(
  client: PoolClient,
  tenantId: string,
  issueId: string,
  fromState: string,
  toState: string,
  actionExecutionId: string,
  triggerEvent: string,
  actorId: string
): Promise<void> {
  // Write to state_transitions (applied canonical change, not intent)
  await client.query(
    `INSERT INTO state_transitions
       (tenant_id, issue_id, from_state, to_state, action_execution_id,
        trigger_event, actor_type, actor_id)
     VALUES ($1, $2, $3, $4, $5, $6, 'system', $7)`,
    [tenantId, issueId, fromState, toState, actionExecutionId, triggerEvent, actorId]
  );

  // Update issues.state with lock_version guard
  const result = await client.query(
    `UPDATE issues
     SET state = $1, lock_version = lock_version + 1, updated_at = now()
     WHERE id = $2 AND tenant_id = $3 AND state = $4`,
    [toState, issueId, tenantId, fromState]
  );

  if (result.rowCount === 0) {
    throw new Error(
      `State transition failed: issue ${issueId} not in expected state ${fromState}. ` +
      `Possible concurrent modification.`
    );
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function deriveTargetState(actionType: ActionType): IssueState | null {
  const transitions: Partial<Record<ActionType, IssueState>> = {
    [ActionType.CLOSE_CONFIRMED]: IssueState.RESOLVED,
    [ActionType.ESCALATE_MISSING]: IssueState.BLOCKED,
    [ActionType.UPDATE_PENDING]: IssueState.AWAITING_FULFILLMENT,
    [ActionType.REOPEN_ISSUE]: IssueState.OPEN,
  };
  return transitions[actionType] ?? null;
}

async function computeDegradedState(
  tenantId: string,
  issueId: string
): Promise<{ degradedState: DegradedState; isSourceUnavailable: boolean }> {
  const result = await query<{ is_source_unavailable: boolean; fetched_at: string }>(
    `SELECT is_source_unavailable, fetched_at
     FROM evidence_normalized
     WHERE tenant_id = $1 AND issue_id = $2
     ORDER BY fetched_at DESC LIMIT 1`,
    [tenantId, issueId]
  );

  if (result.rows.length === 0) {
    return { degradedState: DegradedState.NOMINAL, isSourceUnavailable: false };
  }

  const { is_source_unavailable } = result.rows[0];

  if (is_source_unavailable) {
    return {
      degradedState: DegradedState.SOURCE_TOMBSTONED,
      isSourceUnavailable: true,
    };
  }

  return { degradedState: DegradedState.NOMINAL, isSourceUnavailable: false };
}

async function computeAbuseSeverity(
  tenantId: string,
  issueId: string
): Promise<AbuseSeverity> {
  // Count risk signals in trailing 30-day window
  const result = await query<{ severity: string; count: string }>(
    `SELECT severity, COUNT(*) as count
     FROM risk_signals
     WHERE tenant_id = $1 AND issue_id = $2
       AND created_at > now() - interval '30 days'
     GROUP BY severity`,
    [tenantId, issueId]
  );

  for (const row of result.rows) {
    if (row.severity === "HIGH" && parseInt(row.count) >= 1) {
      return AbuseSeverity.HIGH;
    }
  }

  for (const row of result.rows) {
    if (row.severity === "MEDIUM" && parseInt(row.count) >= 2) {
      return AbuseSeverity.MEDIUM;
    }
  }

  return AbuseSeverity.NONE;
}

// ─── Row type definitions ─────────────────────────────────────────────────────

interface IssueRow {
  id?: string;
  tenant_id?: string;
  state: IssueState;
  lock_version?: number;
  evidence_freshness_seconds?: number;
  refund_amount_tolerance_pct?: string;
  reopen_gate_count?: number;
  manager_approval_threshold_cents?: number;
  manager_approval_group_id?: string;
  approvals_enabled?: boolean;
  macro_prefix_resolved?: string;
  macro_prefix_pending?: string;
}

interface EvidenceRow {
  refund_amount_cents: number | null;
  is_source_unavailable: boolean;
  fetched_at: string | null;
  match_band: string | null;
  confidence_score: string | null;
}

interface ApprovalRow {
  id: string;
  issue_id: string;
  requested_by_agent_id: string;
  action_type: string;
  action_payload: Record<string, unknown>;
  approval_policy_code: string;
  expires_at: string | null;
}
