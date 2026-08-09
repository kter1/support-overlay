/**
 * @iisl/shared — Canonical Enums, Types, and Contracts
 *
 * VALIDATION: [COMPILE-PENDING] — requires local npm install
 *
 * This file is the authoritative source of truth for all status enums,
 * policy outcomes, and vocabulary used across API, worker, policy engine,
 * and sidebar. No other file may define these; import from here.
 *
 * Spelling note: FAILED_RETRIABLE is the normalized spelling throughout.
 * An earlier draft used FAILED_RETRYABLE in some effects-ledger contexts;
 * that has been corrected. One enum, one spelling.
 */
// ─── Policy Outcomes ────────────────────────────────────────────────────────

/**
 * Mutually exclusive, exhaustive results of preflight policy evaluation.
 * Every agent-initiated action resolves to exactly one of these.
 *
 * ALLOW           → create action_executions row, enqueue
 * DENY            → log denial audit event, no row created
 * REQUIRES_APPROVAL → create approval_requests row, no execution row yet
 *
 * Note: if tenant_config.approvals_enabled = false, the policy engine
 * must NEVER return REQUIRES_APPROVAL. It must return ALLOW or DENY only.
 */
export enum PolicyOutcome {
  ALLOW = "ALLOW",
  DENY = "DENY",
  REQUIRES_APPROVAL = "REQUIRES_APPROVAL",
}

// ─── Approval Request Lifecycle ──────────────────────────────────────────────

export enum ApprovalStatus {
  PENDING = "PENDING",
  APPROVED = "APPROVED",
  DENIED = "DENIED",
  EXPIRED = "EXPIRED",
  CANCELLED = "CANCELLED",
}

// ─── Action Execution Lifecycle ──────────────────────────────────────────────

/**
 * Status of an action_executions row.
 *
 * FAILED_RETRIABLE → retry budget not yet exhausted, automatic retry scheduled
 * FAILED_TERMINAL  → retry budget exhausted OR permanent downstream error.
 *                    This is the ONLY terminal execution failure status.
 *                    It does NOT represent policy denial (DENY is a policy outcome,
 *                    not an execution outcome). FAILED_TERMINAL requires operator
 *                    reconciliation within the defined SLA.
 */
export enum ExecutionStatus {
  PENDING = "PENDING",
  IN_PROGRESS = "IN_PROGRESS",
  COMPLETED = "COMPLETED",
  FAILED_RETRIABLE = "FAILED_RETRIABLE",
  FAILED_TERMINAL = "FAILED_TERMINAL",
}

// ─── Outbox Message Lifecycle ────────────────────────────────────────────────

export enum OutboxStatus {
  PENDING = "PENDING",
  SENT = "SENT",
  FAILED_RETRIABLE = "FAILED_RETRIABLE",
  FAILED_TERMINAL = "FAILED_TERMINAL",
}

// ─── Effects Ledger outcome_status ───────────────────────────────────────────

/**
 * Per-attempt outcome status in outbox_messages.effects JSONB ledger.
 *
 * INTENDED         → effect recorded before send; network call not yet made
 * SENT_ACKED       → provider returned explicit success response
 * SENT_UNCERTAIN   → request dispatched; response timed out (UNKNOWN outcome)
 *                    → Do NOT retry immediately. Follow action-type retry policy.
 * CONFIRMED        → effect verified as completed (via ack or reconciliation read)
 * FAILED_RETRIABLE → provider returned retryable error; retry scheduled
 * FAILED_TERMINAL  → permanent error or budget exhausted; operator required
 */
export enum EffectOutcomeStatus {
  INTENDED = "INTENDED",
  SENT_ACKED = "SENT_ACKED",
  SENT_UNCERTAIN = "SENT_UNCERTAIN",
  CONFIRMED = "CONFIRMED",
  FAILED_RETRIABLE = "FAILED_RETRIABLE",
  FAILED_TERMINAL = "FAILED_TERMINAL",
}

// ─── Inbound Event Status ────────────────────────────────────────────────────

export enum InboundEventStatus {
  RECEIVED = "RECEIVED",
  PROCESSING = "PROCESSING",
  PROCESSED = "PROCESSED",
  FAILED = "FAILED",
  DUPLICATE = "DUPLICATE",
}

// ─── Issue State Machine ─────────────────────────────────────────────────────

/**
 * Canonical issue states. Only four states.
 * Reopen is an event (recorded in reopen_events), not a state.
 * No REOPENED state exists.
 */
export enum IssueState {
  OPEN = "OPEN",
  AWAITING_FULFILLMENT = "AWAITING_FULFILLMENT",
  BLOCKED = "BLOCKED",
  RESOLVED = "RESOLVED",
}

// ─── Action Types (Refund Playbook) ──────────────────────────────────────────

/**
 * All action types defined for Phase 1 Refund Resolution Playbook.
 * Each action type has a corresponding retry classification (see RetryClass).
 */
export enum ActionType {
  /** Money movement: create a Stripe refund. Highest-risk action. */
  ISSUE_REFUND = "issue_refund",
  CLOSE_CONFIRMED = "close_confirmed",
  ESCALATE_MISSING = "escalate_missing",
  UPDATE_PENDING = "update_pending",
  REOPEN_ISSUE = "reopen_issue",
  REFRESH_EVIDENCE = "refresh_evidence",
  POST_COMMENT = "post_comment",
  NOTIFY_MANAGER_APPROVAL = "notify_manager_approval",
}

// ─── Retry Classification ────────────────────────────────────────────────────

/**
 * Retry class per action type.
 * This is the authoritative classification — do not use generic retry behavior.
 *
 * SAFE_AUTO_RETRY           → idempotent; retry automatically with backoff
 * AUTO_RETRY_WITH_DEDUPE    → retry only after effects-ledger dedupe check
 * RECONCILIATION_FIRST      → read provider state before any retry
 * OPERATOR_RETRY_ONLY       → NO automatic retry; operator must confirm and trigger
 * BEST_EFFORT_NO_BLOCK      → one attempt only; failure logs warning but does not block
 * LOCAL_TRANSACTIONAL       → DB only; not subject to outbox retry
 */
export enum RetryClass {
  SAFE_AUTO_RETRY = "SAFE_AUTO_RETRY",
  AUTO_RETRY_WITH_DEDUPE = "AUTO_RETRY_WITH_DEDUPE",
  RECONCILIATION_FIRST = "RECONCILIATION_FIRST",
  OPERATOR_RETRY_ONLY = "OPERATOR_RETRY_ONLY",
  BEST_EFFORT_NO_BLOCK = "BEST_EFFORT_NO_BLOCK",
  LOCAL_TRANSACTIONAL = "LOCAL_TRANSACTIONAL",
}

/**
 * Authoritative retry classification per action type.
 * See spec Section 4.2.3.
 */
export const ACTION_RETRY_CLASS: Record<ActionType, RetryClass> = {
  // Never auto-retried. An uncertain refund is escalated to an operator.
  [ActionType.ISSUE_REFUND]: RetryClass.OPERATOR_RETRY_ONLY,
  [ActionType.CLOSE_CONFIRMED]: RetryClass.RECONCILIATION_FIRST,
  [ActionType.ESCALATE_MISSING]: RetryClass.SAFE_AUTO_RETRY,
  [ActionType.UPDATE_PENDING]: RetryClass.RECONCILIATION_FIRST,
  [ActionType.REOPEN_ISSUE]: RetryClass.LOCAL_TRANSACTIONAL,
  [ActionType.REFRESH_EVIDENCE]: RetryClass.SAFE_AUTO_RETRY,
  [ActionType.POST_COMMENT]: RetryClass.AUTO_RETRY_WITH_DEDUPE,
  [ActionType.NOTIFY_MANAGER_APPROVAL]: RetryClass.BEST_EFFORT_NO_BLOCK,
};

// ─── Source Systems ───────────────────────────────────────────────────────────

export enum SourceSystem {
  ZENDESK = "zendesk",
  STRIPE = "stripe",
  SHOPIFY = "shopify",
}

// ─── Evidence / Refund Status ─────────────────────────────────────────────────

export enum RefundStatus {
  SUCCEEDED = "succeeded",
  PENDING = "pending",
  FAILED = "failed",
  NOT_FOUND = "not_found",
}

// ─── Match Confidence Bands ───────────────────────────────────────────────────

export enum MatchBand {
  EXACT = "EXACT",       // >= 98% confidence
  HIGH = "HIGH",         // 85–97%
  MEDIUM = "MEDIUM",     // 70–84%
  LOW = "LOW",           // 50–69%
  NO_MATCH = "NO_MATCH", // < 50%
}

// ─── UI State Vocabulary ─────────────────────────────────────────────────────

/**
 * Canonical UI state labels. Frontend must use these exactly.
 * Do not invent new labels in the sidebar component.
 * See spec Section 6.3.
 */
export const UI_LABELS = {
  // Evidence states
  REFUND_POSTED: "Refund Posted",
  REFUND_PENDING: "Refund Pending",
  NO_REFUND_FOUND: "No Refund Found",
  SOURCE_UNAVAILABLE: "Unable to verify — source unavailable",

  // Action execution states
  ACTION_QUEUED: "Action submitted — processing",
  ACTION_RETRYING: "Action retrying — check back shortly",
  ACTION_COMPLETE: "Action complete",
  ACTION_FAILED: "Action failed — contact support",

  // Policy states (no accusation language)
  BLOCKED_BY_POLICY: "Manager approval required for this action",
  AWAITING_APPROVAL: "Awaiting manager approval",
  REQUEST_DENIED: "Request denied",
  APPROVAL_EXPIRED: "Approval expired — please re-request",
} as const;

// ─── Freshness Semantics ──────────────────────────────────────────────────────

/**
 * Freshness is computed from timestamps at read time, NOT stored as a flag.
 *
 * is_source_unavailable is a SEPARATE persisted flag on evidence_normalized
 * for tombstone/archival state (deleted, merged, permanently unreachable).
 *
 * Do not conflate these two concepts.
 */
export interface FreshnessState {
  /** Whether the evidence is within the configured freshness window */
  isFresh: boolean;
  /** Age of evidence in seconds */
  ageSeconds: number;
  /** Freshness window configured for this tenant (seconds) */
  freshnessWindowSeconds: number;
  /** Whether the evidence is usable despite staleness (< 3x window) */
  isUsableDespiteStale: boolean;
  /**
   * Persisted source-unavailability flag.
   * Set when source record is archived, deleted, merged, or permanently unreachable.
   * NOT a time-based freshness indicator.
   */
  isSourceUnavailable: boolean;
}

// ─── Effects Ledger Entry ─────────────────────────────────────────────────────

/**
 * Canonical shape of one entry in outbox_messages.effects JSONB array.
 * All fields are required. Entries are append-only; prior attempts are never deleted.
 * See spec Section 4.2.2 for field semantics.
 */
export interface EffectLedgerEntry {
  /** e.g. "zendesk_comment_post", "zendesk_status_set", "stripe_refund_check" */
  effect_type: string;
  target_system: SourceSystem;
  /** e.g. "ticket/12345", "refund/re_abc" */
  target_resource_id: string;
  /**
   * Deterministic dedupe key: action_execution_id + effect_type + target_resource_id
   * For POST_COMMENT: additionally hash comment content.
   */
  effect_key: string;
  attempt_number: number;
  outcome_status: EffectOutcomeStatus;
  /** Provider-returned ID on success (e.g. Zendesk comment ID). Null until confirmed. */
  provider_correlation_id: string | null;
  intended_at: string; // ISO 8601
  sent_at: string | null; // ISO 8601
  confirmed_at: string | null; // ISO 8601
}

// ─── Actor Types ──────────────────────────────────────────────────────────────

export enum ActorType {
  AGENT = "agent",
  SYSTEM = "system",
  WEBHOOK = "webhook",
  OPERATOR = "operator",
}

// ─── Audit Event Types ────────────────────────────────────────────────────────

/**
 * Canonical audit_log.event_type values. Use these rather than string literals
 * so event names stay greppable and consistent across services.
 */
export const AuditEventType = {
  // Policy
  POLICY_DECISION: "policy_decision",

  // Card (bypass-detection proxy signal)
  CARD_LOADED: "card_loaded",
  CARD_CTA_CLICKED: "card_cta_clicked",

  // Approval lifecycle
  ACTION_REQUIRES_APPROVAL: "action_requires_approval",
  APPROVAL_GRANTED: "approval_granted",
  APPROVAL_DENIED: "approval_denied",
  APPROVAL_EXPIRED: "approval_expired",
  APPROVAL_CANCELLED: "approval_cancelled",

  // Action execution lifecycle
  ACTION_EXECUTION_CREATED: "action_execution_created",
  ACTION_EXECUTION_COMPLETED: "action_execution_completed",
  ACTION_EXECUTION_RETRY: "action_execution_retry",
  ACTION_EXECUTION_FAILED_TERMINAL: "action_execution_failed_terminal",
  ACTION_EXECUTION_BLOCKED_OPERATOR: "action_execution_blocked_operator",
  ACTION_EXECUTION_RECONCILED: "action_execution_reconciled",

  // Evidence
  EVIDENCE_FETCHED: "evidence_fetched",
  EVIDENCE_MATCH_COMPUTED: "evidence_match_computed",
  EVIDENCE_FETCH_FAILED: "evidence_fetch_failed",
  EVIDENCE_OUTDATED: "evidence_outdated",

  // Tombstone / source
  TICKET_MERGED: "ticket_merged",
  TICKET_SOURCE_DELETED: "ticket_source_deleted",
  SOURCE_UNAVAILABLE: "source_unavailable",
  ORDER_ARCHIVED: "order_archived",

  // Card state
  CARD_STATE_REBUILT: "card_state_rebuilt",

  // Operator repair
  OPERATOR_REBUILD_CARD_STATE: "operator_rebuild_card_state",
  OPERATOR_REPLAY_EVENT: "operator_replay_event",
  OPERATOR_RECONCILE_EXECUTION: "operator_reconcile_execution",
  OPERATOR_FORCE_SYNC_ZENDESK: "operator_force_sync_zendesk",

  // Inbound events
  INBOUND_EVENT_RECEIVED: "inbound_event_received",
  INBOUND_EVENT_PROCESSED: "inbound_event_processed",
  INBOUND_EVENT_FAILED: "inbound_event_failed",
  INBOUND_EVENT_REPLAYED: "inbound_event_replayed",

  // Authentication
  AUTH_REJECTED: "auth_rejected",
} as const;

export type AuditEventType =
  (typeof AuditEventType)[keyof typeof AuditEventType];

// ─── Provider Call Outcomes ───────────────────────────────────────────────────

/**
 * Connector adapters throw these so the worker can distinguish outcomes that
 * need different handling. A plain Error is treated as retriable.
 *
 * TimeoutError specifically means "the request was sent but no response was
 * received" — the effect may or may not have occurred. That is what drives
 * SENT_UNCERTAIN, and for money movement it means never auto-retrying.
 */
export class TimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TimeoutError";
  }
}

/** A provider rejection that will never succeed on retry (4xx, validation). */
export class PermanentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PermanentError";
  }
}

/**
 * Classify by name rather than `instanceof`.
 *
 * These errors cross package boundaries, and a module can legitimately be
 * instantiated more than once — duplicate installs, a bundler and the CJS
 * require graph, a test runner's transform pipeline. When that happens
 * `instanceof` fails against a structurally identical class, and the failure
 * mode here is severe: an uncertain refund misread as a plain error is exactly
 * the path that causes a double refund.
 */
export function isTimeoutError(err: unknown): boolean {
  return (err as { name?: string } | null)?.name === "TimeoutError";
}

export function isPermanentError(err: unknown): boolean {
  return (err as { name?: string } | null)?.name === "PermanentError";
}

// ─── Risk Tiers ───────────────────────────────────────────────────────────────

export enum ActionRiskTier {
  HIGH = "HIGH",
  MEDIUM = "MEDIUM",
  LOW = "LOW",
}

export enum AbuseSeverity {
  HIGH = "HIGH",
  MEDIUM = "MEDIUM",
  NONE = "NONE",
}

export enum DegradedState {
  /** All sources available and fresh */
  NOMINAL = "NOMINAL",
  /** One or more sources stale but below threshold */
  DEGRADED_STALE = "DEGRADED_STALE",
  /** One or more sources unreachable */
  DEGRADED_UNAVAILABLE = "DEGRADED_UNAVAILABLE",
  /** Source record deleted/archived/tombstoned */
  SOURCE_TOMBSTONED = "SOURCE_TOMBSTONED",
}

// ─── Tenant Config Shape ─────────────────────────────────────────────────────

export interface TenantConfig {
  evidenceFreshnessSeconds: number;    // default: 300
  amountMatchTolerancePct: number;     // default: 2 (2%)
  reopenGateCount: number;             // default: 3
  managerApprovalThresholdCents: number; // default: 5000 (50.00)
  managerApprovalGroupId: string | null;
  /**
   * If false (default for pilot): policy engine NEVER returns REQUIRES_APPROVAL.
   * Approval architecture exists but is toggled off.
   */
  approvalsEnabled: boolean;           // default: false
  macroPrefixResolved: string;         // default: ""
  macroPrefixPending: string;          // default: ""
}
