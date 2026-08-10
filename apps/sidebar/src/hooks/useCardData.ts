/**
 * @file apps/sidebar/src/hooks/useCardData.ts
 * @description Data fetching hook for Resolution Card.
 * Polling-based (no SSE/WebSockets — spec §9 Phase 1).
 */

import { useState, useEffect, useCallback } from "react";
import { apiRequest } from "../zaf";
import type { ThreadMessage } from "../components/AnnotatedThread";

export type { ThreadMessage };

interface CardData {
  issueId: string;
  zendeskTicketId: string;
  issueState: string;
  matchBand: string | null;
  confidenceScore: number | null;
  freshnessStatus: "FRESH" | "STALE" | "MISSING";
  evidenceFetchedAt: string | null;
  isSourceUnavailable: boolean;
  sourceUnavailableReason: string | null;
  evidenceSummary: Record<string, unknown> | null;
  pendingApprovalRequestId: string | null;
  pendingActionExecutionId: string | null;
  lastActionType: string | null;
  lastActionCompletedAt: string | null;
  availableCtas: AvailableCta[];
  softWarnings: string[];
  correlationId: string;
  lastRebuiltAt: string;
  /** The annotated thread. Null before ingestion. */
  context: TicketContext | null;
  customerHistory: CustomerHistory;
}

export interface TicketContext {
  primaryAsk: string | null;
  paymentReference: string | null;
  orderReference: string | null;
  claimedAmountCents: number | null;
  claimedCurrency: string | null;
  messageCount: number;
  /** The conversation, each message carrying the spans found inside it. */
  thread: ThreadMessage[];
}

export interface HistoryNotice {
  severity: "critical" | "warning" | "info";
  code: string;
  message: string;
}

export interface PriorInteraction {
  zendeskTicketId: string | null;
  openedAt: string;
  state: string;
  primaryAsk: string | null;
  orderReference: string | null;
  matchBand: string | null;
  refundedAmountCents: number | null;
  refundCurrency: string | null;
  refundStatus: string | null;
  sameSubject: boolean;
  actionsTaken: string[];
}

export interface CustomerHistory {
  priorIssueCount: number;
  truncated: boolean;
  notices: HistoryNotice[];
  priorInteractions: PriorInteraction[];
}

/** An older API, or a card fetched before ingestion, simply has no history. */
const EMPTY_HISTORY: CustomerHistory = {
  priorIssueCount: 0,
  truncated: false,
  notices: [],
  priorInteractions: [],
};

interface AvailableCta {
  actionType: string;
  label: string;
  requiresApproval: boolean;
  disabled: boolean;
  disabledReason: string | null;
}

interface ApiCardResponse {
  issueId?: string;
  issue_id?: string;
  zendeskTicketId?: string;
  zendesk_ticket_id?: string;
  issueState?: string;
  issue_state?: string;
  matchBand?: string | null;
  confidenceScore?: number | string | null;
  correlationId?: string;
  correlation_id?: string;
  lastRebuiltAt?: string;
  last_rebuilt_at?: string;
  evidenceFetchedAt?: string | null;
  evidence_fetched_at?: string | null;
  isSourceUnavailable?: boolean;
  sourceUnavailableReason?: string | null;
  evidenceSummary?: Record<string, unknown> | null;
  evidence_summary?: Record<string, unknown> | null;
  pendingActionExecutionId?: string | null;
  pending_action_execution_id?: string | null;
  pendingApprovalRequestId?: string | null;
  pending_approval_request_id?: string | null;
  lastActionType?: string | null;
  last_action_type?: string | null;
  lastActionCompletedAt?: string | null;
  last_action_completed_at?: string | null;
  availableCtas?: AvailableCta[];
  softWarnings?: string[];
  evidence?: {
    refund_status?: string | null;
    refund_amount_cents?: number | null;
    refund_currency?: string | null;
    refund_id?: string | null;
    match_band?: string | null;
    confidence_score?: number | string | null;
  };
  freshness?: {
    is_fresh?: boolean;
    age_seconds?: number | null;
    is_usable_despite_stale?: boolean;
    is_source_unavailable?: boolean;
  };
  pending_action?: {
    action_type?: string | null;
    status?: string | null;
    execution_id?: string | null;
    approval_id?: string | null;
  } | null;
  context?: {
    primary_ask?: string | null;
    payment_reference?: string | null;
    order_reference?: string | null;
    claimed_amount_cents?: number | null;
    claimed_currency?: string | null;
    message_count?: number | null;
    thread?: Array<{
      source_id?: string;
      kind?: string;
      author_role?: string;
      body?: string | null;
      redacted?: boolean;
      redaction_reason?: string | null;
      created_at?: string;
      annotations?: Array<{
        kind?: string;
        display?: string;
        confidence?: number;
        author_role?: string;
        start?: number;
        end?: number;
        excerpt?: string;
        rule?: string;
        reference?: string | null;
        resolved?: {
          provider: string;
          recordType: string;
          reference: string;
          status: string | null;
          amountCents: number | null;
          currency: string | null;
        } | null;
      }>;
    }>;
  } | null;
  customer_history?: {
    prior_issue_count?: number;
    truncated?: boolean;
    notices?: Array<{ severity?: string; code?: string; message?: string }>;
    prior_interactions?: Array<{
      zendesk_ticket_id?: string | null;
      opened_at?: string;
      state?: string;
      primary_ask?: string | null;
      order_reference?: string | null;
      match_band?: string | null;
      refunded_amount_cents?: number | null;
      refund_currency?: string | null;
      refund_status?: string | null;
      same_subject?: boolean;
      actions_taken?: string[];
    }>;
  } | null;
}

const DEFAULT_UNAVAILABLE_REASON = "Source record is unavailable. Use the last known state and escalate if needed.";

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

function asNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function deriveFreshnessStatus(api: ApiCardResponse): "FRESH" | "STALE" | "MISSING" {
  const isFresh = api.freshness?.is_fresh;
  const ageSeconds = api.freshness?.age_seconds;

  if (isFresh === true) return "FRESH";
  if (isFresh === false) {
    if (ageSeconds === null || ageSeconds === undefined) return "MISSING";
    return "STALE";
  }
  return "MISSING";
}

function buildDefaultCtas(
  issueState: string,
  pendingActionExecutionId: string | null,
  pendingApprovalRequestId: string | null
): AvailableCta[] {
  if (pendingActionExecutionId || pendingApprovalRequestId) return [];

  if (issueState === "RESOLVED") {
    return [
      {
        actionType: "reopen_issue",
        label: "Reopen issue",
        requiresApproval: false,
        disabled: false,
        disabledReason: null,
      },
      {
        actionType: "refresh_evidence",
        label: "Refresh evidence",
        requiresApproval: false,
        disabled: false,
        disabledReason: null,
      },
    ];
  }

  if (issueState === "ACTION_IN_PROGRESS" || issueState === "PENDING_APPROVAL") {
    return [
      {
        actionType: "refresh_evidence",
        label: "Refresh evidence",
        requiresApproval: false,
        disabled: false,
        disabledReason: null,
      },
    ];
  }

  return [
    {
      actionType: "close_confirmed",
      label: "Mark as resolved",
      requiresApproval: false,
      disabled: false,
      disabledReason: null,
    },
    {
      actionType: "escalate_missing",
      label: "Escalate for review",
      requiresApproval: false,
      disabled: false,
      disabledReason: null,
    },
    {
      actionType: "refresh_evidence",
      label: "Refresh evidence",
      requiresApproval: false,
      disabled: false,
      disabledReason: null,
    },
  ];
}

function buildSoftWarnings(
  freshnessStatus: "FRESH" | "STALE" | "MISSING",
  isSourceUnavailable: boolean,
  sourceUnavailableReason: string | null,
  matchBand: string | null
): string[] {
  const warnings: string[] = [];

  if (isSourceUnavailable) {
    warnings.push(sourceUnavailableReason ?? DEFAULT_UNAVAILABLE_REASON);
  }

  if (freshnessStatus === "STALE") {
    warnings.push("Evidence is aging. Consider refreshing before finalizing this case.");
  } else if (freshnessStatus === "MISSING") {
    warnings.push("Evidence is missing. Refresh evidence before taking irreversible actions.");
  }

  if (matchBand === "LOW" || matchBand === "NO_MATCH" || matchBand === "NONE") {
    warnings.push("Match confidence is low. Review details before proceeding.");
  }

  return warnings;
}

function buildEvidenceSummary(
  apiSummary: Record<string, unknown> | null,
  api: ApiCardResponse,
  isSourceUnavailable: boolean,
  sourceUnavailableReason: string | null
): Record<string, unknown> | null {
  if (apiSummary) return apiSummary;

  const evidence = api.evidence ?? {};
  const summary: Record<string, unknown> = {};

  if (evidence.refund_status) summary.stripeRefundStatus = evidence.refund_status;
  if (evidence.refund_amount_cents !== null && evidence.refund_amount_cents !== undefined) {
    summary.stripeChargeAmount = evidence.refund_amount_cents;
    summary.refundAmount = evidence.refund_amount_cents;
  }
  if (evidence.refund_currency) summary.currency = evidence.refund_currency;
  if (evidence.refund_id) summary.stripeRefundId = evidence.refund_id;
  if (isSourceUnavailable) summary.sourceUnavailable = true;
  if (sourceUnavailableReason) summary.sourceUnavailableReason = sourceUnavailableReason;

  return Object.keys(summary).length > 0 ? summary : null;
}

function normalizeContext(api: ApiCardResponse): TicketContext | null {
  const raw = api.context;
  if (!raw) return null;

  return {
    primaryAsk: asString(raw.primary_ask),
    paymentReference: asString(raw.payment_reference),
    orderReference: asString(raw.order_reference),
    claimedAmountCents: asNumber(raw.claimed_amount_cents),
    claimedCurrency: asString(raw.claimed_currency),
    messageCount: asNumber(raw.message_count) ?? 0,
    // A message with no body cannot be annotated; a span without usable
    // offsets cannot be placed. Both are dropped rather than guessed at.
    thread: (raw.thread ?? []).flatMap((message) => {
      const sourceId = asString(message.source_id);
      if (!sourceId) return [];

      const redacted = message.redacted === true;
      const body = typeof message.body === "string" ? message.body : null;
      if (!redacted && body === null) return [];

      return [
        {
          sourceId,
          kind: message.kind ?? "comment",
          authorRole: message.author_role ?? "customer",
          body,
          redacted,
          redactionReason: asString(message.redaction_reason),
          createdAt: message.created_at ?? "",
          annotations: redacted
            ? []
            : (message.annotations ?? []).flatMap((a) => {
                const start = asNumber(a.start);
                const end = asNumber(a.end);
                const display = asString(a.display);
                const excerpt = typeof a.excerpt === "string" ? a.excerpt : null;

                if (start === null || end === null || !display || excerpt === null) {
                  return [];
                }
                // Trust nothing about placement that the text does not confirm.
                if (body === null || body.slice(start, end) !== excerpt) return [];

                return [
                  {
                    start,
                    end,
                    kind: a.kind ?? "unknown",
                    display,
                    confidence: asNumber(a.confidence) ?? 0,
                    authorRole: a.author_role ?? "customer",
                    excerpt,
                    rule: a.rule ?? "",
                    reference: a.reference ?? null,
                    resolved: a.resolved ?? null,
                  },
                ];
              }),
        },
      ];
    }),
  };
}

const NOTICE_SEVERITIES = new Set(["critical", "warning", "info"]);

function normalizeHistory(api: ApiCardResponse): CustomerHistory {
  const raw = api.customer_history;
  if (!raw) return EMPTY_HISTORY;

  return {
    priorIssueCount: asNumber(raw.prior_issue_count) ?? 0,
    truncated: raw.truncated === true,
    notices: (raw.notices ?? []).flatMap((n) => {
      const message = asString(n.message);
      if (!message) return [];
      // An unrecognized severity renders as info rather than as an alarm: a new
      // server-side level must not silently look like a critical one.
      const severity = NOTICE_SEVERITIES.has(n.severity ?? "")
        ? (n.severity as HistoryNotice["severity"])
        : "info";
      return [{ severity, code: n.code ?? "unknown", message }];
    }),
    priorInteractions: (raw.prior_interactions ?? []).map((i) => ({
      zendeskTicketId: asString(i.zendesk_ticket_id),
      openedAt: i.opened_at ?? "",
      state: i.state ?? "OPEN",
      primaryAsk: asString(i.primary_ask),
      orderReference: asString(i.order_reference),
      matchBand: asString(i.match_band),
      refundedAmountCents: asNumber(i.refunded_amount_cents),
      refundCurrency: asString(i.refund_currency),
      refundStatus: asString(i.refund_status),
      sameSubject: i.same_subject === true,
      actionsTaken: Array.isArray(i.actions_taken) ? i.actions_taken : [],
    })),
  };
}

function normalizeCardResponse(api: ApiCardResponse): CardData {
  const issueId = asString(api.issueId ?? api.issue_id);
  const zendeskTicketId = asString(api.zendeskTicketId ?? api.zendesk_ticket_id);
  const issueState = asString(api.issueState ?? api.issue_state) ?? "OPEN";

  if (!issueId || !zendeskTicketId) {
    throw new Error("API payload missing issue identifiers");
  }

  const matchBand =
    asString(api.matchBand) ??
    asString(api.evidence?.match_band) ??
    null;

  const confidenceScore =
    asNumber(api.confidenceScore) ??
    asNumber(api.evidence?.confidence_score);

  const freshnessStatus = deriveFreshnessStatus(api);
  const isSourceUnavailable =
    api.isSourceUnavailable ??
    api.freshness?.is_source_unavailable ??
    false;
  const sourceUnavailableReason =
    asString(api.sourceUnavailableReason) ??
    asString(asRecord(api.evidenceSummary ?? api.evidence_summary)?.sourceUnavailableReason) ??
    (isSourceUnavailable ? DEFAULT_UNAVAILABLE_REASON : null);

  const pendingActionExecutionId =
    asString(api.pendingActionExecutionId ?? api.pending_action_execution_id) ??
    asString(api.pending_action?.execution_id) ??
    null;
  const pendingApprovalRequestId =
    asString(api.pendingApprovalRequestId ?? api.pending_approval_request_id) ??
    asString(api.pending_action?.approval_id) ??
    null;
  const lastActionType =
    asString(api.lastActionType ?? api.last_action_type) ??
    asString(api.pending_action?.action_type) ??
    null;
  const lastActionCompletedAt =
    asString(api.lastActionCompletedAt ?? api.last_action_completed_at) ??
    null;
  const evidenceFetchedAt =
    asString(api.evidenceFetchedAt ?? api.evidence_fetched_at) ??
    null;

  const evidenceSummary = buildEvidenceSummary(
    asRecord(api.evidenceSummary ?? api.evidence_summary),
    api,
    isSourceUnavailable,
    sourceUnavailableReason
  );

  const availableCtas = Array.isArray(api.availableCtas)
    ? api.availableCtas
    : buildDefaultCtas(issueState, pendingActionExecutionId, pendingApprovalRequestId);

  const softWarnings = Array.isArray(api.softWarnings)
    ? api.softWarnings
    : buildSoftWarnings(freshnessStatus, isSourceUnavailable, sourceUnavailableReason, matchBand);

  return {
    issueId,
    zendeskTicketId,
    issueState,
    matchBand,
    confidenceScore,
    freshnessStatus,
    evidenceFetchedAt,
    isSourceUnavailable,
    sourceUnavailableReason,
    evidenceSummary,
    pendingApprovalRequestId,
    pendingActionExecutionId,
    lastActionType,
    lastActionCompletedAt,
    availableCtas,
    softWarnings,
    correlationId: asString(api.correlationId ?? api.correlation_id) ?? "",
    lastRebuiltAt: asString(api.lastRebuiltAt ?? api.last_rebuilt_at) ?? "",
    context: normalizeContext(api),
    customerHistory: normalizeHistory(api),
  };
}

export function useCardData(zendeskTicketId: string) {
  const [card, setCard] = useState<CardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refetch = useCallback(async () => {
    const response = await apiRequest<ApiCardResponse>(
      `/api/v1/card/${zendeskTicketId}`
    );

    if (!response.ok || !response.body) {
      setError(
        response.status === 404
          ? "No resolution record exists for this ticket yet."
          : response.error ?? "Could not load the resolution card."
      );
      setLoading(false);
      return;
    }

    setCard(normalizeCardResponse(response.body));
    setError(null);
    setLoading(false);
  }, [zendeskTicketId]);

  // Fetch on mount and when ticket changes
  useEffect(() => {
    setLoading(true);
    setCard(null);
    setError(null);
    refetch();
  }, [zendeskTicketId, refetch]);

  return { card, loading, error, refetch };
}
