/**
 * @support-overlay/api — resolving a span to a record
 *
 * Every other lookup in this system is phrased as an identifier: `getOrder(id)`,
 * `getCharge(id)`. Customers do not write identifiers. They write "on 8/1", "the
 * $39", "from McDonalds" — and until this existed, hovering any of those could
 * only restate the sentence it came from, because nothing could answer a
 * question posed as a value.
 *
 * So: read the customer's recent orders and charges once, then match each
 * extracted span against that set.
 *
 * Two rules shape the matching, both about not being confidently wrong.
 *
 * A span that matches several records returns *all* of them. Picking one and
 * presenting it as the answer is the same class of mistake as the duplicate
 * refund this product exists to prevent: a plausible single answer is exactly
 * what stops an agent looking further.
 *
 * A date whose year the customer never wrote is settled by the records, not by
 * arithmetic on the message date. "8/1" in a January ticket means last August,
 * and the order history knows that while a calendar does not.
 */
import { ShopifyAdapter, StripeAdapter, ShopifyOrder, StripeCharge } from "@iisl/connectors";
import { AnySignal } from "@iisl/extraction";

/** What one customer has bought and been charged, as far as we can see. */
export interface CustomerCorpus {
  orders: ShopifyOrder[];
  charges: StripeCharge[];
  /** Merchant names seen in this customer's history, for the extractor. */
  merchants: string[];
}

export const EMPTY_CORPUS: CustomerCorpus = { orders: [], charges: [], merchants: [] };

/** One record a span could be referring to. */
export interface CandidateRecord {
  provider: "stripe" | "shopify";
  recordType: string;
  reference: string;
  status: string | null;
  amountCents: number | null;
  currency: string | null;
  occurredAt: string | null;
  description: string | null;
}

export interface SpanResolution {
  /** Everything the span could mean. Empty when nothing matched. */
  candidates: CandidateRecord[];
  /** How the match was made, so the panel can say why. */
  matchedOn: "identifier" | "date" | "amount" | "merchant" | null;
  /**
   * For a date whose year was never written: the year the records settled on.
   * Null when nothing settled it and the inferred year still stands.
   */
  resolvedYear: number | null;
}

const NO_MATCH: SpanResolution = { candidates: [], matchedOn: null, resolvedYear: null };

/**
 * Read a customer's recent history.
 *
 * Never throws: a corpus is a best-effort read that buys annotations, and
 * losing the card over it would be a bad trade. Both adapters already return
 * empty rather than throwing, so this mostly guards against a missing customer.
 */
export async function loadCustomerCorpus(
  customerId: string | null,
  shop: string
): Promise<CustomerCorpus> {
  // An anonymous ticket must not search every order in the store. Without a
  // customer there is nothing to scope to, and an unscoped search would show
  // one person's purchases against another's message.
  if (!customerId || customerId.trim() === "") return EMPTY_CORPUS;

  const [orders, charges] = await Promise.all([
    new ShopifyAdapter().listOrdersForCustomer(customerId, shop),
    new StripeAdapter().listChargesForCustomer(customerId),
  ]);

  const merchants = new Set<string>();
  for (const order of orders) {
    for (const item of order.line_items ?? []) {
      if (item.title) merchants.add(item.title);
    }
  }
  for (const charge of charges) {
    if (charge.description) merchants.add(charge.description);
  }

  return { orders, charges, merchants: [...merchants] };
}

// ─── Matching ─────────────────────────────────────────────────────────────────

function orderToCandidate(order: ShopifyOrder): CandidateRecord {
  return {
    provider: "shopify",
    recordType: "order",
    reference: order.name ?? order.id,
    status: order.financial_status ?? null,
    amountCents: toCents(order.total_price),
    currency: order.currency ?? null,
    occurredAt: order.created_at ?? null,
    description: order.line_items?.[0]?.title ?? null,
  };
}

function chargeToCandidate(charge: StripeCharge): CandidateRecord {
  return {
    provider: "stripe",
    recordType: "charge",
    reference: charge.id,
    status: charge.refunded ? "refunded" : charge.status,
    amountCents: charge.amount,
    currency: charge.currency ?? null,
    occurredAt: new Date(charge.created * 1000).toISOString(),
    description: charge.description ?? null,
  };
}

function toCents(value: unknown): number | null {
  const amount = typeof value === "string" ? Number.parseFloat(value) : NaN;
  return Number.isFinite(amount) ? Math.round(amount * 100) : null;
}

function sameDayUtc(a: Date, b: Date): boolean {
  return (
    a.getUTCFullYear() === b.getUTCFullYear() &&
    a.getUTCMonth() === b.getUTCMonth() &&
    a.getUTCDate() === b.getUTCDate()
  );
}

/**
 * Match a date span.
 *
 * When the customer wrote a year, only that day counts. When they did not, any
 * year is allowed to match on month and day — which is what lets "8/1" in a
 * January ticket find last August's order instead of a date that has not
 * happened yet.
 */
function resolveDate(signal: AnySignal, corpus: CustomerCorpus): SpanResolution {
  const value = signal.value as { date: Date; yearWritten: boolean };
  const target = new Date(value.date);
  if (Number.isNaN(target.getTime())) return NO_MATCH;

  const matches = (when: string | null): boolean => {
    if (!when) return false;
    const at = new Date(when);
    if (Number.isNaN(at.getTime())) return false;

    if (value.yearWritten) return sameDayUtc(at, target);
    return (
      at.getUTCMonth() === target.getUTCMonth() &&
      at.getUTCDate() === target.getUTCDate()
    );
  };

  const candidates = [
    ...corpus.orders.filter((o) => matches(o.created_at)).map(orderToCandidate),
    ...corpus.charges
      .filter((c) => matches(new Date(c.created * 1000).toISOString()))
      .map(chargeToCandidate),
  ];

  if (candidates.length === 0) return NO_MATCH;

  // A year the customer never wrote is settled by the records — but only when
  // they agree. Two purchases on the same day in different years leave it open,
  // and saying so is better than picking.
  let resolvedYear: number | null = null;
  if (!value.yearWritten) {
    const years = new Set(
      candidates
        .map((c) => (c.occurredAt ? new Date(c.occurredAt).getUTCFullYear() : null))
        .filter((y): y is number => y !== null)
    );
    if (years.size === 1) resolvedYear = [...years][0];
  }

  return { candidates, matchedOn: "date", resolvedYear };
}

/** Match an amount span against charges, then order totals. */
function resolveMoney(signal: AnySignal, corpus: CustomerCorpus): SpanResolution {
  const value = signal.value as { amountCents: number };
  if (typeof value.amountCents !== "number") return NO_MATCH;

  const candidates = [
    ...corpus.charges.filter((c) => c.amount === value.amountCents).map(chargeToCandidate),
    ...corpus.orders
      .filter((o) => toCents(o.total_price) === value.amountCents)
      .map(orderToCandidate),
  ];

  return candidates.length > 0
    ? { candidates, matchedOn: "amount", resolvedYear: null }
    : NO_MATCH;
}

/** Match an identifier span — the case that already worked. */
function resolveIdentifier(
  signal: AnySignal,
  corpus: CustomerCorpus,
  explicit: Map<string, CandidateRecord>
): SpanResolution {
  const reference = (signal.value as { id: string }).id;
  if (!reference) return NO_MATCH;

  const direct = explicit.get(reference);
  if (direct) {
    return { candidates: [direct], matchedOn: "identifier", resolvedYear: null };
  }

  const bare = reference.replace(/^#/, "");
  const candidates = [
    ...corpus.orders
      .filter((o) => o.id === reference || (o.name ?? "").replace(/^#/, "") === bare)
      .map(orderToCandidate),
    ...corpus.charges.filter((c) => c.id === reference).map(chargeToCandidate),
  ];

  return candidates.length > 0
    ? { candidates, matchedOn: "identifier", resolvedYear: null }
    : NO_MATCH;
}

/**
 * Resolve one span against the customer's history.
 *
 * `explicit` carries records fetched by id from the text itself — a charge the
 * customer named may be older than the corpus window, so it is looked up
 * directly and takes precedence.
 */
export function resolveSpan(
  signal: AnySignal,
  corpus: CustomerCorpus,
  explicit: Map<string, CandidateRecord>
): SpanResolution {
  switch (signal.kind) {
    case "order_reference":
    case "payment_reference":
      return resolveIdentifier(signal, corpus, explicit);
    case "date":
      return resolveDate(signal, corpus);
    case "money":
      return resolveMoney(signal, corpus);
    default:
      // Asks carry no value to look up. They are summarised above the message
      // rather than marked inside it, precisely because hovering one could only
      // repeat the sentence.
      return NO_MATCH;
  }
}
