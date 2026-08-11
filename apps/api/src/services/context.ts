/**
 * @support-overlay/api — reading extracted conversation context
 *
 * The extractor writes `issue_context`; this reads it back for the card. Kept
 * separate from ingestion so a read path never pulls in the connectors.
 *
 * The card shows highlights rather than the raw thread. Each one carries the
 * exact text it came from, because "we think the customer wants a refund" is
 * only actionable next to the sentence that says so — an agent has to be able
 * to check the claim in one glance, and a wrong highlight has to be visibly
 * wrong rather than quietly authoritative.
 */
import { query } from "../db/pool";

/** One record a span could be referring to. */
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

export interface Annotation {
  kind: string;
  display: string;
  confidence: number;
  authorRole: string;
  sourceId: string;
  sourceKind: string;
  /** Character offsets into the message body this span marks. */
  start: number;
  end: number;
  excerpt: string;
  rule: string;
  /** The identifier as written, for references. Null for other kinds. */
  reference: string | null;
  /**
   * Every record this span could mean — often none, sometimes several. Never
   * narrowed to one: two orders on the same day is a question for the agent,
   * and a single plausible answer is what stops someone looking further.
   */
  candidates: CandidateRecord[];
  /** How the match was made, so the panel can say why. */
  matchedOn: string | null;
}

/** One piece of the thread, with the spans that fall inside it. */
export interface ThreadMessage {
  sourceId: string;
  kind: string;
  authorRole: string;
  /** Null when erased; `redacted` says so. */
  body: string | null;
  redacted: boolean;
  redactionReason: string | null;
  createdAt: string;
  annotations: Annotation[];
}

export interface IssueContext {
  extractorVersion: string;
  paymentReference: string | null;
  orderReference: string | null;
  claimedAmountCents: number | null;
  claimedCurrency: string | null;
  primaryAsk: string | null;
  messageCount: number;
  extractedAt: string;
  /** The thread, in order, each message carrying its own spans. */
  thread: ThreadMessage[];
}

interface StoredAnnotation {
  kind?: string;
  display?: string;
  confidence?: number;
  author_role?: string;
  source_id?: string;
  source_kind?: string;
  start?: number;
  end?: number;
  excerpt?: string;
  rule?: string;
  reference?: string | null;
  candidates?: CandidateRecord[] | null;
  matched_on?: string | null;
}

interface ContextRow {
  extractor_version: string;
  payment_reference: string | null;
  order_reference: string | null;
  claimed_amount_cents: number | null;
  claimed_currency: string | null;
  primary_ask: string | null;
  annotations: StoredAnnotation[] | null;
  message_count: number;
  extracted_at: string;
}

interface MessageRow {
  source_id: string;
  kind: string;
  author_role: string;
  body: string | null;
  created_at: string;
  body_redacted_at: string | null;
  body_redaction_reason: string | null;
}

/**
 * Load the current extraction for an issue, as a thread with spans attached.
 *
 * Null when the ticket has not been ingested — an issue can exist before
 * extraction runs, and the card must render either way.
 */
export async function loadIssueContext(
  tenantId: string,
  issueId: string
): Promise<IssueContext | null> {
  const [contextResult, messageResult] = await Promise.all([
    query<ContextRow>(
      `SELECT extractor_version, payment_reference, order_reference,
              claimed_amount_cents, claimed_currency, primary_ask,
              annotations, message_count, extracted_at
         FROM issue_context
        WHERE tenant_id = $1 AND issue_id = $2`,
      [tenantId, issueId]
    ),
    query<MessageRow>(
      `SELECT source_id, kind, author_role, body, created_at,
              body_redacted_at, body_redaction_reason
         FROM issue_messages
        WHERE tenant_id = $1 AND issue_id = $2
        ORDER BY position`,
      [tenantId, issueId]
    ),
  ]);

  const row = contextResult.rows[0];
  if (!row) return null;

  const bySource = new Map<string, Annotation[]>();
  for (const stored of row.annotations ?? []) {
    for (const annotation of toAnnotation(stored)) {
      const list = bySource.get(annotation.sourceId);
      if (list) list.push(annotation);
      else bySource.set(annotation.sourceId, [annotation]);
    }
  }

  const thread: ThreadMessage[] = messageResult.rows.map((message) => {
    const redacted = message.body_redacted_at !== null;

    return {
      sourceId: message.source_id,
      kind: message.kind,
      authorRole: message.author_role,
      body: redacted ? null : message.body,
      redacted,
      redactionReason: message.body_redaction_reason,
      createdAt: message.created_at,
      // An erased message keeps no spans: offsets into text that no longer
      // exists cannot be rendered, and listing them would leak the shape of
      // what was deleted.
      annotations: redacted
        ? []
        : validateSpans(bySource.get(message.source_id) ?? [], message.body),
    };
  });

  return {
    extractorVersion: row.extractor_version,
    paymentReference: row.payment_reference,
    orderReference: row.order_reference,
    claimedAmountCents: row.claimed_amount_cents,
    claimedCurrency: row.claimed_currency,
    primaryAsk: row.primary_ask,
    messageCount: row.message_count,
    extractedAt: row.extracted_at,
    thread,
  };
}

/**
 * Drop spans that do not land where they claim to.
 *
 * The whole feature rests on `body.slice(start, end) === excerpt`. If an
 * extractor changes its offsets, or a message is edited after extraction, a
 * stale span marks the wrong words — and a panel that confidently highlights
 * the wrong text is worse than one that highlights nothing. Checking here
 * costs a string compare per span and fails toward showing plain text.
 */
function validateSpans(annotations: Annotation[], body: string | null): Annotation[] {
  if (body === null) return [];

  return annotations
    .filter((a) => body.slice(a.start, a.end) === a.excerpt)
    .sort((a, b) => a.start - b.start);
}

/**
 * Stored JSONB may have been written by an earlier extractor version, so every
 * field is optional. A span without usable offsets is dropped rather than
 * rendered as an unsourced claim.
 */
function toAnnotation(stored: StoredAnnotation): Annotation[] {
  const { kind, display, excerpt, start, end } = stored;

  if (!kind || !display || !excerpt) return [];
  if (typeof start !== "number" || typeof end !== "number") return [];
  if (start < 0 || end <= start) return [];

  return [
    {
      kind,
      display,
      confidence: typeof stored.confidence === "number" ? stored.confidence : 0,
      authorRole: stored.author_role ?? "unknown",
      sourceId: stored.source_id ?? "",
      sourceKind: stored.source_kind ?? "comment",
      start,
      end,
      excerpt,
      rule: stored.rule ?? "",
      reference: stored.reference ?? null,
      candidates: Array.isArray(stored.candidates) ? stored.candidates : [],
      matchedOn: stored.matched_on ?? null,
    },
  ];
}
