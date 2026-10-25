/**
 * @file apps/sidebar/src/components/StatusBadge.tsx
 * Match confidence badge for the Resolution Card.
 */

import React from "react";

interface StatusBadgeProps {
  matchBand: string;
  confidence: number | null;
}

const BAND_CONFIG: Record<string, { label: string; bg: string; color: string }> = {
  EXACT:    { label: "Exact match",   bg: "var(--accent-soft)", color: "var(--accent)" },
  HIGH:     { label: "High match",    bg: "var(--accent-soft)", color: "var(--accent)" },
  MEDIUM:   { label: "Partial match", bg: "#fef7e0", color: "#7a4f00" },
  LOW:      { label: "Low match",     bg: "var(--danger-soft)", color: "var(--danger)" },
  NO_MATCH: { label: "No match",      bg: "#f1f3f4", color: "#5f6368" },
};

export default function StatusBadge({ matchBand, confidence }: StatusBadgeProps) {
  const config = BAND_CONFIG[matchBand] ?? BAND_CONFIG["NO_MATCH"];
  const pct = confidence !== null ? ` (${Math.round(confidence * 100)}%)` : "";

  return (
    <span
      style={{
        display: "inline-block",
        padding: "2px 8px",
        borderRadius: 10,
        fontSize: 11,
        fontWeight: 500,
        background: config.bg,
        color: config.color,
      }}
    >
      {config.label}{pct}
    </span>
  );
}
