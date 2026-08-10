/**
 * @iisl/extraction — what the customer is asking for
 *
 * Deliberately narrow. This classifies the *request* — refund, status, cancel —
 * and nothing about the person making it. There is no sentiment score, no
 * frustration rating, no risk-of-churn signal, because those get shown to
 * agents and quietly change how someone is treated on grounds they cannot see
 * or contest. The policy engine has the same constraint on its denial copy.
 *
 * Cue phrases are recorded on the signal so an agent can see what triggered a
 * classification instead of being handed a label to trust.
 */
import { AskKind, AskSignal, TextSource } from "./types";

interface AskRule {
  ask: AskKind;
  /** Phrases that indicate this ask. Matched case-insensitively. */
  cues: RegExp[];
  /** Base confidence for a single cue; multiple cues raise it. */
  confidence: number;
}

const RULES: AskRule[] = [
  {
    ask: "refund_request",
    cues: [
      /\brefund(?:ed|ing)?\b/i,
      /\bmoney back\b/i,
      /\breimburse(?:ment|d)?\b/i,
      /\bcredit (?:me|my|back)\b/i,
      /\bcharge ?back\b/i,
    ],
    confidence: 0.8,
  },
  {
    ask: "order_status",
    cues: [
      /\bwhere('?s| is)\s+my\s+(order|package|parcel|delivery)\b/i,
      /\btracking\s+(number|info|information)?\b/i,
      /\bhasn'?t\s+(arrived|shipped|been delivered)\b/i,
      /\bstill\s+waiting\b/i,
      /\bnot\s+(yet\s+)?(arrived|delivered|received)\b/i,
    ],
    confidence: 0.78,
  },
  {
    ask: "cancellation",
    cues: [
      /\bcancel(?:l?ed|l?ing|lation)?\s+(?:my\s+)?(order|subscription|plan|membership)\b/i,
      /\bstop\s+(?:my\s+)?(subscription|billing|charges?)\b/i,
      /\bdon'?t\s+(?:want|need)\s+(?:it|this|the order)\b/i,
    ],
    confidence: 0.8,
  },
  {
    ask: "return_request",
    cues: [
      /\breturn(?:ing)?\s+(?:the|my|this)\s+(item|order|product|package)\b/i,
      /\bsend\s+it\s+back\b/i,
      /\breturn\s+label\b/i,
      /\bexchange\s+(?:it|this|the)\b/i,
    ],
    confidence: 0.8,
  },
  {
    ask: "damaged_or_wrong_item",
    cues: [
      /\b(damaged|broken|cracked|defective|faulty)\b/i,
      /\bwrong\s+(item|size|colou?r|product)\b/i,
      /\bnot\s+what\s+I\s+ordered\b/i,
      /\bmissing\s+(item|part|piece)s?\b/i,
    ],
    confidence: 0.75,
  },
  {
    ask: "billing_dispute",
    cues: [
      /\bcharged\s+(twice|two times|multiple times|again)\b/i,
      /\bdouble[- ]?charged?\b/i,
      /\bdidn'?t\s+authorize\b/i,
      /\bunauthorized\s+charge\b/i,
      /\bcharged\s+(?:the\s+)?wrong\s+amount\b/i,
    ],
    confidence: 0.88,
  },
];

export function extractAsks(source: TextSource): AskSignal[] {
  // Agent and system text restates the customer's ask; classifying it would
  // double-count and can invert meaning ("we cannot refund this").
  if (source.authorRole !== "customer") return [];

  const signals: AskSignal[] = [];

  for (const rule of RULES) {
    const hits: Array<{ cue: string; start: number; end: number }> = [];

    for (const cue of rule.cues) {
      const regex = new RegExp(cue.source, cue.flags.includes("g") ? cue.flags : `${cue.flags}g`);
      let match: RegExpExecArray | null;
      while ((match = regex.exec(source.text)) !== null) {
        hits.push({ cue: match[0], start: match.index, end: match.index + match[0].length });
        if (match[0].length === 0) regex.lastIndex++;
      }
    }

    if (hits.length === 0) continue;

    // Corroborating cues raise confidence, with a ceiling — three ways of
    // saying "refund" is stronger evidence than one, but never certainty.
    const confidence = Math.min(0.96, rule.confidence + (hits.length - 1) * 0.05);
    const first = hits.reduce((a, b) => (a.start <= b.start ? a : b));

    signals.push({
      kind: "ask",
      value: { ask: rule.ask, cues: [...new Set(hits.map((h) => h.cue))] },
      display: ASK_LABELS[rule.ask],
      confidence,
      authorRole: source.authorRole,
      observedAt: source.createdAt,
      provenance: {
        sourceId: source.id,
        sourceKind: source.kind,
        start: first.start,
        end: first.end,
        excerpt: first.cue,
        rule: `ask_${rule.ask}`,
      },
    });
  }

  return signals.sort((a, b) => b.confidence - a.confidence);
}

const ASK_LABELS: Record<AskKind, string> = {
  refund_request: "Refund requested",
  order_status: "Asking where the order is",
  cancellation: "Cancellation requested",
  return_request: "Return requested",
  damaged_or_wrong_item: "Damaged or wrong item reported",
  billing_dispute: "Billing dispute raised",
};
