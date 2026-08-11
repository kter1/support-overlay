/**
 * Turning a message body plus a list of spans into renderable segments.
 *
 * Kept separate from the component and free of React so the hard part — the
 * arithmetic — can be tested directly. Every bug in this file shows up as text
 * marked in the wrong place, which the panel would present with exactly as
 * much confidence as a correct one.
 */

export interface CandidateRecord {
  provider: string;
  recordType: string;
  reference: string;
  status: string | null;
  amountCents: number | null;
  currency: string | null;
  occurredAt: string | null;
  description: string | null;
}

export interface Span {
  start: number;
  end: number;
  kind: string;
  display: string;
  confidence: number;
  authorRole: string;
  excerpt: string;
  rule: string;
  /** The identifier as written, for references. Null for other kinds. */
  reference: string | null;
  /** Every record this span could mean. Empty when nothing matched. */
  candidates: CandidateRecord[];
  /** How the match was made: identifier, date, amount, merchant. */
  matchedOn: string | null;
}

export type Segment =
  | { marked: false; text: string }
  | { marked: true; text: string; span: Span };

/**
 * How much a span deserves the text when two overlap.
 *
 * Identifiers already claim their ranges inside the identifier extractor, but
 * money, dates and asks are found independently and can collide — "$49.99 on
 * 2026-01-15" is two rules reading one phrase. The more specific signal wins,
 * then the more confident one.
 */
const KIND_PRIORITY: Record<string, number> = {
  payment_reference: 5,
  order_reference: 4,
  money: 3,
  date: 2,
  ask: 1,
};

function priority(span: Span): number {
  return (KIND_PRIORITY[span.kind] ?? 0) * 100 + Math.round(span.confidence * 10);
}

/**
 * Drop spans that overlap one already kept.
 *
 * Overlapping marks cannot be rendered as flat segments, and nesting them
 * would produce a highlight inside a highlight that means nothing to a reader.
 * Losing the weaker of two readings of the same phrase is the right trade.
 */
export function resolveOverlaps(spans: Span[]): Span[] {
  const ordered = [...spans].sort((a, b) => priority(b) - priority(a));
  const kept: Span[] = [];

  for (const span of ordered) {
    if (span.end <= span.start) continue;
    const clashes = kept.some((k) => span.start < k.end && span.end > k.start);
    if (!clashes) kept.push(span);
  }

  return kept.sort((a, b) => a.start - b.start);
}

/**
 * Split a body into alternating plain and marked segments.
 *
 * Out-of-range spans are skipped rather than clamped: a span pointing past the
 * end of its message means the offsets no longer describe this text, and
 * marking *something* nearby would be a guess presented as a fact.
 */
export function toSegments(body: string, spans: Span[]): Segment[] {
  const segments: Segment[] = [];
  let cursor = 0;

  for (const span of resolveOverlaps(spans)) {
    if (span.start < cursor || span.end > body.length) continue;

    if (span.start > cursor) {
      segments.push({ marked: false, text: body.slice(cursor, span.start) });
    }

    segments.push({ marked: true, text: body.slice(span.start, span.end), span });
    cursor = span.end;
  }

  if (cursor < body.length) {
    segments.push({ marked: false, text: body.slice(cursor) });
  }

  return segments;
}
