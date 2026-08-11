/**
 * @file apps/sidebar/src/components/AnnotationPopover.tsx
 * @description What the system found when it looked up a marked phrase.
 *
 * The point of the overlay: an agent points at "8/1" and the order placed that
 * day appears. Not a restatement of the words — the record behind them.
 *
 * Three things this deliberately does not do.
 *
 * It never shows one record when several matched. Two orders on the same day is
 * a question for the agent, and a single plausible answer is precisely what
 * stops someone looking further — the same failure that lets a refund go out
 * twice.
 *
 * It never hides that nothing was found. "No order on that date" is a useful
 * answer; a blank panel is not.
 *
 * It always says how the match was made. An agent who can see that "$39"
 * matched *by amount* rather than by an identifier knows exactly how much to
 * trust it.
 */

import React from "react";
import { Span, CandidateRecord } from "../lib/spans";
import { formatKind, kindPalette } from "./AnnotatedThread";

interface Props {
  span: Span;
  flagged: boolean;
  id: string;
}

export default function AnnotationPopover({ span, flagged, id }: Props) {
  const palette = kindPalette(span.kind);
  const { candidates } = span;

  return (
    <span
      role="dialog"
      aria-label={`Details for ${span.display}`}
      id={id}
      style={styles.popover}
    >
      <span style={styles.head}>
        <span style={{ ...styles.kind, background: palette.background, color: palette.color }}>
          {formatKind(span.kind)}
        </span>
        <span style={styles.display}>{span.display}</span>
      </span>

      {candidates.length === 0 ? (
        <span style={styles.empty}>{nothingFound(span)}</span>
      ) : (
        <>
          {candidates.length > 1 && (
            <span style={styles.ambiguous}>
              {candidates.length} records match. Confirm which one before acting.
            </span>
          )}
          <span style={styles.records}>
            {candidates.map((record, i) => (
              <Record key={`${record.provider}-${record.reference}-${i}`} record={record} />
            ))}
          </span>
        </>
      )}

      {flagged && (
        <span style={styles.flag}>
          A refund was already issued against this reference on another ticket.
        </span>
      )}

      <span style={styles.provenance}>
        {/* The quote proves the mark landed on the right words. */}
        matched “{span.excerpt}”
        {span.matchedOn && ` by ${span.matchedOn}`} · {Math.round(span.confidence * 100)}%
        {span.authorRole !== "customer" && " · written by an agent"}
      </span>
    </span>
  );
}

function Record({ record }: { record: CandidateRecord }) {
  return (
    <span style={styles.record}>
      <span style={styles.recordHead}>
        <span style={styles.reference}>{record.reference}</span>
        {record.status && <span style={styles.status}>{record.status}</span>}
      </span>

      <span style={styles.recordMeta}>
        <span>{record.provider}</span>
        {record.occurredAt && <span>{formatDate(record.occurredAt)}</span>}
        {record.amountCents !== null && (
          <span style={styles.amount}>
            {formatMoney(record.amountCents, record.currency)}
          </span>
        )}
      </span>

      {record.description && <span style={styles.description}>{record.description}</span>}
    </span>
  );
}

/**
 * Why nothing matched, in terms of what the agent can do about it. A reference
 * that does not resolve means a wrong number; a date that does not means no
 * purchase that day. Different problems, different next steps.
 */
function nothingFound(span: Span): string {
  switch (span.kind) {
    case "order_reference":
    case "payment_reference":
      return "No record with this reference. Check the number with the customer.";
    case "date":
      return "No order or charge on this date in the customer's recent history.";
    case "money":
      return "No charge or order for this amount in the customer's recent history.";
    default:
      return "Read from the message; nothing to look up.";
  }
}

function formatDate(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? ""
    : date.toLocaleDateString(undefined, {
        month: "short",
        day: "numeric",
        year: "numeric",
      });
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

const styles: Record<string, React.CSSProperties> = {
  popover: {
    position: "absolute",
    top: "calc(100% + 6px)",
    // Anchored to the left of the mark but clamped to the viewport: a Zendesk
    // sidebar is narrow, and a panel that runs off the edge is unreadable
    // exactly when the mark sits near the end of a line.
    left: 0,
    maxWidth: "min(300px, calc(100vw - 32px))",
    zIndex: 20,
    display: "flex",
    flexDirection: "column",
    gap: 8,
    minWidth: 220,
    padding: "10px 12px",
    background: "white",
    border: "1px solid #d8dcde",
    borderRadius: 6,
    boxShadow: "0 6px 20px rgba(0,0,0,0.14)",
    fontWeight: 400,
    fontStyle: "normal",
    textDecoration: "none",
    whiteSpace: "normal",
    cursor: "default",
    textAlign: "left",
  },
  head: { display: "flex", alignItems: "center", gap: 6 },
  kind: {
    fontSize: 9,
    fontWeight: 700,
    textTransform: "uppercase",
    letterSpacing: 0.4,
    padding: "2px 6px",
    borderRadius: 3,
  },
  display: { fontSize: 13, fontWeight: 600, color: "#2f3941" },
  empty: { fontSize: 11, color: "#68737d", lineHeight: 1.45 },
  ambiguous: {
    fontSize: 11,
    color: "#8a5300",
    background: "#fff8e1",
    borderRadius: 4,
    padding: "5px 7px",
    lineHeight: 1.4,
  },
  records: { display: "flex", flexDirection: "column", gap: 8 },
  record: {
    display: "flex",
    flexDirection: "column",
    gap: 2,
    borderLeft: "2px solid #e9ebed",
    paddingLeft: 8,
  },
  recordHead: { display: "flex", alignItems: "baseline", gap: 6 },
  reference: { fontSize: 12, fontWeight: 600, color: "#2f3941", fontFamily: "monospace" },
  status: { fontSize: 10, color: "#1a6e27", textTransform: "uppercase", letterSpacing: 0.3 },
  recordMeta: { display: "flex", gap: 8, fontSize: 11, color: "#68737d", flexWrap: "wrap" },
  amount: { fontWeight: 600, color: "#2f3941" },
  description: { fontSize: 11, color: "#68737d" },
  flag: {
    fontSize: 11,
    color: "#8c232c",
    background: "#fff0ee",
    borderRadius: 4,
    padding: "6px 8px",
    lineHeight: 1.4,
  },
  provenance: {
    fontSize: 10,
    color: "#c2c8cc",
    lineHeight: 1.4,
    borderTop: "1px solid #f0f0f0",
    paddingTop: 6,
  },
};
