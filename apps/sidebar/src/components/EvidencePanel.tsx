/**
 * @file apps/sidebar/src/components/EvidencePanel.tsx
 * @description Detailed evidence panel — shown in progressive disclosure.
 * Non-accusatory language throughout.
 */

import React from "react";

/** Narrow an unknown summary field for display; "" reads as absent. */
function text(value: unknown): string {
  if (value === null || value === undefined) return "";
  return String(value);
}

/** Narrow an unknown summary field to a number, if it is one. */
function num(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

interface EvidencePanelProps {
  evidenceSummary: Record<string, unknown>;
  matchBand: string | null;
  confidenceScore: number | null;
  isSourceUnavailable: boolean;
}

export default function EvidencePanel({
  evidenceSummary,
  matchBand,
  confidenceScore,
  isSourceUnavailable,
}: EvidencePanelProps) {
  return (
    <div style={styles.panel}>
      <div style={styles.sectionTitle}>Evidence Detail</div>

      {isSourceUnavailable && (
        <div style={styles.unavailableNote}>
          Source record is no longer available. Showing last known state.
        </div>
      )}

      <div className="evidence-grid" style={styles.grid}>
        {/* Stripe Evidence */}
        {text(evidenceSummary.stripeRefundId) !== "" && (
          <DetailBlock
            title="Stripe Refund"
            items={[
              ["ID", text(evidenceSummary.stripeRefundId) || "—"],
              ["Status", text(evidenceSummary.stripeRefundStatus) || "—"],
              ["Amount", formatCents(num(evidenceSummary.stripeChargeAmount), text(evidenceSummary.stripeCurrency))],
            ]}
          />
        )}

        {/* Shopify Evidence */}
        {text(evidenceSummary.shopifyOrderId) !== "" && (
          <DetailBlock
            title="Shopify Order"
            items={[
              ["Order", text(evidenceSummary.shopifyOrderName) || text(evidenceSummary.shopifyOrderId)],
              ["Financial", text(evidenceSummary.shopifyFinancialStatus) || "—"],
              ["Fulfillment", text(evidenceSummary.shopifyFulfillmentStatus) || "—"],
              ["Total", formatCents(num(evidenceSummary.shopifyOrderTotal), text(evidenceSummary.shopifyOrderCurrency))],
            ]}
          />
        )}
      </div>

      {/* Match result */}
      {matchBand && (
        <div style={styles.matchRow}>
          <span style={styles.matchLabel}>Match result</span>
          <span style={{
            ...styles.matchValue,
            color: matchBand === "HIGH" || matchBand === "EXACT" ? "var(--accent)" :
                   matchBand === "MEDIUM" ? "#7a4f00" : "var(--danger)",
          }}>
            {matchBand}
            {confidenceScore !== null && ` (${Math.round(confidenceScore * 100)}%)`}
          </span>
        </div>
      )}
    </div>
  );
}

function DetailBlock({ title, items }: { title: string; items: [string, string][] }) {
  return (
    <div style={styles.detailBlock}>
      <div style={styles.detailTitle}>{title}</div>
      {items.map(([label, value]) => (
        <div className="evidence-detail-row" key={label} style={styles.detailRow}>
          <span style={styles.detailLabel}>{label}</span>
          <span style={styles.detailValue}>{value}</span>
        </div>
      ))}
    </div>
  );
}

function formatCents(cents?: number, currency?: string): string {
  if (cents === undefined) return "—";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: (currency ?? "usd").toUpperCase(),
  }).format(cents / 100);
}

const styles: Record<string, React.CSSProperties> = {
  panel: {
    padding: "12px 16px",
    borderBottom: "1px solid var(--line)",
    background: "var(--canvas)",
  },
  sectionTitle: {
    fontSize: 11,
    fontWeight: 600,
    color: "var(--muted)",
    textTransform: "uppercase" as const,
    letterSpacing: 0.5,
    marginBottom: 10,
  },
  unavailableNote: {
    fontSize: 11,
    color: "#7a4f00",
    background: "var(--warning-soft)",
    padding: "6px 8px",
    borderRadius: 4,
    marginBottom: 10,
  },
  grid: {
    display: "grid",
    gridTemplateColumns: "1fr 1fr",
    gap: 12,
    marginBottom: 10,
  },
  detailBlock: {
    background: "white",
    border: "1px solid #e0e0e0",
    borderRadius: 4,
    padding: "8px 10px",
  },
  detailTitle: {
    fontSize: 11,
    fontWeight: 600,
    color: "var(--text)",
    marginBottom: 6,
    paddingBottom: 4,
    borderBottom: "1px solid var(--line)",
  },
  detailRow: {
    display: "flex",
    justifyContent: "space-between",
    marginBottom: 3,
  },
  detailLabel: { fontSize: 11, color: "var(--muted)" },
  detailValue: { fontSize: 11, fontWeight: 500, color: "var(--text)" },
  matchRow: {
    display: "flex",
    justifyContent: "space-between",
    padding: "6px 0",
    borderTop: "1px solid #e8eaed",
    marginTop: 4,
  },
  matchLabel: { fontSize: 12, color: "var(--muted)" },
  matchValue: { fontSize: 12, fontWeight: 600 },
};
