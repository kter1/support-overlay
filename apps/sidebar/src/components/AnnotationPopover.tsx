/**
 * @file apps/sidebar/src/components/AnnotationPopover.tsx
 * @description What one marked span actually is.
 *
 * The mark says "this is an order number". This says which order, what the
 * provider currently reports about it, how confident the match is, and which
 * rule produced it. That last part matters more than it looks: an agent who
 * can see *why* something was marked can tell a good match from a bad one, and
 * a system whose reasoning is inspectable earns trust that a bare score never
 * does.
 *
 * When a reference resolved to nothing, this says so plainly rather than
 * showing an empty record. "We could not find this" is a useful answer; a
 * blank panel is not.
 */

import React from "react";
import { Span } from "../lib/spans";
import { formatKind, kindPalette } from "./AnnotatedThread";

interface Props {
  span: Span;
  flagged: boolean;
  id: string;
}

export default function AnnotationPopover({ span, flagged, id }: Props) {
  const palette = kindPalette(span.kind);
  const resolved = span.resolved;

  return (
    <span role="dialog" aria-label={`Details for ${span.display}`} id={id} style={styles.popover}>
      <span style={styles.head}>
        <span style={{ ...styles.kind, background: palette.background, color: palette.color }}>
          {formatKind(span.kind)}
        </span>
        <span style={styles.display}>{span.display}</span>
      </span>

      {resolved ? (
        <span style={styles.rows}>
          <Row label="Source" value={`${resolved.provider} · ${resolved.recordType}`} />
          <Row label="Reference" value={resolved.reference} mono />
          {resolved.status && <Row label="Status" value={resolved.status} />}
          {resolved.amountCents !== null && (
            <Row
              label="Amount"
              value={formatMoney(resolved.amountCents, resolved.currency)}
            />
          )}
        </span>
      ) : (
        <span style={styles.unresolved}>
          {isReference(span.kind)
            ? "No matching record was found at the provider."
            : "Read from the message text; not looked up anywhere."}
        </span>
      )}

      {flagged && (
        <span style={styles.flag}>
          A refund was already issued against this reference on another ticket.
        </span>
      )}

      <span style={styles.provenance}>
        {/* The quote proves the mark landed on the right words. */}
        matched “{span.excerpt}” · {Math.round(span.confidence * 100)}% · {span.rule}
        {span.authorRole !== "customer" && " · written by an agent"}
      </span>
    </span>
  );
}

function Row({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <span style={styles.row}>
      <span style={styles.label}>{label}</span>
      <span style={{ ...styles.value, ...(mono ? styles.mono : {}) }}>{value}</span>
    </span>
  );
}

function isReference(kind: string): boolean {
  return kind === "order_reference" || kind === "payment_reference";
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
    left: 0,
    zIndex: 20,
    display: "flex",
    flexDirection: "column",
    gap: 6,
    minWidth: 220,
    maxWidth: 280,
    padding: "10px 12px",
    background: "white",
    border: "1px solid #d8dcde",
    borderRadius: 6,
    boxShadow: "0 4px 14px rgba(0,0,0,0.12)",
    fontWeight: 400,
    fontStyle: "normal",
    whiteSpace: "normal",
    cursor: "default",
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
  rows: { display: "flex", flexDirection: "column", gap: 2 },
  row: { display: "flex", justifyContent: "space-between", gap: 12 },
  label: { fontSize: 11, color: "#68737d" },
  value: { fontSize: 11, color: "#2f3941", fontWeight: 500, textAlign: "right" },
  mono: { fontFamily: "monospace" },
  unresolved: { fontSize: 11, color: "#68737d", lineHeight: 1.45 },
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
