/**
 * @iisl/extraction — types
 *
 * Every extracted signal carries provenance: which piece of text it came from,
 * the exact character span, and which rule matched. Nothing in this package
 * produces a fact you cannot trace back to a sentence a human wrote.
 *
 * That is not decoration. Downstream, these signals inform whether money moves.
 * An agent asked to approve a refund needs to see "customer stated $49.99, in
 * their second reply" rather than a bare number, and an auditor reconstructing
 * the decision six months later needs the same.
 */

/** A single piece of text from a conversation. */
export interface TextSource {
  /** Stable id — Zendesk comment id, or a synthetic id for ticket fields. */
  id: string;
  kind: "ticket_subject" | "ticket_description" | "comment" | "custom_field";
  /**
   * Who wrote it. Customer text is a *claim*; agent and system text is
   * *record*. The distinction matters when the two disagree.
   */
  authorRole: "customer" | "agent" | "system";
  createdAt: Date;
  text: string;
}

/** Exactly where a signal came from. */
export interface Provenance {
  sourceId: string;
  sourceKind: TextSource["kind"];
  /** Character offsets into that source's text. */
  start: number;
  end: number;
  /** The literal matched substring. */
  excerpt: string;
  /** Rule identifier, so a match can be explained and regression-tested. */
  rule: string;
}

export type SignalKind =
  | "money"
  | "date"
  | "order_reference"
  | "payment_reference"
  | "ask";

/** Base shape shared by everything the extractors emit. */
export interface Signal<K extends SignalKind = SignalKind, V = unknown> {
  kind: K;
  value: V;
  /** Normalized, human-readable form for display on the card. */
  display: string;
  /**
   * 0–1. Reflects how unambiguous the *match* was, not how true the claim is.
   * A confidently-extracted amount can still be a customer misremembering.
   */
  confidence: number;
  provenance: Provenance;
  authorRole: TextSource["authorRole"];
  observedAt: Date;
}

export interface MoneyValue {
  amountCents: number;
  /** ISO 4217 where known; null when the text gave no currency marker. */
  currency: string | null;
}

export interface DateValue {
  /** Resolved instant. Relative expressions resolve against a reference date. */
  date: Date;
  /** How precisely the text pinned it down. */
  granularity: "day" | "month" | "year";
  /** True for "yesterday", "last week" — resolved, but softer evidence. */
  wasRelative: boolean;
}

export interface ReferenceValue {
  /** Normalized identifier, e.g. "1001" or "ch_3AbC…". */
  id: string;
  /** Which provider this looks like, when the format is distinctive. */
  provider: "stripe" | "shopify" | "unknown";
  /** What kind of record: order, charge, refund, payment intent. */
  recordType: "order" | "charge" | "refund" | "payment_intent" | "unknown";
}

/** What the customer is asking for. */
export type AskKind =
  | "refund_request"
  | "order_status"
  | "cancellation"
  | "return_request"
  | "damaged_or_wrong_item"
  | "billing_dispute";

export interface AskValue {
  ask: AskKind;
  /** Phrases that triggered it, for display and for tuning. */
  cues: string[];
}

export type MoneySignal = Signal<"money", MoneyValue>;
export type DateSignal = Signal<"date", DateValue>;
export type OrderSignal = Signal<"order_reference", ReferenceValue>;
export type PaymentSignal = Signal<"payment_reference", ReferenceValue>;
export type AskSignal = Signal<"ask", AskValue>;

export type AnySignal =
  | MoneySignal
  | DateSignal
  | OrderSignal
  | PaymentSignal
  | AskSignal;

export interface ExtractionOptions {
  /** Anchor for relative dates. Defaults to the source's own timestamp. */
  referenceDate?: Date;
  /** Fallback when text gives an amount with no currency marker. */
  defaultCurrency?: string;
}
