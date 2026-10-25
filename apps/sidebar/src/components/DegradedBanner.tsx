/**
 * @file apps/sidebar/src/components/DegradedBanner.tsx
 * Non-accusatory banner for degraded mode states.
 * Spec §9: no accusation language. Source unavailable ≠ fraud signal.
 */

import React from "react";
import Icon from "./Icon";

interface DegradedBannerProps {
  isSourceUnavailable: boolean;
  sourceUnavailableReason: string | null;
  freshnessStatus: string;
  evidenceFetchedAt: string | null;
}

export default function DegradedBanner({
  isSourceUnavailable,
  sourceUnavailableReason,
  freshnessStatus,
  evidenceFetchedAt,
}: DegradedBannerProps) {
  if (isSourceUnavailable) {
    return (
      <div style={styles.unavailableBanner}>
        <Icon name="alert" size={17} />
        <div>
          <div style={styles.title}>Source record no longer available — case record preserved</div>
          {sourceUnavailableReason && (
            <div style={styles.detail}>{sourceUnavailableReason}</div>
          )}
        </div>
      </div>
    );
  }

  if (freshnessStatus === "STALE") {
    const age = evidenceFetchedAt
      ? Math.round((Date.now() - new Date(evidenceFetchedAt).getTime()) / 60000)
      : null;

    return (
      <div style={styles.staleBanner}>
        <Icon name="clock" size={17} />
        <div>
          <div style={styles.title}>Evidence may not reflect the latest state</div>
          <div style={styles.detail}>
            {age !== null ? `Last fetched ${age}m ago.` : "Last fetch time unknown."}{" "}
            Consider refreshing before taking action.
          </div>
        </div>
      </div>
    );
  }

  return null;
}

const styles: Record<string, React.CSSProperties> = {
  unavailableBanner: {
    display: "flex",
    alignItems: "flex-start",
    gap: 10,
    padding: "10px 16px",
    background: "var(--warning-soft)",
    borderBottom: "1px solid #f0e4c6",
  },
  staleBanner: {
    display: "flex",
    alignItems: "flex-start",
    gap: 10,
    padding: "10px 16px",
    background: "var(--warning-soft)",
    borderBottom: "1px solid #f0c040",
  },
  icon: { fontSize: 16, flexShrink: 0, marginTop: 1 },
  title: { fontSize: 12, fontWeight: 500, color: "var(--text)", marginBottom: 2 },
  detail: { fontSize: 11, color: "var(--muted)", lineHeight: 1.4 },
};
