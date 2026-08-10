/**
 * @iisl/extraction — order and payment identifiers
 *
 * These are the highest-value signals in a conversation: an identifier is the
 * only thing that establishes *which* transaction a customer is talking about.
 * The matching engine weights identifier linkage above everything else for
 * exactly that reason, so a false positive here is expensive — it would link a
 * ticket to someone else's order.
 *
 * Confidence therefore tracks how distinctive the format is. A Stripe object id
 * is unmistakable; a bare "#1001" could be an order, an invoice, or another
 * ticket, and is scored accordingly.
 */
import {
  OrderSignal,
  PaymentSignal,
  Provenance,
  ReferenceValue,
  TextSource,
} from "./types";

interface IdRule {
  id: string;
  regex: RegExp;
  confidence: number;
  /** Which capture group holds the identifier. */
  group: number;
  build: (raw: string) => ReferenceValue;
}

/**
 * Stripe object ids: a distinctive prefix plus an alphanumeric body.
 *
 * The prefix does the discriminating work, not the length, so the body bound is
 * deliberately loose. The cost asymmetry justifies it: a false positive yields
 * an id that simply does not resolve at the provider, which produces no
 * evidence and no harm. The dangerous failure would be resolving to *someone
 * else's* record, and that requires a genuine id — which a loose pattern cannot
 * conjure. A tight bound, by contrast, silently drops real references.
 */
const STRIPE_RULES: IdRule[] = [
  {
    id: "stripe_charge",
    regex: /\b(ch_[A-Za-z0-9]{3,})\b/g,
    confidence: 0.99,
    group: 1,
    build: (raw) => ({ id: raw, provider: "stripe", recordType: "charge" }),
  },
  {
    id: "stripe_refund",
    regex: /\b(re_[A-Za-z0-9]{3,})\b/g,
    confidence: 0.99,
    group: 1,
    build: (raw) => ({ id: raw, provider: "stripe", recordType: "refund" }),
  },
  {
    id: "stripe_payment_intent",
    regex: /\b(pi_[A-Za-z0-9]{3,})\b/g,
    confidence: 0.99,
    group: 1,
    build: (raw) => ({ id: raw, provider: "stripe", recordType: "payment_intent" }),
  },
];

const ORDER_RULES: IdRule[] = [
  {
    // "order #1001", "order number 1001", "order no. 1001"
    id: "order_labelled",
    regex: /\border\s*(?:#|number|no\.?|num\.?|id)?\s*[:#]?\s*(\d{3,12})\b/gi,
    confidence: 0.93,
    group: 1,
    build: (raw) => ({ id: raw, provider: "shopify", recordType: "order" }),
  },
  {
    // Shopify order names carry a store prefix: "#EU1001", "#1001"
    id: "order_hash_prefixed",
    regex: /(?:^|[\s(])#([A-Z]{0,3}\d{3,12})\b/g,
    confidence: 0.72,
    group: 1,
    build: (raw) => ({ id: raw, provider: "shopify", recordType: "order" }),
  },
  {
    // "confirmation 1001", "receipt #1001"
    id: "order_synonym",
    regex: /\b(?:confirmation|receipt|invoice)\s*(?:#|number|no\.?)?\s*[:#]?\s*(\d{3,12})\b/gi,
    confidence: 0.8,
    group: 1,
    build: (raw) => ({ id: raw, provider: "unknown", recordType: "order" }),
  },
];

/**
 * Contexts where a "#1234" is talking about something other than an order.
 * Zendesk agents reference tickets this way constantly.
 */
const NON_ORDER_CONTEXT = /\b(ticket|case|thread|conversation|ref|reference)\s*$/i;

export function extractIdentifiers(source: TextSource): Array<OrderSignal | PaymentSignal> {
  const claimed: Array<[number, number]> = [];
  const signals: Array<OrderSignal | PaymentSignal> = [];

  // Payment identifiers first: they are unambiguous and should own their spans.
  for (const rule of [...STRIPE_RULES, ...ORDER_RULES]) {
    rule.regex.lastIndex = 0;
    let match: RegExpExecArray | null;

    while ((match = rule.regex.exec(source.text)) !== null) {
      const captured = match[rule.group];
      if (!captured) continue;

      const start = match.index + match[0].indexOf(captured);
      const end = start + captured.length;

      if (claimed.some(([s, e]) => start < e && end > s)) continue;

      if (rule.id === "order_hash_prefixed") {
        const preceding = source.text.slice(Math.max(0, match.index - 24), match.index);
        if (NON_ORDER_CONTEXT.test(preceding.trimEnd())) continue;
      }

      const value = rule.build(captured);
      claimed.push([start, end]);

      const provenance: Provenance = {
        sourceId: source.id,
        sourceKind: source.kind,
        start,
        end,
        excerpt: match[0].trim(),
        rule: rule.id,
      };

      const isPayment = value.provider === "stripe";

      signals.push({
        kind: isPayment ? "payment_reference" : "order_reference",
        value,
        display: isPayment ? value.id : `#${value.id}`,
        confidence: rule.confidence,
        authorRole: source.authorRole,
        observedAt: source.createdAt,
        provenance,
      } as OrderSignal | PaymentSignal);
    }
  }

  return signals.sort((a, b) => a.provenance.start - b.provenance.start);
}
