/**
 * Conversation extraction.
 *
 * Weighted toward precision. A missed signal costs the agent a scroll; a wrong
 * one links a ticket to somebody else's order, or shows an amount the customer
 * never said next to a refund button. Several tests below exist only to assert
 * that plausible-looking text is *not* extracted.
 */
import { describe, it, expect } from "vitest";
import { readConversation, extractFromSource, TextSource } from "./index";

const T0 = new Date("2026-03-10T12:00:00Z");

function source(
  text: string,
  overrides: Partial<TextSource> = {}
): TextSource {
  return {
    id: overrides.id ?? "c1",
    kind: overrides.kind ?? "comment",
    authorRole: overrides.authorRole ?? "customer",
    createdAt: overrides.createdAt ?? T0,
    text,
  };
}

describe("money", () => {
  it("reads common formats", () => {
    const cases: Array<[string, number, string | null]> = [
      ["I paid $49.99 for this", 4999, "USD"],
      ["charged £30 twice", 3000, "GBP"],
      ["the total was 1,234.56 USD", 123456, "USD"],
      ["USD 15.00 please", 1500, "USD"],
      ["refund of 25 dollars", 2500, "USD"],
    ];

    for (const [text, cents, currency] of cases) {
      const [signal] = extractFromSource(source(text)).filter((s) => s.kind === "money");
      expect(signal, text).toBeDefined();
      expect(signal.value, text).toMatchObject({ amountCents: cents, currency });
    }
  });

  it("handles European decimal commas without inflating the amount", () => {
    const [signal] = extractFromSource(source("kostet €25,50")).filter(
      (s) => s.kind === "money"
    );
    expect(signal.value).toMatchObject({ amountCents: 2550, currency: "EUR" });
  });

  it("treats a comma group as thousands, not decimals", () => {
    const [signal] = extractFromSource(source("$1,200 refund")).filter(
      (s) => s.kind === "money"
    );
    expect(signal.value.amountCents).toBe(120000);
  });

  it("does not multiply zero-decimal currencies by 100", () => {
    // ¥500 is 500 minor units, not 50000. Getting this wrong is a 100x refund.
    const [signal] = extractFromSource(source("paid ¥500")).filter(
      (s) => s.kind === "money"
    );
    expect(signal.value.amountCents).toBe(500);
  });

  it("ignores decimals that are not money", () => {
    const text = "I'm on app version 2.50 and my tracking says 12.30 kg";
    const money = extractFromSource(source(text)).filter((s) => s.kind === "money");
    expect(money).toHaveLength(0);
  });

  it("accepts a bare decimal when the surrounding words make it monetary", () => {
    const [signal] = extractFromSource(
      source("the charge was 49.99 on my statement")
    ).filter((s) => s.kind === "money");
    expect(signal.value.amountCents).toBe(4999);
    // Lower confidence than a symbol-led match — no currency marker.
    expect(signal.confidence).toBeLessThan(0.8);
  });

  it("records where the amount came from", () => {
    const text = "Hello, I paid $49.99 last week";
    const [signal] = extractFromSource(source(text, { id: "comment-7" })).filter(
      (s) => s.kind === "money"
    );

    expect(signal.provenance.sourceId).toBe("comment-7");
    expect(text.slice(signal.provenance.start, signal.provenance.end)).toBe("$49.99");
    expect(signal.provenance.rule).toBe("symbol_prefixed");
  });
});

describe("identifiers", () => {
  it("recognises Stripe object ids with near-certainty", () => {
    const [signal] = extractFromSource(
      source("the charge is ch_3AbCdEfGhIjKlMnO")
    ).filter((s) => s.kind === "payment_reference");

    expect(signal.value).toMatchObject({ provider: "stripe", recordType: "charge" });
    expect(signal.confidence).toBeGreaterThan(0.95);
  });

  it("reads labelled order numbers", () => {
    for (const text of ["order #1001", "order number 1001", "Order no. 1001"]) {
      const [signal] = extractFromSource(source(text)).filter(
        (s) => s.kind === "order_reference"
      );
      expect(signal, text).toBeDefined();
      expect(signal.value.id, text).toBe("1001");
    }
  });

  it("scores a bare #1001 lower than a labelled one", () => {
    const [bare] = extractFromSource(source("about #1001")).filter(
      (s) => s.kind === "order_reference"
    );
    const [labelled] = extractFromSource(source("about order 1001")).filter(
      (s) => s.kind === "order_reference"
    );

    // "#1001" could be an order, an invoice, or another ticket.
    expect(bare.confidence).toBeLessThan(labelled.confidence);
  });

  it("does not read a ticket reference as an order", () => {
    const signals = extractFromSource(
      source("see ticket #4402 for background", { authorRole: "agent" })
    ).filter((s) => s.kind === "order_reference");

    expect(signals).toHaveLength(0);
  });
});

describe("dates", () => {
  it("reads absolute dates", () => {
    const [signal] = extractFromSource(source("ordered on 2026-01-15")).filter(
      (s) => s.kind === "date"
    );
    expect(signal.value.date.toISOString().slice(0, 10)).toBe("2026-01-15");
  });

  it("reads month names in both orders", () => {
    for (const text of ["January 15, 2026", "15 January 2026"]) {
      const [signal] = extractFromSource(source(text)).filter((s) => s.kind === "date");
      expect(signal.value.date.toISOString().slice(0, 10), text).toBe("2026-01-15");
    }
  });

  it("resolves a bare month/day to the most recent past occurrence", () => {
    // Customers write about purchases already made, so a future reading is wrong.
    const [signal] = extractFromSource(source("ordered Dec 20")).filter(
      (s) => s.kind === "date"
    );
    expect(signal.value.date.toISOString().slice(0, 10)).toBe("2025-12-20");
  });

  it("resolves relative dates against the message, not against now", () => {
    const [signal] = extractFromSource(source("it arrived yesterday")).filter(
      (s) => s.kind === "date"
    );

    expect(signal.value.date.toISOString().slice(0, 10)).toBe("2026-03-09");
    expect(signal.value.wasRelative).toBe(true);
  });

  it("flags ambiguous slash dates with low confidence instead of guessing quietly", () => {
    const [ambiguous] = extractFromSource(source("on 03/04/2026")).filter(
      (s) => s.kind === "date"
    );
    const [unambiguous] = extractFromSource(source("on 25/04/2026")).filter(
      (s) => s.kind === "date"
    );

    expect(ambiguous.confidence).toBeLessThan(0.6);
    expect(unambiguous.confidence).toBeGreaterThan(0.9);
    expect(unambiguous.value.date.toISOString().slice(0, 10)).toBe("2026-04-25");
  });
});

describe("asks", () => {
  it("classifies a refund request", () => {
    const [signal] = extractFromSource(
      source("I'd like a refund please, can you send my money back")
    ).filter((s) => s.kind === "ask");

    expect(signal.value.ask).toBe("refund_request");
    expect(signal.value.cues.length).toBeGreaterThan(1);
  });

  it("distinguishes a billing dispute from a plain refund", () => {
    const asks = extractFromSource(
      source("I was double-charged for this order")
    ).filter((s) => s.kind === "ask");

    expect(asks.map((a) => a.value.ask)).toContain("billing_dispute");
  });

  it("does not classify agent text as the customer's ask", () => {
    // "We cannot refund this" would otherwise register as a refund request.
    const asks = extractFromSource(
      source("We cannot refund this order under policy", { authorRole: "agent" })
    ).filter((s) => s.kind === "ask");

    expect(asks).toHaveLength(0);
  });

  it("carries the cue text so an agent can see what triggered it", () => {
    const [signal] = extractFromSource(source("where is my order?")).filter(
      (s) => s.kind === "ask"
    );
    expect(signal.value.cues.join(" ").toLowerCase()).toContain("where is my order");
  });
});

describe("readConversation", () => {
  const thread: TextSource[] = [
    source("Refund for order #1001", {
      id: "subject",
      kind: "ticket_subject",
      createdAt: new Date("2026-03-10T09:00:00Z"),
    }),
    source("I was charged $49.99 on 2026-03-08 but never got the package.", {
      id: "c1",
      createdAt: new Date("2026-03-10T09:01:00Z"),
    }),
    source("Checking on this now.", {
      id: "c2",
      authorRole: "agent",
      createdAt: new Date("2026-03-10T09:30:00Z"),
    }),
    source("Sorry, correction — the charge was $59.99, ref ch_3AbCdEfGhIjKlMnO", {
      id: "c3",
      createdAt: new Date("2026-03-10T10:00:00Z"),
    }),
  ];

  it("picks the exact payment reference as the lead", () => {
    const context = readConversation(thread);
    // A charge id resolves which transaction; an order number needs a lookup.
    expect(context.leads.paymentReference).toBe("ch_3AbCdEfGhIjKlMnO");
    expect(context.leads.orderReference).toBe("1001");
  });

  it("prefers the customer's later correction over the earlier amount", () => {
    const context = readConversation(thread);
    expect(context.leads.claimedAmountCents).toBe(5999);
  });

  it("identifies the ask", () => {
    const context = readConversation(thread);
    expect(context.leads.primaryAsk?.value.ask).toBe("refund_request");
  });

  it("surfaces a short, deduplicated set of highlights", () => {
    const repetitive = [
      source("refund $20 please", { id: "a", createdAt: new Date("2026-03-10T09:00:00Z") }),
      source("again, $20", { id: "b", createdAt: new Date("2026-03-10T09:05:00Z") }),
      source("still waiting on my $20", { id: "c", createdAt: new Date("2026-03-10T09:10:00Z") }),
    ];

    const context = readConversation(repetitive);
    const amounts = context.highlights.filter((s) => s.kind === "money");

    // One fact restated three times is one highlight.
    expect(amounts).toHaveLength(1);
    expect(context.highlights.length).toBeLessThanOrEqual(6);
  });

  it("is reproducible", () => {
    // Same conversation, same answer — the audit trail depends on it.
    const a = readConversation(thread);
    const b = readConversation(thread);
    expect(JSON.stringify(a.leads)).toBe(JSON.stringify(b.leads));
  });

  it("returns empty leads for a conversation with nothing in it", () => {
    const context = readConversation([source("hello, is anyone there?")]);

    expect(context.leads.paymentReference).toBeNull();
    expect(context.leads.claimedAmountCents).toBeNull();
    expect(context.highlights).toHaveLength(0);
  });

  it("does not infer anything about the customer, only about the request", () => {
    const context = readConversation([
      source("This is absolutely unacceptable, I am furious and will never shop here again. Refund me."),
    ]);

    const kinds = new Set(context.signals.map((s) => s.kind));
    // No sentiment, no churn risk, no rating of the person.
    expect([...kinds].every((k) =>
      ["money", "date", "order_reference", "payment_reference", "ask"].includes(k)
    )).toBe(true);
  });
});
