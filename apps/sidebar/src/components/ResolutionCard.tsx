/**
 * @file apps/sidebar/src/components/ResolutionCard.tsx
 * @description Resolution Card — primary agent-facing UI component.
 *
 * UX constraints (spec §9):
 * - Primary state readable without scrolling on standard desktop viewport
 * - Zero extra interactions before primary CTA in high-confidence cases
 * - Progressive disclosure (details hidden by default)
 * - No forced expansion on happy path
 * - No accusation language anywhere
 *
 * Phase 1: polling-based refresh (no SSE/WebSockets required per spec §9)
 */

import React, { useState, useEffect, useCallback } from "react";
import EvidencePanel from "./EvidencePanel";
import ActionPanel from "./ActionPanel";
import StatusBadge from "./StatusBadge";
import DegradedBanner from "./DegradedBanner";
import AnnotatedThread from "./AnnotatedThread";
import HistoryPanel, { HistoryNotices } from "./HistoryPanel";
import { useCardData } from "../hooks/useCardData";

interface ResolutionCardProps {
  zendeskTicketId: string;
  agentId: string;
  /** Called when content height may have changed, so the host can resize. */
  onLayoutChange?: () => void;
}

export default function ResolutionCard({
  zendeskTicketId,
  agentId,
  onLayoutChange,
}: ResolutionCardProps) {
  const { card, loading, error, refetch } = useCardData(zendeskTicketId);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [lastActionResult, setLastActionResult] = useState<string | null>(null);

  // Anything that changes the rendered height should let the host resize.
  useEffect(() => {
    onLayoutChange?.();
  }, [card, loading, error, detailsOpen, lastActionResult, onLayoutChange]);

  // Poll for status updates (spec §9: polling acceptable for Phase 1)
  useEffect(() => {
    const interval = setInterval(refetch, 3000);
    return () => clearInterval(interval);
  }, [refetch]);

  const handleActionComplete = useCallback((message: string) => {
    setLastActionResult(message);
    setTimeout(() => refetch(), 500); // Refresh after short delay
  }, [refetch]);

  if (loading && !card) {
    return (
      <div style={styles.container}>
        <div style={styles.loadingState}>
          <Spinner />
          <span style={{ marginLeft: 8, color: "#68737d", fontSize: 13 }}>Loading...</span>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div style={styles.container}>
        <div style={styles.errorState}>
          <div style={styles.errorTitle}>Unable to load card</div>
          <div style={styles.errorMsg}>{error}</div>
          <button onClick={refetch} style={styles.retryButton}>Retry</button>
        </div>
      </div>
    );
  }

  if (!card) return null;

  // Identifiers the history layer flagged, so the matching span inside the
  // message can carry the warning too. Seeing "already refunded" on the very
  // order number the customer typed is a different thing from reading it in a
  // banner further down.
  const flaggedReferences = card.customerHistory.priorInteractions
    .filter((i) => i.sameSubject && i.refundStatus === "succeeded")
    .flatMap((i) => (i.orderReference ? [i.orderReference] : []));

  return (
    <div style={styles.container}>

      {/* ─── Degraded / Source Unavailable Banner ──────────────────────────── */}
      {(card.isSourceUnavailable || card.freshnessStatus === "STALE") && (
        <DegradedBanner
          isSourceUnavailable={card.isSourceUnavailable}
          sourceUnavailableReason={card.sourceUnavailableReason}
          freshnessStatus={card.freshnessStatus}
          evidenceFetchedAt={card.evidenceFetchedAt}
        />
      )}

      {/* ─── Soft Warnings ─────────────────────────────────────────────────── */}
      {card.softWarnings && card.softWarnings.length > 0 && (
        <div style={styles.warningsPanel}>
          {card.softWarnings.map((w, i) => (
            <div key={i} style={styles.warningItem}>
              <span style={styles.warningIcon}>ℹ</span>
              <span style={styles.warningText}>{w}</span>
            </div>
          ))}
        </div>
      )}

      {/*
        The conversation leads.

        The agent is here to read a customer's message; the system's job is to
        annotate it, not to replace it with a summary of a transaction. Putting
        the ledger first made the panel answer a question — "what is the state
        of this refund?" — that the agent had not asked yet.
      */}
      {card.context && (
        <AnnotatedThread
          thread={card.context.thread}
          flaggedReferences={flaggedReferences}
        />
      )}

      {/*
        History warnings sit directly above the buttons. Below them they would
        be read after the click, which is the same as not showing them.
      */}
      <HistoryNotices history={card.customerHistory} />

      {/* ─── Action Panel (primary CTA) ─────────────────────────────────────── */}
      <ActionPanel
        card={card}
        agentId={agentId}
        onActionComplete={handleActionComplete}
        onRefetch={refetch}
      />

      {/* ─── Action result notification ─────────────────────────────────────── */}
      {lastActionResult && (
        <div style={styles.actionResultNotice}>
          {lastActionResult}
        </div>
      )}

      {/* ─── Previous interactions (collapsed) ──────────────────────────────── */}
      <HistoryPanel history={card.customerHistory} />

      {/* ─── Transaction and evidence (collapsed) ───────────────────────────── */}
      <button
        style={styles.detailsToggle}
        onClick={() => setDetailsOpen(!detailsOpen)}
      >
        {detailsOpen ? "▲" : "▼"} Transaction &amp; evidence
        {card.matchBand && (
          <span style={styles.detailsBadge}>
            <StatusBadge matchBand={card.matchBand} confidence={card.confidenceScore} />
          </span>
        )}
      </button>

      {detailsOpen && (
        <>
          <div style={styles.statusRow}>
            <div style={styles.issueStateLabel}>
              {formatIssueState(card.issueState)}
            </div>
            <div style={styles.correlationId}>
              ID: {card.correlationId?.slice(0, 8)}
            </div>
          </div>

          {card.evidenceSummary && (
            <>
              <EvidenceSummaryQuick
                summary={card.evidenceSummary}
                freshnessStatus={card.freshnessStatus}
              />
              <EvidencePanel
                evidenceSummary={card.evidenceSummary}
                matchBand={card.matchBand}
                confidenceScore={card.confidenceScore}
                isSourceUnavailable={card.isSourceUnavailable}
              />
            </>
          )}
        </>
      )}

      {/* ─── Pending States ─────────────────────────────────────────────────── */}
      {card.pendingApprovalRequestId && (
        <div style={styles.pendingPanel}>
          <div style={styles.pendingIcon}>⏳</div>
          <div>
            <div style={styles.pendingTitle}>Awaiting manager approval</div>
            <div style={styles.pendingMeta}>
              Ref: {card.pendingApprovalRequestId.slice(0, 8)}
            </div>
          </div>
        </div>
      )}

      {card.pendingActionExecutionId && !card.pendingApprovalRequestId && (
        <ExecutionStatusPanel
          executionId={card.pendingActionExecutionId}
          actionType={card.lastActionType}
          issueState={card.issueState}
        />
      )}

      {/* ─── Footer ──────────────────────────────────────────────────────────── */}
      <div style={styles.footer}>
        <span>Last updated: {card.lastRebuiltAt ? new Date(card.lastRebuiltAt).toLocaleTimeString() : "—"}</span>
        <button style={styles.refreshLink} onClick={refetch}>Refresh</button>
      </div>

    </div>
  );
}

// ─── Evidence Summary Quick View ─────────────────────────────────────────────

interface EvidenceSummaryQuickProps {
  summary: Record<string, unknown>;
  freshnessStatus: string;
}

function EvidenceSummaryQuick({ summary, freshnessStatus }: EvidenceSummaryQuickProps) {
  const refundAmount = summary.refundAmount as number | undefined;
  const currency = summary.currency as string | undefined;
  const stripeRefundStatus = summary.stripeRefundStatus as string | undefined;
  const shopifyOrderName = summary.shopifyOrderName as string | undefined;
  const shopifyFinancialStatus = summary.shopifyFinancialStatus as string | undefined;

  return (
    <div style={styles.evidenceQuick}>
      {refundAmount !== undefined && (
        <EvidenceRow
          label="Refund amount"
          value={`${formatCurrency(refundAmount, currency ?? "usd")}`}
        />
      )}
      {stripeRefundStatus && (
        <EvidenceRow
          label="Stripe status"
          value={stripeRefundStatus}
          valueStyle={{ color: stripeRefundStatus === "succeeded" ? "#038153" : "#ad2800" }}
        />
      )}
      {shopifyOrderName && (
        <EvidenceRow label="Shopify order" value={shopifyOrderName} />
      )}
      {shopifyFinancialStatus && (
        <EvidenceRow label="Order status" value={shopifyFinancialStatus} />
      )}
      <EvidenceRow
        label="Evidence"
        value={freshnessStatus === "FRESH" ? "Fresh" : freshnessStatus === "STALE" ? "Stale" : "Missing"}
        valueStyle={{ color: freshnessStatus === "FRESH" ? "#038153" : "#ad2800" }}
      />
    </div>
  );
}

function EvidenceRow({
  label, value, valueStyle
}: {
  label: string;
  value: string;
  valueStyle?: React.CSSProperties;
}) {
  return (
    <div style={styles.evidenceRow}>
      <span style={styles.evidenceLabel}>{label}</span>
      <span style={{ ...styles.evidenceValue, ...valueStyle }}>{value}</span>
    </div>
  );
}

// ─── Execution Status Panel ───────────────────────────────────────────────────

function ExecutionStatusPanel({
  executionId,
  actionType,
  issueState,
}: {
  executionId: string;
  actionType: string | null;
  issueState: string;
}) {
  const stateLabel = issueState === "ACTION_IN_PROGRESS"
    ? "Action in progress — check back shortly"
    : "Processing";

  return (
    <div style={styles.executionPanel}>
      <Spinner size={14} color="#1f73b7" />
      <div style={{ marginLeft: 10 }}>
        <div style={styles.executionTitle}>{stateLabel}</div>
        {actionType && (
          <div style={styles.executionMeta}>
            {formatActionType(actionType)} · Ref: {executionId.slice(0, 8)}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function formatIssueState(state: string): string {
  const labels: Record<string, string> = {
    OPEN: "Open",
    PENDING_EVIDENCE: "Pending Evidence",
    PENDING_APPROVAL: "Pending Approval",
    ACTION_IN_PROGRESS: "Action In Progress",
    RESOLVED: "Resolved",
    ESCALATED: "Escalated",
    NEEDS_REVIEW: "Needs Review",
  };
  return labels[state] ?? state;
}

function formatActionType(type: string): string {
  return type.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function formatCurrency(amountCents: number, currency: string): string {
  const amount = amountCents / 100;
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: currency.toUpperCase(),
  }).format(amount);
}

function Spinner({ size = 16, color = "#68737d" }: { size?: number; color?: string }) {
  return (
    <div
      style={{
        width: size,
        height: size,
        border: `2px solid ${color}20`,
        borderTop: `2px solid ${color}`,
        borderRadius: "50%",
        animation: "spin 0.8s linear infinite",
        display: "inline-block",
      }}
    />
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const styles: Record<string, React.CSSProperties> = {
  container: {
    background: "white",
    minHeight: "calc(100vh - 45px)",
    display: "flex",
    flexDirection: "column",
  },
  loadingState: {
    padding: 24,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    color: "#68737d",
    fontSize: 13,
  },
  errorState: {
    padding: 20,
    textAlign: "center",
  },
  errorTitle: {
    fontSize: 14,
    fontWeight: 600,
    color: "#2f3941",
    marginBottom: 8,
  },
  errorMsg: {
    fontSize: 12,
    color: "#68737d",
    marginBottom: 16,
  },
  retryButton: {
    background: "#1f73b7",
    color: "white",
    border: "none",
    borderRadius: 4,
    padding: "6px 16px",
    cursor: "pointer",
    fontSize: 13,
  },
  warningsPanel: {
    background: "#fff8e1",
    borderBottom: "1px solid #f0c040",
    padding: "8px 16px",
  },
  warningItem: {
    display: "flex",
    alignItems: "flex-start",
    gap: 6,
    marginBottom: 4,
    fontSize: 12,
    color: "#5f4b00",
  },
  warningIcon: { fontSize: 13, flexShrink: 0, marginTop: 1 },
  warningText: { lineHeight: 1.4 },
  statusRow: {
    padding: "10px 16px",
    display: "flex",
    justifyContent: "space-between",
    alignItems: "baseline",
  },
  issueStateLabel: {
    fontSize: 14,
    fontWeight: 600,
    color: "#2f3941",
    marginBottom: 4,
  },
  correlationId: {
    fontSize: 10,
    color: "#c2c8cc",
    fontFamily: "monospace",
    marginTop: 4,
  },
  evidenceQuick: {
    padding: "10px 16px",
    borderBottom: "1px solid #f0f0f0",
    background: "#f8f9fa",
  },
  evidenceRow: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 4,
  },
  evidenceLabel: {
    fontSize: 12,
    color: "#68737d",
  },
  evidenceValue: {
    fontSize: 12,
    fontWeight: 500,
    color: "#2f3941",
  },
  detailsToggle: {
    width: "100%",
    padding: "8px 16px",
    background: "none",
    border: "none",
    borderBottom: "1px solid #f0f0f0",
    color: "#1f73b7",
    fontSize: 12,
    cursor: "pointer",
    textAlign: "left",
    display: "flex",
    alignItems: "center",
    gap: 8,
  },
  detailsBadge: { marginLeft: "auto" },
  pendingPanel: {
    margin: "12px 16px",
    padding: "12px",
    background: "#f5f7ff",
    borderRadius: 6,
    border: "1px solid #c5d0e6",
    display: "flex",
    alignItems: "center",
    gap: 12,
  },
  pendingIcon: { fontSize: 20 },
  pendingTitle: { fontSize: 13, fontWeight: 500, color: "#2f3941" },
  pendingMeta: { fontSize: 11, color: "#68737d", fontFamily: "monospace", marginTop: 2 },
  executionPanel: {
    margin: "12px 16px",
    padding: "12px",
    background: "#f0f7ff",
    borderRadius: 6,
    border: "1px solid #b8d4f0",
    display: "flex",
    alignItems: "center",
  },
  executionTitle: { fontSize: 13, fontWeight: 500, color: "#2f3941" },
  executionMeta: { fontSize: 11, color: "#68737d", marginTop: 2 },
  actionResultNotice: {
    margin: "8px 16px",
    padding: "10px 12px",
    background: "#edf7ed",
    borderRadius: 6,
    border: "1px solid #a3d9a5",
    fontSize: 12,
    color: "#1a6e27",
  },
  footer: {
    marginTop: "auto",
    padding: "10px 16px",
    borderTop: "1px solid #f0f0f0",
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    fontSize: 11,
    color: "#68737d",
  },
  refreshLink: {
    background: "none",
    border: "none",
    color: "#1f73b7",
    cursor: "pointer",
    fontSize: 11,
    padding: 0,
  },
};
