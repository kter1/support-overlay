/**
 * @file apps/sidebar/src/components/ActionPanel.tsx
 * @description Action panel — renders available CTAs and handles action submission.
 *
 * Spec §9 UX constraints:
 * - Zero extra interactions on high-confidence path
 * - CTAs labeled without accusation language
 * - Approval state clearly indicated when approvals_enabled = true
 */

import React, { useState } from "react";

interface CardData {
  issueId: string;
  issueState: string;
  availableCtas: AvailableCta[];
  pendingActionExecutionId: string | null;
  pendingApprovalRequestId: string | null;
  softWarnings: string[];
}

interface AvailableCta {
  actionType: string;
  label: string;
  requiresApproval: boolean;
  disabled: boolean;
  disabledReason: string | null;
}

interface ActionPanelProps {
  card: CardData;
  agentId: string;
  onActionComplete: (message: string) => void;
  onRefetch: () => void;
}

import { apiRequest } from "../zaf";

export default function ActionPanel({ card, agentId, onActionComplete, onRefetch }: ActionPanelProps) {
  const [submitting, setSubmitting] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  // No CTAs to show if action is in progress
  if (card.pendingActionExecutionId && !card.pendingApprovalRequestId) {
    return null;
  }

  if (card.availableCtas.length === 0) {
    return (
      <div style={styles.noActions}>
        <span style={{ color: "#68737d", fontSize: 12 }}>No actions available</span>
      </div>
    );
  }

  async function handleAction(cta: AvailableCta) {
    if (cta.disabled || submitting) return;
    setSubmitting(cta.actionType);
    setActionError(null);

    const idempotencyKey = `${card.issueId}-${cta.actionType}-${Date.now()}`;

    try {
      const response = await apiRequest<{
        outcome?: string;
        action_execution_id?: string;
        approval_request_id?: string;
        deny_reason?: string;
        idempotent_replay?: boolean;
        error?: string;
      }>("/api/v1/actions", {
        method: "POST",
        body: {
          action_type: cta.actionType,
          issue_id: card.issueId,
          idempotency_key: idempotencyKey,
          action_params: {},
        },
      });

      const result = response.body ?? {};

      if (!response.ok) {
        setActionError(result.deny_reason ?? response.error ?? "Action failed.");
        return;
      }

      if (result.outcome === "DENY") {
        setActionError(result.deny_reason ?? "Action not available");
      } else if (result.outcome === "REQUIRES_APPROVAL") {
        onActionComplete("Approval request submitted — awaiting manager review");
      } else {
        onActionComplete("Action submitted");
      }

      setTimeout(onRefetch, 600);
    } catch (err) {
      setActionError("Network error — please try again");
    } finally {
      setSubmitting(null);
    }
  }

  return (
    <div style={styles.panel}>
      {actionError && (
        <div style={styles.errorBanner}>
          {actionError}
        </div>
      )}

      {card.availableCtas.map((cta) => (
        <CtaButton
          key={cta.actionType}
          cta={cta}
          isSubmitting={submitting === cta.actionType}
          onAction={() => handleAction(cta)}
        />
      ))}
    </div>
  );
}

function CtaButton({
  cta,
  isSubmitting,
  onAction,
}: {
  cta: AvailableCta;
  isSubmitting: boolean;
  onAction: () => void;
}) {
  const isPrimary = !cta.disabled && !cta.requiresApproval;

  return (
    <div style={styles.ctaRow}>
      <button
        onClick={onAction}
        disabled={cta.disabled || isSubmitting}
        style={{
          ...styles.ctaButton,
          ...(isPrimary ? styles.ctaPrimary : styles.ctaSecondary),
          ...(cta.disabled ? styles.ctaDisabled : {}),
        }}
      >
        {isSubmitting ? (
          <span style={{ display: "flex", alignItems: "center", gap: 6, justifyContent: "center" }}>
            <span style={styles.spinner} />
            Submitting...
          </span>
        ) : (
          <>
            {cta.label}
            {cta.requiresApproval && (
              <span style={styles.approvalBadge}>Requires approval</span>
            )}
          </>
        )}
      </button>
      {cta.disabled && cta.disabledReason && (
        <div style={styles.disabledReason}>{cta.disabledReason}</div>
      )}
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  // Actions are the second step, not the first. Full-width primary buttons
  // above the message made the panel look like a form to complete, when the
  // job is to read what the customer wrote and then decide.
  panel: {
    padding: "10px 16px",
    borderBottom: "1px solid #f0f0f0",
    display: "flex",
    flexWrap: "wrap",
    gap: 6,
  },
  noActions: {
    padding: "12px 16px",
    textAlign: "center",
    borderBottom: "1px solid #f0f0f0",
  },
  errorBanner: {
    background: "#fce8e6",
    border: "1px solid #f5c6c2",
    borderRadius: 4,
    padding: "8px 12px",
    fontSize: 12,
    color: "#a50e0e",
    marginBottom: 10,
  },
  ctaRow: {
    marginBottom: 0,
  },
  ctaButton: {
    padding: "6px 12px",
    border: "1px solid #d8dcde",
    borderRadius: 5,
    fontSize: 12,
    fontWeight: 500,
    cursor: "pointer",
    textAlign: "center" as const,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    transition: "background 0.15s",
  },
  ctaPrimary: {
    background: "white",
    color: "#1f73b7",
    borderColor: "#a8c8e4",
    fontWeight: 600,
  },
  ctaSecondary: {
    background: "white",
    color: "#68737d",
  },
  ctaDisabled: {
    opacity: 0.5,
    cursor: "not-allowed",
  },
  disabledReason: {
    fontSize: 11,
    color: "#68737d",
    marginTop: 4,
    paddingLeft: 4,
  },
  approvalBadge: {
    fontSize: 10,
    background: "rgba(0,0,0,0.15)",
    padding: "1px 6px",
    borderRadius: 8,
    fontWeight: 400,
  },
  spinner: {
    width: 12,
    height: 12,
    border: "2px solid rgba(255,255,255,0.3)",
    borderTop: "2px solid white",
    borderRadius: "50%",
    animation: "spin 0.8s linear infinite",
    display: "inline-block",
  },
};
