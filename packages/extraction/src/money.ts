/**
 * @iisl/extraction — monetary amounts
 *
 * Precision matters more than recall here. A missed amount means the card shows
 * one fewer fact; a wrong amount means an agent compares a refund against a
 * number the customer never said. So patterns require an explicit currency
 * marker or a decimal structure that is unambiguously money, and anything that
 * looks like an order number, a date, or a quantity is left alone.
 */
import {
  MoneySignal,
  Provenance,
  TextSource,
  ExtractionOptions,
  provenanceOf as sharedProvenanceOf,
} from "./types";

/** Symbols we recognise, mapped to ISO 4217. */
const SYMBOL_CURRENCY: Record<string, string> = {
  $: "USD",
  "£": "GBP",
  "€": "EUR",
  "¥": "JPY",
};

const CODE_PATTERN = "USD|EUR|GBP|CAD|AUD|JPY|CHF|SEK|NZD";

/**
 * Currencies without minor units. Treating "¥500" as 50000 cents would inflate
 * a refund by a factor of 100.
 */
const ZERO_DECIMAL = new Set(["JPY", "KRW", "VND", "CLP", "ISK"]);

interface Candidate {
  start: number;
  end: number;
  raw: string;
  amountText: string;
  currency: string | null;
  rule: string;
  confidence: number;
}

/**
 * Ordered by specificity. The first rule to claim a span wins, so a symbol-led
 * match is not re-matched by the looser decimal rule.
 */
const RULES: Array<{ id: string; regex: RegExp; confidence: number }> = [
  {
    // $49.99 · £1,234.56 · €25,50
    id: "symbol_prefixed",
    regex: new RegExp(`([$£€¥])\\s?(\\d{1,3}(?:[,.\\s]\\d{3})*(?:[.,]\\d{1,2})?)`, "g"),
    confidence: 0.97,
  },
  {
    // 49.99 USD · 1,234.56 EUR
    id: "code_suffixed",
    regex: new RegExp(`(\\d{1,3}(?:[,.\\s]\\d{3})*(?:[.,]\\d{1,2})?)\\s?(${CODE_PATTERN})\\b`, "gi"),
    confidence: 0.97,
  },
  {
    // USD 49.99
    id: "code_prefixed",
    regex: new RegExp(`\\b(${CODE_PATTERN})\\s?(\\d{1,3}(?:[,.\\s]\\d{3})*(?:[.,]\\d{1,2})?)`, "gi"),
    confidence: 0.97,
  },
  {
    // 49.99 dollars · 30 pounds · 25 euros
    id: "word_suffixed",
    regex: /(\d{1,3}(?:[,.\s]\d{3})*(?:[.,]\d{1,2})?)\s?(dollars?|pounds?|euros?|quid|bucks)\b/gi,
    confidence: 0.9,
  },
  {
    // A bare decimal, only when adjacent wording makes it monetary.
    id: "bare_decimal_with_context",
    regex: /\b(\d{1,3}(?:,\d{3})*\.\d{2})\b/g,
    confidence: 0.62,
  },
];

/** Words near a bare decimal that make it money rather than a measurement. */
const MONEY_CONTEXT =
  /\b(refund|charged?|charge|paid|pay|payment|cost|price|priced|total|amount|billed?|invoice|order|credit|reimburse\w*|owe[sd]?)\b/i;

export function extractMoney(
  source: TextSource,
  options: ExtractionOptions = {}
): MoneySignal[] {
  const claimed: Array<[number, number]> = [];
  const signals: MoneySignal[] = [];

  for (const rule of RULES) {
    rule.regex.lastIndex = 0;
    let match: RegExpExecArray | null;

    while ((match = rule.regex.exec(source.text)) !== null) {
      const start = match.index;
      const end = start + match[0].length;

      // A more specific rule already owns this span.
      if (claimed.some(([s, e]) => start < e && end > s)) continue;

      const candidate = buildCandidate(rule.id, rule.confidence, match, start, end);
      if (!candidate) continue;

      if (rule.id === "bare_decimal_with_context") {
        // Require monetary wording within a short window either side; a lone
        // "2.50" in "version 2.50" is not an amount.
        const window = source.text.slice(Math.max(0, start - 60), end + 60);
        if (!MONEY_CONTEXT.test(window)) continue;
      }

      const parsed = parseAmount(candidate.amountText, candidate.currency, options);
      if (parsed === null) continue;

      claimed.push([start, end]);
      signals.push({
        kind: "money",
        value: parsed,
        display: formatMoney(parsed.amountCents, parsed.currency),
        confidence: candidate.confidence,
        authorRole: source.authorRole,
        observedAt: source.createdAt,
        provenance: provenanceOf(source, start, end, candidate.raw, candidate.rule),
      });
    }
  }

  return signals.sort((a, b) => a.provenance.start - b.provenance.start);
}

function buildCandidate(
  ruleId: string,
  confidence: number,
  match: RegExpExecArray,
  start: number,
  end: number
): Candidate | null {
  const raw = match[0];

  switch (ruleId) {
    case "symbol_prefixed":
      return {
        start,
        end,
        raw,
        amountText: match[2],
        currency: SYMBOL_CURRENCY[match[1]] ?? null,
        rule: ruleId,
        confidence,
      };
    case "code_suffixed":
      return {
        start,
        end,
        raw,
        amountText: match[1],
        currency: match[2].toUpperCase(),
        rule: ruleId,
        confidence,
      };
    case "code_prefixed":
      return {
        start,
        end,
        raw,
        amountText: match[2],
        currency: match[1].toUpperCase(),
        rule: ruleId,
        confidence,
      };
    case "word_suffixed":
      return {
        start,
        end,
        raw,
        amountText: match[1],
        currency: wordCurrency(match[2]),
        rule: ruleId,
        confidence,
      };
    case "bare_decimal_with_context":
      return {
        start,
        end,
        raw,
        amountText: match[1],
        currency: null,
        rule: ruleId,
        confidence,
      };
    default:
      return null;
  }
}

function wordCurrency(word: string): string | null {
  const w = word.toLowerCase();
  if (w.startsWith("dollar") || w === "bucks") return "USD";
  if (w.startsWith("pound") || w === "quid") return "GBP";
  if (w.startsWith("euro")) return "EUR";
  return null;
}

/**
 * Parse a written amount into minor units.
 *
 * The hard case is separator convention: "1,234.56" and "1.234,56" are the same
 * amount written two ways, and "1,234" is ambiguous between one thousand
 * two hundred and one-point-two-three-four. Resolved by position and grouping,
 * defaulting to the reading that does not silently multiply by 1000.
 */
function parseAmount(
  text: string,
  currency: string | null,
  options: ExtractionOptions
): { amountCents: number; currency: string | null } | null {
  const resolved = currency ?? options.defaultCurrency ?? null;
  const cleaned = text.replace(/\s/g, "");

  const lastComma = cleaned.lastIndexOf(",");
  const lastDot = cleaned.lastIndexOf(".");

  let normalized: string;

  if (lastComma === -1 && lastDot === -1) {
    normalized = cleaned;
  } else if (lastComma > lastDot) {
    // Comma is last: European decimal ("1.234,56") — unless it groups thousands
    // ("1,234"), which we detect by exactly three trailing digits.
    const decimals = cleaned.length - lastComma - 1;
    normalized =
      decimals === 3
        ? cleaned.replace(/[,.]/g, "")
        : cleaned.replace(/\./g, "").replace(",", ".");
  } else {
    // Dot is last: Anglo decimal, commas group thousands.
    const decimals = cleaned.length - lastDot - 1;
    normalized =
      decimals === 3 && !cleaned.includes(",")
        ? cleaned.replace(/\./g, "")
        : cleaned.replace(/,/g, "");
  }

  const amount = Number.parseFloat(normalized);
  if (!Number.isFinite(amount) || amount < 0) return null;

  const minorUnits = resolved && ZERO_DECIMAL.has(resolved) ? 1 : 100;
  const amountCents = Math.round(amount * minorUnits);

  // Amounts beyond this are almost always a misparse (an order number, an id).
  if (amountCents > 100_000_000) return null;

  return { amountCents, currency: resolved };
}

export function formatMoney(amountCents: number, currency: string | null): string {
  const code = currency ?? "USD";
  const minorUnits = ZERO_DECIMAL.has(code) ? 1 : 100;
  const value = amountCents / minorUnits;

  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: code,
      minimumFractionDigits: minorUnits === 1 ? 0 : 2,
    }).format(value);
  } catch {
    return `${value.toFixed(minorUnits === 1 ? 0 : 2)} ${code}`;
  }
}

/**
 * Local shim over the shared builder: callers still pass the excerpt they
 * matched, but it is discarded in favour of the text at [start, end). Keeping
 * the parameter means every existing call site is checked by the compiler
 * while the value itself can no longer disagree with the offsets.
 */
function provenanceOf(
  source: TextSource,
  start: number,
  end: number,
  _excerpt: string,
  rule: string
): Provenance {
  return sharedProvenanceOf(source, start, end, rule);
}
