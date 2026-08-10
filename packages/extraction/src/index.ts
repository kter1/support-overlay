/**
 * @iisl/extraction — conversation context
 *
 * Reads a ticket thread and pulls out the points of importance an agent would
 * otherwise reconstruct by scrolling: what was paid, when, which order, and
 * what the customer is actually asking for.
 *
 * Deterministic by design. This text is written by the customer and it feeds a
 * path that moves money — routing it through a language model would put an
 * injection surface on the refund button, and would make the same conversation
 * yield different answers on different days. Every signal here is reproducible
 * and carries the span of text it came from.
 */
import { extractMoney, formatMoney } from "./money";
import { extractIdentifiers } from "./identifiers";
import { extractDates } from "./temporal";
import { extractAsks } from "./asks";
import {
  AnySignal,
  AskSignal,
  DateSignal,
  ExtractionOptions,
  MoneySignal,
  OrderSignal,
  PaymentSignal,
  TextSource,
} from "./types";

export * from "./types";
export { formatMoney };

export const EXTRACTOR_VERSION = "extract_v1";

/** Everything pulled from one conversation, ranked. */
export interface ConversationContext {
  signals: AnySignal[];
  money: MoneySignal[];
  dates: DateSignal[];
  orders: OrderSignal[];
  payments: PaymentSignal[];
  asks: AskSignal[];
  /** The handful of signals worth showing on the card, most important first. */
  highlights: AnySignal[];
  /** Best single candidate for each thing the ingestion pipeline needs. */
  leads: {
    orderReference: string | null;
    paymentReference: string | null;
    claimedAmountCents: number | null;
    claimedCurrency: string | null;
    purchaseDate: Date | null;
    primaryAsk: AskSignal | null;
  };
  extractorVersion: string;
}

/** Run every extractor over one piece of text. */
export function extractFromSource(
  source: TextSource,
  options: ExtractionOptions = {}
): AnySignal[] {
  return [
    ...extractMoney(source, options),
    ...extractIdentifiers(source),
    ...extractDates(source, options),
    ...extractAsks(source),
  ];
}

/**
 * Read a whole conversation.
 *
 * Sources should be in chronological order; the ranking uses position to
 * prefer later corrections over earlier guesses.
 */
export function readConversation(
  sources: TextSource[],
  options: ExtractionOptions = {}
): ConversationContext {
  const ordered = [...sources].sort(
    (a, b) => a.createdAt.getTime() - b.createdAt.getTime()
  );

  const signals = ordered.flatMap((source) => extractFromSource(source, options));

  const money = signals.filter(isMoney);
  const dates = signals.filter(isDate);
  const orders = signals.filter(isOrder);
  const payments = signals.filter(isPayment);
  const asks = signals.filter(isAsk);

  const ranked = [...signals].sort((a, b) => salience(b, ordered) - salience(a, ordered));

  return {
    signals,
    money,
    dates,
    orders,
    payments,
    asks,
    highlights: dedupeForDisplay(ranked).slice(0, 6),
    leads: {
      // A payment id is exact; an order number needs a lookup. Prefer the exact
      // one, but keep both — the ingestion pipeline tries them in order.
      paymentReference: best(payments, ordered)?.value.id ?? null,
      orderReference: best(orders, ordered)?.value.id ?? null,
      claimedAmountCents: best(money, ordered)?.value.amountCents ?? null,
      claimedCurrency: best(money, ordered)?.value.currency ?? null,
      purchaseDate: best(dates, ordered)?.value.date ?? null,
      primaryAsk: best(asks, ordered) ?? null,
    },
    extractorVersion: EXTRACTOR_VERSION,
  };
}

/**
 * How much this signal should influence what the agent sees.
 *
 * Three things drive it. Confidence, because an ambiguous match should not lead.
 * Kind, because an identifier resolves *which* transaction and an amount only
 * describes one. And recency, because a customer who corrects themselves in a
 * later message means the later message.
 */
function salience(signal: AnySignal, sources: TextSource[]): number {
  const KIND_WEIGHT: Record<AnySignal["kind"], number> = {
    payment_reference: 1.0,
    order_reference: 0.92,
    ask: 0.8,
    money: 0.75,
    date: 0.55,
  };

  const position = sources.findIndex((s) => s.id === signal.provenance.sourceId);
  const recency = sources.length > 1 ? position / (sources.length - 1) : 1;

  // Customer statements are the claim under consideration; agent notes are
  // usually restatement, and should not outrank the original.
  const roleWeight = signal.authorRole === "customer" ? 1 : 0.85;

  return (
    KIND_WEIGHT[signal.kind] * 0.55 +
    signal.confidence * 0.3 +
    recency * 0.1 +
    roleWeight * 0.05
  );
}

/** Highest-salience signal of a given kind. */
function best<T extends AnySignal>(candidates: T[], sources: TextSource[]): T | null {
  if (candidates.length === 0) return null;
  return candidates.reduce((a, b) => (salience(a, sources) >= salience(b, sources) ? a : b));
}

/**
 * Collapse repeats for display. A customer restating "$49.99" four times is one
 * fact, and a card that lists it four times buries everything else.
 */
function dedupeForDisplay(ranked: AnySignal[]): AnySignal[] {
  const seen = new Set<string>();
  const out: AnySignal[] = [];

  for (const signal of ranked) {
    const key = `${signal.kind}:${signal.display}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(signal);
  }

  return out;
}

function isMoney(s: AnySignal): s is MoneySignal {
  return s.kind === "money";
}
function isDate(s: AnySignal): s is DateSignal {
  return s.kind === "date";
}
function isOrder(s: AnySignal): s is OrderSignal {
  return s.kind === "order_reference";
}
function isPayment(s: AnySignal): s is PaymentSignal {
  return s.kind === "payment_reference";
}
function isAsk(s: AnySignal): s is AskSignal {
  return s.kind === "ask";
}
