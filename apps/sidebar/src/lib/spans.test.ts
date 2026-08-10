/**
 * Span arithmetic.
 *
 * A wrong offset here marks the wrong words, and the panel presents that with
 * the same authority as a correct mark — so the failure is not a visual glitch,
 * it is the product asserting something false about what a customer wrote.
 */
import { describe, it, expect } from "vitest";
import { toSegments, resolveOverlaps, Span } from "./spans";

function span(start: number, end: number, over: Partial<Span> = {}): Span {
  return {
    start,
    end,
    kind: "money",
    display: "$49.99",
    confidence: 0.9,
    authorRole: "customer",
    excerpt: "",
    rule: "test",
    reference: null,
    resolved: null,
    ...over,
  };
}

describe("toSegments", () => {
  const body = "Refund order #1001 for $49.99 please";

  it("marks a span and leaves the rest as plain text", () => {
    const segments = toSegments(body, [span(13, 18, { kind: "order_reference" })]);

    expect(segments).toEqual([
      { marked: false, text: "Refund order " },
      { marked: true, text: "#1001", span: expect.objectContaining({ start: 13 }) },
      { marked: false, text: " for $49.99 please" },
    ]);
  });

  it("reassembles to exactly the original text", () => {
    // The invariant that matters most: annotation must never alter the message.
    const segments = toSegments(body, [
      span(13, 18, { kind: "order_reference" }),
      span(23, 29),
    ]);

    expect(segments.map((s) => s.text).join("")).toBe(body);
  });

  it("handles a span at the very start", () => {
    const segments = toSegments("$49.99 refunded", [span(0, 6)]);

    expect(segments[0]).toEqual({
      marked: true,
      text: "$49.99",
      span: expect.objectContaining({ start: 0 }),
    });
  });

  it("handles a span running to the very end", () => {
    const segments = toSegments("I paid $49.99", [span(7, 13)]);

    expect(segments).toHaveLength(2);
    expect(segments[1]).toMatchObject({ marked: true, text: "$49.99" });
  });

  it("handles adjacent spans with no gap between them", () => {
    const segments = toSegments("abcdef", [span(0, 3), span(3, 6)]);

    expect(segments.every((s) => s.marked)).toBe(true);
    expect(segments.map((s) => s.text).join("")).toBe("abcdef");
  });

  it("returns the whole body when there is nothing to mark", () => {
    expect(toSegments(body, [])).toEqual([{ marked: false, text: body }]);
  });

  it("skips a span that runs past the end of the message", () => {
    // Offsets that no longer describe this text. Marking something nearby
    // would be a guess presented as a fact.
    const segments = toSegments("short", [span(2, 99)]);

    expect(segments).toEqual([{ marked: false, text: "short" }]);
  });

  it("skips an empty or inverted span", () => {
    expect(toSegments("abcdef", [span(3, 3)])).toEqual([
      { marked: false, text: "abcdef" },
    ]);
    expect(toSegments("abcdef", [span(4, 2)])).toEqual([
      { marked: false, text: "abcdef" },
    ]);
  });

  it("does not split a surrogate pair", () => {
    // Offsets are UTF-16 code units. An emoji is two of them, and a mark
    // landing between them renders as a replacement character.
    const withEmoji = "😀 $49.99";
    const segments = toSegments(withEmoji, [span(3, 9)]);

    expect(segments.map((s) => s.text).join("")).toBe(withEmoji);
    expect(segments.find((s) => s.marked)?.text).toBe("$49.99");
  });
});

describe("resolveOverlaps", () => {
  it("keeps the more specific signal when two readings collide", () => {
    // "$49.99" read as both an amount and part of a payment reference.
    const kept = resolveOverlaps([
      span(0, 6, { kind: "money", confidence: 0.97 }),
      span(0, 6, { kind: "payment_reference", confidence: 0.9 }),
    ]);

    expect(kept).toHaveLength(1);
    expect(kept[0].kind).toBe("payment_reference");
  });

  it("breaks a tie within one kind on confidence", () => {
    const kept = resolveOverlaps([
      span(0, 6, { kind: "money", confidence: 0.6, display: "weak" }),
      span(2, 8, { kind: "money", confidence: 0.95, display: "strong" }),
    ]);

    expect(kept).toHaveLength(1);
    expect(kept[0].display).toBe("strong");
  });

  it("keeps spans that merely touch without overlapping", () => {
    expect(resolveOverlaps([span(0, 5), span(5, 10)])).toHaveLength(2);
  });

  it("returns spans in reading order regardless of input order", () => {
    const kept = resolveOverlaps([span(20, 25), span(0, 5), span(10, 15)]);
    expect(kept.map((s) => s.start)).toEqual([0, 10, 20]);
  });
});
