/**
 * @iisl/policy — Policy Engine
 * VALIDATION: [COMPILE-PENDING]
 *
 * Table-driven policy evaluation with:
 * - Degraded mode state × action risk tier × abuse signal level
 * - Approval toggle (approvals_enabled in tenant_config)
 * - Catch-all conservative default (REQUIRES_APPROVAL when approvals on,
 *   ALLOW when approvals off and risk is LOW/MEDIUM, DENY when risk HIGH)
 * - policy_rule_id emission for every evaluation (audit requirement)
 * - No accusation language in any generated denial reason
 *
 * Spec reference: Section 1.1, 1.2, 5.1
 */

import {
  PolicyOutcome,
  ActionRiskTier,
  AbuseSeverity,
  DegradedState,
  ActionType,
  TenantConfig,
} from "@iisl/shared";

// ─── Input / Output Types ────────────────────────────────────────────────────

export interface PolicyInput {
  tenantId: string;
  issueId: string;
  actionType: ActionType;
  agentId: string;
  /** Computed degraded state at evaluation time */
  degradedState: DegradedState;
  /** Highest abuse severity signal in the active window for this issue */
  abuseSeverity: AbuseSeverity;
  /** Action-specific context (amounts, counts, etc.) */
  context: PolicyContext;
  tenantConfig: TenantConfig;
}

export interface PolicyContext {
  /** Refund amount in cents (for threshold checks) */
  refundAmountCents?: number;
  /** Number of reopen events in trailing window */
  reopenCountInWindow?: number;
  /** Is evidence fresh? (computed from timestamps, not is_source_unavailable) */
  evidenceFresh?: boolean;
  /** Match confidence band */
  matchBand?: string;
  /** Is source permanently unavailable (tombstoned)? */
  isSourceUnavailable?: boolean;
}

export interface PolicyResult {
  outcome: PolicyOutcome;
  /** Stable rule identifier — MUST be logged to audit_log for every evaluation */
  policyRuleId: string;
  policyVersion: string;
  /** Human-readable reason for DENY outcomes. No accusation language. */
  denyReason?: string;
  /** Unblock path description for DENY outcomes */
  unblockPath?: string;
  /** Whether this outcome required degraded-mode override */
  isDegradedModeOverride: boolean;
}

// ─── Policy Rule Shape ───────────────────────────────────────────────────────

interface PolicyRule {
  id: string;
  /** Matches if degradedState is in this set (or '*' for any) */
  degradedStates: DegradedState[] | "*";
  /** Matches if actionRiskTier is in this set (or '*' for any) */
  riskTiers: ActionRiskTier[] | "*";
  /** Matches if abuseSeverity is in this set (or '*' for any) */
  abuseSeverities: AbuseSeverity[] | "*";
  /** Additional predicate for context-specific checks */
  when?: (input: PolicyInput) => boolean;
  /** Outcome when all conditions match */
  outcome: PolicyOutcome;
  /** Denial/unblock copy for DENY outcomes — no accusation language */
  denyReason?: string;
  unblockPath?: string;
}

// ─── Action Risk Tier Assignment ─────────────────────────────────────────────

/**
 * Risk tier per action type. See spec Section 5.1.
 * HIGH = money movement or irreversible external action
 * MEDIUM = agent-visible status change
 * LOW = evidence refresh, internal only
 */
export const ACTION_RISK_TIERS: Record<ActionType, ActionRiskTier> = {
  [ActionType.ISSUE_REFUND]: ActionRiskTier.HIGH,
  [ActionType.CLOSE_CONFIRMED]: ActionRiskTier.HIGH,
  [ActionType.ESCALATE_MISSING]: ActionRiskTier.MEDIUM,
  [ActionType.UPDATE_PENDING]: ActionRiskTier.MEDIUM,
  [ActionType.REOPEN_ISSUE]: ActionRiskTier.MEDIUM,
  [ActionType.REFRESH_EVIDENCE]: ActionRiskTier.LOW,
  [ActionType.POST_COMMENT]: ActionRiskTier.LOW,
  [ActionType.NOTIFY_MANAGER_APPROVAL]: ActionRiskTier.LOW,
};

// ─── Policy Rule Table ────────────────────────────────────────────────────────

/**
 * Rules are evaluated in order. First matching rule wins.
 * Catch-all rule at the end handles any unmatched combination.
 *
 * IMPORTANT: No accusation language in any denyReason or unblockPath text.
 * Show: 'Manager approval required for this action.'
 * Never show: 'Customer flagged as potential fraudster.'
 */
const POLICY_RULES: PolicyRule[] = [
  // ── Hard blocks: HIGH abuse + HIGH risk ─────────────────────────────────
  {
    id: "rule_abuse_high_risk_high_deny",
    degradedStates: "*",
    riskTiers: [ActionRiskTier.HIGH],
    abuseSeverities: [AbuseSeverity.HIGH],
    outcome: PolicyOutcome.DENY,
    denyReason:
      "This action requires additional review before it can proceed.",
    unblockPath:
      "Contact your team lead to review this case and authorize the action.",
  },

  // ── Source tombstoned + HIGH risk → DENY ────────────────────────────────
  {
    id: "rule_tombstone_high_risk_deny",
    degradedStates: [DegradedState.SOURCE_TOMBSTONED],
    riskTiers: [ActionRiskTier.HIGH],
    abuseSeverities: "*",
    when: (input) => !!input.context.isSourceUnavailable,
    outcome: PolicyOutcome.DENY,
    denyReason:
      "The source record for this case is no longer available. " +
      "This action requires manual verification before proceeding.",
    unblockPath:
      "Use the escalate path or contact your team lead to review the case record.",
  },

  // ── Degraded (unavailable) + HIGH risk → require approval / deny ─────────
  {
    id: "rule_degraded_unavailable_high_risk",
    degradedStates: [DegradedState.DEGRADED_UNAVAILABLE],
    riskTiers: [ActionRiskTier.HIGH],
    abuseSeverities: "*",
    outcome: PolicyOutcome.REQUIRES_APPROVAL,
    denyReason:
      "One or more source systems are currently unavailable. " +
      "High-value actions require manager approval in this state.",
    unblockPath: "Request manager approval or wait for source systems to recover.",
  },

  // ── Over approval threshold + HIGH risk → require approval ──────────────
  {
    id: "rule_amount_threshold_requires_approval",
    degradedStates: "*",
    riskTiers: [ActionRiskTier.HIGH],
    abuseSeverities: [AbuseSeverity.NONE, AbuseSeverity.MEDIUM],
    when: (input) =>
      (input.context.refundAmountCents ?? 0) >
      input.tenantConfig.managerApprovalThresholdCents,
    outcome: PolicyOutcome.REQUIRES_APPROVAL,
    unblockPath:
      "Manager approval is required for refunds above the configured threshold.",
  },

  // ── Degraded stale + HIGH risk → soft warning but allow ─────────────────
  {
    id: "rule_degraded_stale_high_risk_allow",
    degradedStates: [DegradedState.DEGRADED_STALE],
    riskTiers: [ActionRiskTier.HIGH],
    abuseSeverities: [AbuseSeverity.NONE],
    when: (input) => !input.context.isSourceUnavailable,
    outcome: PolicyOutcome.ALLOW,  // Soft warning shown in UI, but not blocked
  },

  // ── MEDIUM risk + HIGH abuse → require approval ──────────────────────────
  {
    id: "rule_medium_risk_high_abuse",
    degradedStates: "*",
    riskTiers: [ActionRiskTier.MEDIUM],
    abuseSeverities: [AbuseSeverity.HIGH],
    outcome: PolicyOutcome.REQUIRES_APPROVAL,
    unblockPath:
      "Additional review is required before this action can proceed.",
  },

  // ── LOW risk → always allow ───────────────────────────────────────────────
  {
    id: "rule_low_risk_allow",
    degradedStates: "*",
    riskTiers: [ActionRiskTier.LOW],
    abuseSeverities: "*",
    outcome: PolicyOutcome.ALLOW,
  },

  // ── MEDIUM/HIGH risk + nominal + no abuse → allow ────────────────────────
  {
    id: "rule_nominal_medium_high_allow",
    degradedStates: [DegradedState.NOMINAL, DegradedState.DEGRADED_STALE],
    riskTiers: [ActionRiskTier.MEDIUM, ActionRiskTier.HIGH],
    abuseSeverities: [AbuseSeverity.NONE, AbuseSeverity.MEDIUM],
    outcome: PolicyOutcome.ALLOW,
  },

  // ── Catch-all default: conservative escalation ──────────────────────────
  // If approvals enabled: REQUIRES_APPROVAL
  // If approvals disabled: DENY for HIGH risk, ALLOW for MEDIUM/LOW
  // (Applied below in evaluate() after no rule matches)
  {
    id: "rule_catch_all_default",
    degradedStates: "*",
    riskTiers: "*",
    abuseSeverities: "*",
    outcome: PolicyOutcome.REQUIRES_APPROVAL, // may be overridden by approval toggle
  },
];

const POLICY_VERSION = "refund_v1_1.1.3";

// ─── Policy Engine ────────────────────────────────────────────────────────────

/**
 * Evaluate policy for a given action attempt.
 *
 * This function NEVER throws. It always returns a PolicyResult.
 * Every result must be logged to audit_log by the caller with the
 * returned policyRuleId and policyVersion.
 */
export function evaluate(input: PolicyInput): PolicyResult {
  const riskTier = ACTION_RISK_TIERS[input.actionType];

  for (const rule of POLICY_RULES) {
    if (!matchesRule(rule, input, riskTier)) {
      continue;
    }

    let outcome = rule.outcome;
    const isDegradedModeOverride =
      input.degradedState !== DegradedState.NOMINAL &&
      rule.id !== "rule_low_risk_allow" &&
      rule.id !== "rule_nominal_medium_high_allow";

    // ── Approval toggle enforcement ──────────────────────────────────────
    // If approvals are disabled, the policy engine MUST NOT return
    // REQUIRES_APPROVAL. Remap conservatively based on risk tier.
    if (
      outcome === PolicyOutcome.REQUIRES_APPROVAL &&
      !input.tenantConfig.approvalsEnabled
    ) {
      outcome = remapRequiresApprovalWithoutToggle(riskTier);
    }

    return {
      outcome,
      policyRuleId: rule.id,
      policyVersion: POLICY_VERSION,
      denyReason: outcome === PolicyOutcome.DENY ? rule.denyReason : undefined,
      unblockPath:
        outcome === PolicyOutcome.DENY ? rule.unblockPath : undefined,
      isDegradedModeOverride,
    };
  }

  // Should never reach here — catch-all above always matches.
  // Included as a safety net.
  return safeCatchAll(input, riskTier);
}

/**
 * When approvals are disabled but a rule would return REQUIRES_APPROVAL:
 * - HIGH risk → DENY (safer than silently allowing)
 * - MEDIUM risk → ALLOW (workflow must continue)
 * - LOW risk → ALLOW
 */
function remapRequiresApprovalWithoutToggle(
  riskTier: ActionRiskTier
): PolicyOutcome {
  switch (riskTier) {
    case ActionRiskTier.HIGH:
      return PolicyOutcome.DENY;
    case ActionRiskTier.MEDIUM:
    case ActionRiskTier.LOW:
      return PolicyOutcome.ALLOW;
  }
}

function safeCatchAll(
  input: PolicyInput,
  riskTier: ActionRiskTier
): PolicyResult {
  let outcome: PolicyOutcome;

  if (input.tenantConfig.approvalsEnabled) {
    outcome = PolicyOutcome.REQUIRES_APPROVAL;
  } else {
    outcome = remapRequiresApprovalWithoutToggle(riskTier);
  }

  return {
    outcome,
    policyRuleId: "rule_catch_all_default",
    policyVersion: POLICY_VERSION,
    denyReason:
      outcome === PolicyOutcome.DENY
        ? "This action requires additional review before it can proceed."
        : undefined,
    unblockPath:
      outcome === PolicyOutcome.DENY
        ? "Contact your team lead to authorize this action."
        : undefined,
    isDegradedModeOverride: false,
  };
}

function matchesRule(
  rule: PolicyRule,
  input: PolicyInput,
  riskTier: ActionRiskTier
): boolean {
  if (
    rule.degradedStates !== "*" &&
    !rule.degradedStates.includes(input.degradedState)
  ) {
    return false;
  }
  if (rule.riskTiers !== "*" && !rule.riskTiers.includes(riskTier)) {
    return false;
  }
  if (
    rule.abuseSeverities !== "*" &&
    !rule.abuseSeverities.includes(input.abuseSeverity)
  ) {
    return false;
  }
  if (rule.when && !rule.when(input)) {
    return false;
  }
  return true;
}
