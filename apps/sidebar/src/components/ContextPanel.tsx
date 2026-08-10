/**
 * @file apps/sidebar/src/components/ContextPanel.tsx
 * @description What the customer actually said — the points of importance the
 * extractor found, each next to the text it came from.
 *
 * Two rules shape this component.
 *
 * Every claim shows its source. A panel that asserts "$49.99" with no quote is
 * asking the agent to trust a regex; one that shows the sentence lets them
 * check it in the time it takes to read. When the extractor is wrong, that has
 * to be *visible*, not buried.
 *
 * Nothing here is a judgement about the customer. The extractor reports what
 * was requested and what was referenced. It does not score tone, urgency, or
 * likelihood of abuse, and this panel has nowhere to put such a thing.
 */

import React from "react";
import type { ContextHighlight, TicketContext } from "../hooks/useCardData";

interface ContextPanelProps {
  context: TicketContext;
}

export default function ContextPanel({ context }: ContextPanelProps) {
  if (context.highlights.length === 0) {
    return (
      <div style={styles.panel}>
        <div style={styles.heading}>From the conversation</div>
        <div style={styles.empty}>
          {context.messageCount > 0
            ? "No amounts, dates, or order references were found in this thread."
            : "The ticket thread could not be read."}
        </div>
      </div>
    );
  }

  return (
    <div style={styles.panel}>
      <div style={styles.headingRow}>
        <span style={styles.heading}>From the conversation</span>
        <span style={styles.meta}>
          {context.messageCount} message{context.messageCount === 1 ? "" : "s"} read
        </span>
      </div>

      {context.primaryAsk && (
        <div style={styles.askRow}>
          <span style={styles.askLabel}>Asking for</span>
          <span style={styles.askValue}>{formatAsk(context.primaryAsk)}</span>
        </div>
      )}

      <div style={styles.highlights}>
        {context.highlights.map((h, i) => (
          <Highlight key={`${h.kind}-${i}`} highlight={h} />
        ))}
      </div>
    </div>
  );
}

function Highlight({ highlight }: { highlight: ContextHighlight }) {
  const uncertain = highlight.confidence < 0.7;

  return (
    <div style={styles.highlight}>
      <div style={styles.highlightTop}>
        <span style={{ ...styles.kindChip, ...kindStyle(highlight.kind) }}>
          {formatKind(highlight.kind)}
        </span>
        <span style={styles.highlightValue}>{highlight.display}</span>
        {uncertain && (
          // Only flagged when it is genuinely shaky. A confidence number on
          // every row is noise the agent learns to skip.
          <span style={styles.uncertainChip} title="Low confidence — verify before acting">
            unsure
          </span>
        )}
      </div>
      <div style={styles.excerpt}>
        <span style={styles.quoteMark}>“</span>
        {highlight.excerpt}
        <span style={styles.quoteMark}>”</span>
        <span style={styles.author}>
          {highlight.authorRole === "customer" ? " — customer" : " — agent"}
        </span>
      </div>
    </div>
  );
}

// ─── Formatting ──────────────────────────────────────────────────────────────

function formatAsk(ask: string): string {
  const labels: Record<string, string> = {
    refund_request: "A refund",
    cancellation_request: "A cancellation",
    return_request: "A return",
    status_check: "A status update",
    reship_request: "A replacement shipment",
    escalation_request: "To speak to a manager",
  };
  return labels[ask] ?? ask.replace(/_/g, " ");
}

function formatKind(kind: string): string {
  const labels: Record<string, string> = {
    money: "Amount",
    date: "Date",
    order_reference: "Order",
    payment_reference: "Payment",
    ask: "Request",
  };
  return labels[kind] ?? kind.replace(/_/g, " ");
}

function kindStyle(kind: string): React.CSSProperties {
  const palette: Record<string, React.CSSProperties> = {
    payment_reference: { background: "#e8f1fb", color: "#1f73b7" },
    order_reference: { background: "#e8f1fb", color: "#1f73b7" },
    money: { background: "#edf7ed", color: "#1a6e27" },
    date: { background: "#f4f0fa", color: "#5c3f9e" },
    ask: { background: "#fff4e5", color: "#8a5300" },
  };
  return palette[kind] ?? { background: "#f0f0f0", color: "#68737d" };
}

// ─── Styles ──────────────────────────────────────────────────────────────────

const styles: Record<string, React.CSSProperties> = {
  panel: {
    padding: "12px 16px",
    borderBottom: "1px solid #f0f0f0",
  },
  headingRow: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "baseline",
    marginBottom: 8,
  },
  heading: {
    fontSize: 11,
    fontWeight: 600,
    color: "#68737d",
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  meta: {
    fontSize: 10,
    color: "#c2c8cc",
  },
  empty: {
    fontSize: 12,
    color: "#68737d",
    marginTop: 6,
    lineHeight: 1.4,
  },
  askRow: {
    display: "flex",
    alignItems: "baseline",
    gap: 8,
    marginBottom: 10,
  },
  askLabel: {
    fontSize: 12,
    color: "#68737d",
  },
  askValue: {
    fontSize: 13,
    fontWeight: 600,
    color: "#2f3941",
  },
  highlights: {
    display: "flex",
    flexDirection: "column",
    gap: 8,
  },
  highlight: {
    borderLeft: "2px solid #e9ebed",
    paddingLeft: 10,
  },
  highlightTop: {
    display: "flex",
    alignItems: "center",
    gap: 6,
    flexWrap: "wrap",
  },
  kindChip: {
    fontSize: 9,
    fontWeight: 600,
    textTransform: "uppercase",
    letterSpacing: 0.4,
    padding: "2px 6px",
    borderRadius: 3,
  },
  highlightValue: {
    fontSize: 13,
    fontWeight: 500,
    color: "#2f3941",
  },
  uncertainChip: {
    fontSize: 9,
    fontWeight: 600,
    textTransform: "uppercase",
    letterSpacing: 0.4,
    padding: "2px 6px",
    borderRadius: 3,
    background: "#fff4e5",
    color: "#8a5300",
    cursor: "help",
  },
  excerpt: {
    fontSize: 11,
    color: "#68737d",
    marginTop: 3,
    lineHeight: 1.45,
    fontStyle: "italic",
  },
  quoteMark: {
    color: "#c2c8cc",
  },
  author: {
    fontStyle: "normal",
    color: "#c2c8cc",
  },
};
