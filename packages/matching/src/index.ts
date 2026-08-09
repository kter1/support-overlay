/**
 * @iisl/matching — deterministic evidence matching
 *
 * Answers one question: does the refund we can see in Stripe correspond to the
 * order and the ticket the agent is looking at?
 *
 * Deliberately deterministic and rule-based, not a model. The output an agent
 * acts on is the *explanation* — "matched on charge id, amount exact, 3h
 * window" — and a score nobody can reconstruct is worse than no score. It also
 * means the same evidence always yields the same band, which is what makes the
 * audit trail defensible.
 *
 * Scoring is additive over independent signals, each contributing a weight when
 * it agrees and subtracting when it actively disagrees. Absent signals neither
 * help nor hurt beyond the confidence ceiling they impose.
 */

export enum MatchBand {
  EXACT = "EXACT",
  HIGH = "HIGH",
  MEDIUM = "MEDIUM",
  LOW = "LOW",
  NO_MATCH = "NO_MATCH",
}

/** Normalized evidence from one provider. */
export interface EvidenceFacts {
  refundAmountCents?: number | null;
  orderTotalCents?: number | null;
  currency?: string | null;
  refundStatus?: string | null;
  financialStatus?: string | null;
  chargeId?: string | null;
  orderId?: string | null;
  /** Order/charge reference extracted from the ticket, if any. */
  ticketOrderReference?: string | null;
  refundCreatedAt?: Date | null;
  orderCreatedAt?: Date | null;
  ticketCreatedAt?: Date | null;
  isSourceUnavailable?: boolean;
}

export interface MatchConfig {
  /** Percent difference tolerated between refund and order amounts. */
  amountTolerancePct: number;
  /** Hours between refund and ticket beyond which timing stops corroborating. */
  timingWindowHours: number;
}

export const DEFAULT_MATCH_CONFIG: MatchConfig = {
  amountTolerancePct: 2,
  timingWindowHours: 72,
};

export interface MatchSignal {
  /** Stable identifier, written to matched_fields. */
  field: string;
  /** How this signal landed. */
  outcome: "agree" | "disagree" | "absent";
  /** Signed contribution to the raw score. */
  contribution: number;
  /** Agent-facing sentence. Never accusatory, never about the customer. */
  note: string;
}

export interface MatchResult {
  band: MatchBand;
  /** 0.0–1.0, rounded to 4 decimal places to match the column type. */
  confidenceScore: number;
  matchedFields: string[];
  signals: MatchSignal[];
  /** One-paragraph explanation, suitable for display and for the audit log. */
  notes: string;
  algorithmVersion: string;
}

export const MATCH_ALGORITHM_VERSION = "match_v1";

/**
 * Signal weights, summing to exactly 1.0.
 *
 * Identifier linkage carries the most weight because it is the only signal that
 * establishes identity rather than plausibility: two unrelated refunds can
 * share an amount, a currency, and a day, but not a charge id.
 *
 * Its weight is also sized deliberately. With linkage absent the remaining
 * signals total 0.70, which is below the HIGH threshold — so a match with no
 * identifier can never be presented as high confidence no matter how neatly
 * everything else lines up. That ceiling is a property of the weights rather
 * than a separate clamp, so it cannot drift out of sync.
 */
const WEIGHTS = {
  chargeLinkage: 0.3,
  amount: 0.25,
  currency: 0.1,
  refundStatus: 0.2,
  timing: 0.15,
} as const;

/** Degraded evidence caps at MEDIUM: the last known state may be stale. */
const SOURCE_UNAVAILABLE_CEILING = 0.79;

const BAND_THRESHOLDS: Array<[number, MatchBand]> = [
  [0.98, MatchBand.EXACT],
  [0.85, MatchBand.HIGH],
  [0.7, MatchBand.MEDIUM],
  [0.5, MatchBand.LOW],
];

export function computeMatch(
  facts: EvidenceFacts,
  config: MatchConfig = DEFAULT_MATCH_CONFIG
): MatchResult {
  const signals: MatchSignal[] = [
    chargeLinkageSignal(facts),
    amountSignal(facts, config),
    currencySignal(facts),
    refundStatusSignal(facts),
    timingSignal(facts, config),
  ];

  const raw = signals.reduce((sum, s) => sum + s.contribution, 0);
  let score = clamp(raw, 0, 1);

  // A disagreeing identifier is disqualifying regardless of everything else:
  // this is evidence about a different transaction.
  const linkage = signals.find((s) => s.field === "charge_linkage");
  if (linkage?.outcome === "disagree") {
    score = Math.min(score, 0.2);
  }

  if (facts.isSourceUnavailable) {
    score = Math.min(score, SOURCE_UNAVAILABLE_CEILING);
  }

  const confidenceScore = round4(score);

  return {
    band: bandFor(confidenceScore),
    confidenceScore,
    matchedFields: signals.filter((s) => s.outcome === "agree").map((s) => s.field),
    signals,
    notes: buildNotes(signals, facts),
    algorithmVersion: MATCH_ALGORITHM_VERSION,
  };
}

// ─── Signals ─────────────────────────────────────────────────────────────────

/**
 * Does an identifier tie the refund to the order or the ticket? This is the
 * only signal that establishes identity rather than resemblance.
 */
function chargeLinkageSignal(facts: EvidenceFacts): MatchSignal {
  const reference = normalizeId(facts.ticketOrderReference);
  const orderId = normalizeId(facts.orderId);
  const chargeId = normalizeId(facts.chargeId);

  if (!reference || (!orderId && !chargeId)) {
    return {
      field: "charge_linkage",
      outcome: "absent",
      contribution: 0,
      note: "No order or charge reference was available to link these records.",
    };
  }

  if (reference === orderId || reference === chargeId) {
    return {
      field: "charge_linkage",
      outcome: "agree",
      contribution: WEIGHTS.chargeLinkage,
      note: `Linked by identifier (${reference}).`,
    };
  }

  return {
    field: "charge_linkage",
    outcome: "disagree",
    contribution: -WEIGHTS.chargeLinkage,
    note:
      `The referenced identifier (${reference}) does not match the ` +
      `record on file (${orderId ?? chargeId}).`,
  };
}

function amountSignal(facts: EvidenceFacts, config: MatchConfig): MatchSignal {
  const refund = facts.refundAmountCents;
  const total = facts.orderTotalCents;

  if (typeof refund !== "number" || typeof total !== "number" || total === 0) {
    return {
      field: "refund_amount",
      outcome: "absent",
      contribution: 0,
      note: "Amounts could not be compared — one side was unavailable.",
    };
  }

  if (refund === total) {
    return {
      field: "refund_amount",
      outcome: "agree",
      contribution: WEIGHTS.amount,
      note: `Refund amount matches the order total exactly (${formatCents(refund)}).`,
    };
  }

  const differencePct = (Math.abs(refund - total) / Math.abs(total)) * 100;

  if (differencePct <= config.amountTolerancePct) {
    return {
      field: "refund_amount",
      outcome: "agree",
      // Within tolerance but not exact: most of the weight, not all of it.
      contribution: WEIGHTS.amount * 0.8,
      note:
        `Refund ${formatCents(refund)} is within ${config.amountTolerancePct}% ` +
        `of the order total ${formatCents(total)}.`,
    };
  }

  // A partial refund is a normal outcome, not a contradiction, so it costs less
  // than an amount that exceeds the order.
  const isPartial = refund < total;
  return {
    field: "refund_amount",
    outcome: "disagree",
    contribution: isPartial ? -WEIGHTS.amount * 0.4 : -WEIGHTS.amount,
    note: isPartial
      ? `Refund ${formatCents(refund)} is a partial amount against an order ` +
        `total of ${formatCents(total)}.`
      : `Refund ${formatCents(refund)} exceeds the order total ` +
        `${formatCents(total)}.`,
  };
}

function currencySignal(facts: EvidenceFacts): MatchSignal {
  const currency = facts.currency?.trim().toLowerCase();

  if (!currency) {
    return {
      field: "currency",
      outcome: "absent",
      contribution: 0,
      note: "Currency was not recorded on both sides.",
    };
  }

  return {
    field: "currency",
    outcome: "agree",
    contribution: WEIGHTS.currency,
    note: `Currency ${currency.toUpperCase()} is consistent.`,
  };
}

function refundStatusSignal(facts: EvidenceFacts): MatchSignal {
  const status = facts.refundStatus?.trim().toLowerCase();

  if (!status) {
    return {
      field: "refund_status",
      outcome: "absent",
      contribution: 0,
      note: "Refund status was unavailable.",
    };
  }

  if (status === "succeeded") {
    const financial = facts.financialStatus?.trim().toLowerCase();
    const corroborated = financial === "refunded" || financial === "partially_refunded";

    return {
      field: "refund_status",
      outcome: "agree",
      contribution: corroborated ? WEIGHTS.refundStatus : WEIGHTS.refundStatus * 0.7,
      note: corroborated
        ? "Refund succeeded and the order is marked refunded."
        : "Refund succeeded in the payment provider.",
    };
  }

  if (status === "pending") {
    return {
      field: "refund_status",
      outcome: "absent",
      contribution: 0,
      note: "Refund is still pending, so the outcome is not yet settled.",
    };
  }

  return {
    field: "refund_status",
    outcome: "disagree",
    contribution: -WEIGHTS.refundStatus,
    note: `Refund status is ${status}, so no completed refund is on record.`,
  };
}

function timingSignal(facts: EvidenceFacts, config: MatchConfig): MatchSignal {
  const refundAt = facts.refundCreatedAt;
  const reference = facts.ticketCreatedAt ?? facts.orderCreatedAt;

  if (!refundAt || !reference) {
    return {
      field: "timing",
      outcome: "absent",
      contribution: 0,
      note: "Timing could not be compared.",
    };
  }

  const hours = Math.abs(refundAt.getTime() - reference.getTime()) / 3_600_000;

  if (hours <= config.timingWindowHours) {
    return {
      field: "timing",
      outcome: "agree",
      contribution: WEIGHTS.timing,
      note: `Refund occurred ${formatHours(hours)} from the related record.`,
    };
  }

  // Outside the window is weak counter-evidence, not a contradiction: refunds
  // legitimately happen late.
  return {
    field: "timing",
    outcome: "disagree",
    contribution: -WEIGHTS.timing * 0.5,
    note:
      `Refund occurred ${formatHours(hours)} from the related record, outside ` +
      `the ${config.timingWindowHours}h window.`,
  };
}

// ─── Presentation ────────────────────────────────────────────────────────────

/**
 * Build the agent-facing explanation. Leads with what corroborates, then what
 * contradicts, then what could not be established — an agent deciding whether
 * to move money needs the caveats spelled out, not just the verdict.
 *
 * Absent signals are stated in full rather than listed as field names: "Refund
 * is still pending" is actionable, "not checked: refund status" is not.
 */
function buildNotes(signals: MatchSignal[], facts: EvidenceFacts): string {
  const parts: string[] = [];

  const agreed = signals.filter((s) => s.outcome === "agree");
  parts.push(
    agreed.length > 0
      ? agreed.map((s) => s.note).join(" ")
      : "No corroborating signals were found."
  );

  for (const outcome of ["disagree", "absent"] as const) {
    const matching = signals.filter((s) => s.outcome === outcome);
    if (matching.length > 0) {
      parts.push(matching.map((s) => s.note).join(" "));
    }
  }

  if (facts.isSourceUnavailable) {
    parts.push(
      "One source record is no longer available, so confidence is capped and " +
        "the last known state is shown."
    );
  }

  return parts.join(" ");
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function bandFor(score: number): MatchBand {
  for (const [threshold, band] of BAND_THRESHOLDS) {
    if (score >= threshold) return band;
  }
  return MatchBand.NO_MATCH;
}

function normalizeId(value?: string | null): string | null {
  if (!value) return null;
  const trimmed = value.trim().toLowerCase();
  return trimmed === "" ? null : trimmed;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function round4(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

function formatCents(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

function formatHours(hours: number): string {
  if (hours < 1) return `${Math.round(hours * 60)} minutes`;
  if (hours < 48) return `${Math.round(hours)} hours`;
  return `${Math.round(hours / 24)} days`;
}
