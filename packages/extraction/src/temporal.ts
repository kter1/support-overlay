/**
 * @iisl/extraction — dates
 *
 * Dates matter because the matching engine uses timing to corroborate: a refund
 * two hours after the ticket is consistent, one from four months earlier is
 * probably a different transaction.
 *
 * Relative expressions ("last Tuesday") resolve against the timestamp of the
 * message that contains them, not against now. A ticket read six weeks later
 * must resolve to the same instant it meant when written, or the audit trail
 * changes every time someone opens the card.
 */
import { DateSignal, TextSource, ExtractionOptions } from "./types";

const MONTHS: Record<string, number> = {
  jan: 0, january: 0, feb: 1, february: 1, mar: 2, march: 2,
  apr: 3, april: 3, may: 4, jun: 5, june: 5, jul: 6, july: 6,
  aug: 7, august: 7, sep: 8, sept: 8, september: 8, oct: 9, october: 9,
  nov: 10, november: 10, dec: 11, december: 11,
};

const WEEKDAYS: Record<string, number> = {
  sunday: 0, monday: 1, tuesday: 2, wednesday: 3,
  thursday: 4, friday: 5, saturday: 6,
};

const MONTH_NAMES = Object.keys(MONTHS).join("|");
const WEEKDAY_NAMES = Object.keys(WEEKDAYS).join("|");

export function extractDates(
  source: TextSource,
  options: ExtractionOptions = {}
): DateSignal[] {
  const reference = options.referenceDate ?? source.createdAt;
  const claimed: Array<[number, number]> = [];
  const signals: DateSignal[] = [];

  const push = (
    start: number,
    end: number,
    excerpt: string,
    rule: string,
    date: Date,
    granularity: DateSignal["value"]["granularity"],
    wasRelative: boolean,
    confidence: number
  ): void => {
    if (claimed.some(([s, e]) => start < e && end > s)) return;
    if (!Number.isFinite(date.getTime())) return;

    claimed.push([start, end]);
    signals.push({
      kind: "date",
      value: { date, granularity, wasRelative },
      display: formatDate(date, granularity),
      confidence,
      authorRole: source.authorRole,
      observedAt: source.createdAt,
      provenance: {
        sourceId: source.id,
        sourceKind: source.kind,
        start,
        end,
        excerpt,
        rule,
      },
    });
  };

  // ── ISO: 2024-01-15 ───────────────────────────────────────────────────────
  scan(source.text, /\b(\d{4})-(\d{2})-(\d{2})\b/g, (m) => {
    push(
      m.index,
      m.index + m[0].length,
      m[0],
      "iso_date",
      new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])),
      "day",
      false,
      0.99
    );
  });

  // ── Month name: "January 15, 2024", "15 Jan 2024", "Jan 15" ───────────────
  scan(
    source.text,
    new RegExp(`\\b(${MONTH_NAMES})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s*(\\d{4}))?\\b`, "gi"),
    (m) => {
      const year = m[3] ? +m[3] : inferYear(reference, MONTHS[m[1].toLowerCase()], +m[2]);
      push(
        m.index,
        m.index + m[0].length,
        m[0],
        "month_name_first",
        new Date(Date.UTC(year, MONTHS[m[1].toLowerCase()], +m[2])),
        "day",
        !m[3],
        m[3] ? 0.96 : 0.85
      );
    }
  );

  scan(
    source.text,
    new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(${MONTH_NAMES})\\.?(?:,?\\s*(\\d{4}))?\\b`, "gi"),
    (m) => {
      const year = m[3] ? +m[3] : inferYear(reference, MONTHS[m[2].toLowerCase()], +m[1]);
      push(
        m.index,
        m.index + m[0].length,
        m[0],
        "day_month_name",
        new Date(Date.UTC(year, MONTHS[m[2].toLowerCase()], +m[1])),
        "day",
        !m[3],
        m[3] ? 0.96 : 0.85
      );
    }
  );

  // ── Numeric slash dates ───────────────────────────────────────────────────
  // Genuinely ambiguous: 03/04/2024 is March 4th to a US reader and April 3rd
  // elsewhere. Emitted at low confidence rather than guessed at silently, and
  // only when one component is unambiguously a day.
  scan(source.text, /\b(\d{1,2})\/(\d{1,2})\/(\d{2,4})\b/g, (m) => {
    const a = +m[1];
    const b = +m[2];
    const year = m[3].length === 2 ? 2000 + +m[3] : +m[3];

    let month: number;
    let day: number;
    let confidence: number;

    if (a > 12 && b <= 12) {
      day = a;
      month = b - 1;
      confidence = 0.95;
    } else if (b > 12 && a <= 12) {
      month = a - 1;
      day = b;
      confidence = 0.95;
    } else {
      // Both plausible. Assume US ordering, and say so with the score.
      month = a - 1;
      day = b;
      confidence = 0.55;
    }

    push(
      m.index,
      m.index + m[0].length,
      m[0],
      "numeric_slash",
      new Date(Date.UTC(year, month, day)),
      "day",
      false,
      confidence
    );
  });

  // ── Relative: today, yesterday, N days/weeks/months ago ───────────────────
  scan(source.text, /\b(today|yesterday)\b/gi, (m) => {
    const days = m[1].toLowerCase() === "yesterday" ? 1 : 0;
    push(
      m.index,
      m.index + m[0].length,
      m[0],
      "relative_named_day",
      shiftDays(reference, -days),
      "day",
      true,
      0.9
    );
  });

  scan(source.text, /\b(\d{1,3})\s+(day|week|month)s?\s+ago\b/gi, (m) => {
    const n = +m[1];
    const unit = m[2].toLowerCase();
    const days = unit === "day" ? n : unit === "week" ? n * 7 : n * 30;
    push(
      m.index,
      m.index + m[0].length,
      m[0],
      "relative_offset",
      shiftDays(reference, -days),
      unit === "month" ? "month" : "day",
      true,
      unit === "month" ? 0.7 : 0.85
    );
  });

  scan(source.text, /\b(?:last|this|past)\s+(week|month)\b/gi, (m) => {
    const days = m[1].toLowerCase() === "week" ? 7 : 30;
    push(
      m.index,
      m.index + m[0].length,
      m[0],
      "relative_period",
      shiftDays(reference, -days),
      m[1].toLowerCase() === "week" ? "day" : "month",
      true,
      0.6
    );
  });

  scan(source.text, new RegExp(`\\b(?:last|on)\\s+(${WEEKDAY_NAMES})\\b`, "gi"), (m) => {
    push(
      m.index,
      m.index + m[0].length,
      m[0],
      "relative_weekday",
      previousWeekday(reference, WEEKDAYS[m[1].toLowerCase()]),
      "day",
      true,
      0.75
    );
  });

  return signals.sort((a, b) => a.provenance.start - b.provenance.start);
}

function scan(
  text: string,
  regex: RegExp,
  onMatch: (match: RegExpExecArray) => void
): void {
  regex.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(text)) !== null) {
    onMatch(match);
    if (match[0].length === 0) regex.lastIndex++;
  }
}

/**
 * A bare "Jan 15" means the most recent one — customers write about purchases
 * they already made, so a date resolving into the future is the wrong reading.
 */
function inferYear(reference: Date, month: number, day: number): number {
  const year = reference.getUTCFullYear();
  const candidate = Date.UTC(year, month, day);
  return candidate > reference.getTime() ? year - 1 : year;
}

function shiftDays(from: Date, days: number): Date {
  return new Date(from.getTime() + days * 86_400_000);
}

function previousWeekday(reference: Date, weekday: number): Date {
  const diff = (reference.getUTCDay() - weekday + 7) % 7 || 7;
  return shiftDays(reference, -diff);
}

function formatDate(date: Date, granularity: DateSignal["value"]["granularity"]): string {
  const options: Intl.DateTimeFormatOptions =
    granularity === "year"
      ? { year: "numeric", timeZone: "UTC" }
      : granularity === "month"
        ? { year: "numeric", month: "short", timeZone: "UTC" }
        : { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" };

  return new Intl.DateTimeFormat("en-US", options).format(date);
}
