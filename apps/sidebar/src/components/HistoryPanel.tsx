/**
 * @file apps/sidebar/src/components/HistoryPanel.tsx
 * @description Previous interactions with this customer.
 *
 * The critical notice — "a refund was already issued for this order" — renders
 * above the action buttons, because a warning placed below the button the agent
 * is about to click is decoration. Everything else is collapsed by default:
 * history is context, not an interruption.
 *
 * The list states what was done, never what the customer is like. "Ticket #900,
 * refunded $49.99" is checkable; "frequent refunder" is a judgement the system
 * has no standing to make and an agent cannot verify.
 */

import React, { useState } from "react";
import type { CustomerHistory, HistoryNotice, PriorInteraction } from "../hooks/useCardData";

/**
 * The notices that belong above the primary action, rendered on their own so
 * the card can place them before the buttons.
 */
export function HistoryNotices({ history }: { history: CustomerHistory }) {
  const blocking = history.notices.filter(
    (n) => n.severity === "critical" || n.severity === "warning"
  );

  if (blocking.length === 0) return null;

  return (
    <div>
      {blocking.map((notice, i) => (
        <Notice key={`${notice.code}-${i}`} notice={notice} />
      ))}
    </div>
  );
}

function Notice({ notice }: { notice: HistoryNotice }) {
  const critical = notice.severity === "critical";

  return (
    <div style={critical ? styles.criticalNotice : styles.warningNotice}>
      <span style={styles.noticeIcon}>{critical ? "⚠" : "ℹ"}</span>
      <span style={critical ? styles.criticalText : styles.warningText}>
        {notice.message}
      </span>
    </div>
  );
}

export default function HistoryPanel({ history }: { history: CustomerHistory }) {
  const [open, setOpen] = useState(false);

  if (history.priorIssueCount === 0) return null;

  const informational = history.notices.filter((n) => n.severity === "info");

  return (
    <div style={styles.panel}>
      <button style={styles.toggle} onClick={() => setOpen(!open)}>
        <span>
          {/*
            "Other", not "Previous": the list is every other issue for this
            customer, which can include one opened after this ticket. A refund
            that exists is a duplicate risk whenever it was issued, so the
            window is deliberately not filtered to earlier dates — but calling
            a newer ticket "previous" would be a false statement, and each row
            carries its date so the order is visible.
          */}
          {open ? "▲" : "▼"} Other interactions ({history.priorIssueCount}
          {history.truncated ? "+" : ""})
        </span>
      </button>

      {open && (
        <div style={styles.body}>
          {informational.map((notice, i) => (
            <div key={`${notice.code}-${i}`} style={styles.infoLine}>
              {notice.message}
            </div>
          ))}

          {history.priorInteractions.map((interaction, i) => (
            <InteractionRow key={interaction.zendeskTicketId ?? i} interaction={interaction} />
          ))}

          {history.truncated && (
            <div style={styles.truncated}>
              This customer has more history than the {history.priorInteractions.length}{" "}
              most recent issues shown here.
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function InteractionRow({ interaction }: { interaction: PriorInteraction }) {
  const refunded =
    interaction.refundStatus === "succeeded" &&
    interaction.refundedAmountCents !== null;

  return (
    <div
      style={{
        ...styles.row,
        ...(interaction.sameSubject ? styles.rowSameSubject : {}),
      }}
    >
      <div style={styles.rowTop}>
        <span style={styles.ticket}>
          {interaction.zendeskTicketId
            ? `#${interaction.zendeskTicketId}`
            : "(no ticket)"}
        </span>
        <span style={styles.date}>{formatDate(interaction.openedAt)}</span>
      </div>

      <div style={styles.rowMeta}>
        {interaction.primaryAsk && (
          <span>{formatAsk(interaction.primaryAsk)}</span>
        )}
        {interaction.orderReference && (
          <span style={styles.orderRef}>order #{interaction.orderReference}</span>
        )}
        {refunded && (
          <span style={styles.refunded}>
            refunded{" "}
            {formatMoney(
              interaction.refundedAmountCents as number,
              interaction.refundCurrency
            )}
          </span>
        )}
        {interaction.sameSubject && (
          <span style={styles.sameChip}>same order</span>
        )}
      </div>
    </div>
  );
}

// ─── Formatting ──────────────────────────────────────────────────────────────

function formatAsk(ask: string): string {
  const labels: Record<string, string> = {
    refund_request: "Refund requested",
    cancellation_request: "Cancellation requested",
    return_request: "Return requested",
    status_check: "Status check",
    reship_request: "Replacement requested",
    escalation_request: "Escalation requested",
  };
  return labels[ask] ?? ask.replace(/_/g, " ");
}

function formatDate(iso: string): string {
  if (!iso) return "—";
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? "—"
    : date.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

/** Zero-decimal currencies are not divided by 100 — ¥500 is five hundred yen. */
const ZERO_DECIMAL = new Set([
  "bif", "clp", "djf", "gnf", "jpy", "kmf", "krw", "mga",
  "pyg", "rwf", "ugx", "vnd", "vuv", "xaf", "xof", "xpf",
]);

function formatMoney(minorUnits: number, currency: string | null): string {
  const code = (currency ?? "usd").toLowerCase();
  const amount = ZERO_DECIMAL.has(code) ? minorUnits : minorUnits / 100;

  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: code.toUpperCase(),
    }).format(amount);
  } catch {
    return `${amount} ${code.toUpperCase()}`;
  }
}

// ─── Styles ──────────────────────────────────────────────────────────────────

const styles: Record<string, React.CSSProperties> = {
  criticalNotice: {
    background: "#fff0ee",
    borderBottom: "1px solid #e8503a",
    borderLeft: "3px solid #cc3340",
    padding: "10px 16px",
    display: "flex",
    alignItems: "flex-start",
    gap: 8,
  },
  warningNotice: {
    background: "#fff8e1",
    borderBottom: "1px solid #f0c040",
    padding: "9px 16px",
    display: "flex",
    alignItems: "flex-start",
    gap: 8,
  },
  noticeIcon: { fontSize: 13, flexShrink: 0, marginTop: 1 },
  criticalText: {
    fontSize: 12,
    color: "#8c232c",
    lineHeight: 1.45,
    fontWeight: 500,
  },
  warningText: {
    fontSize: 12,
    color: "#5f4b00",
    lineHeight: 1.45,
  },
  panel: {
    borderBottom: "1px solid #f0f0f0",
  },
  toggle: {
    width: "100%",
    padding: "8px 16px",
    background: "none",
    border: "none",
    color: "#1f73b7",
    fontSize: 12,
    cursor: "pointer",
    textAlign: "left",
  },
  body: {
    padding: "0 16px 12px",
    display: "flex",
    flexDirection: "column",
    gap: 8,
  },
  infoLine: {
    fontSize: 11,
    color: "#68737d",
    lineHeight: 1.45,
    paddingBottom: 4,
  },
  row: {
    borderLeft: "2px solid #e9ebed",
    paddingLeft: 10,
  },
  rowSameSubject: {
    borderLeft: "2px solid #cc3340",
  },
  rowTop: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "baseline",
  },
  ticket: {
    fontSize: 12,
    fontWeight: 600,
    color: "#2f3941",
  },
  date: {
    fontSize: 10,
    color: "#c2c8cc",
  },
  rowMeta: {
    display: "flex",
    flexWrap: "wrap",
    gap: 8,
    fontSize: 11,
    color: "#68737d",
    marginTop: 2,
  },
  orderRef: {
    fontFamily: "monospace",
  },
  refunded: {
    color: "#1a6e27",
    fontWeight: 500,
  },
  sameChip: {
    fontSize: 9,
    fontWeight: 600,
    textTransform: "uppercase",
    letterSpacing: 0.4,
    padding: "1px 5px",
    borderRadius: 3,
    background: "#fff0ee",
    color: "#cc3340",
  },
  truncated: {
    fontSize: 10,
    color: "#c2c8cc",
    fontStyle: "italic",
  },
};
