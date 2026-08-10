/**
 * @support-overlay/api — customer history assembly
 *
 * Extraction answers "what is this ticket about?". This answers the question an
 * experienced agent asks next: "have we been here before with this person?"
 *
 * That question is not sentiment analysis and it is not a churn score. It is a
 * factual lookup with one dangerous answer: *we already refunded this order*.
 * A customer who opens a second ticket about the same order — because the first
 * refund had not landed in their bank yet — is the single most common way a
 * support team pays twice for one purchase. The agent almost never has the
 * earlier ticket open, so the system has to carry it forward.
 *
 * Everything here is derived from records the system already wrote. Nothing is
 * inferred about the customer as a person, only about what was done for them.
 *
 * The window is every *other* issue for the same customer, not only earlier
 * ones. A refund that exists is a duplicate risk regardless of which ticket it
 * was issued from, and two tickets about one order are often minutes apart with
 * the "second" one processed first. Callers must therefore not describe these
 * as having happened before the current issue — see the notice wording.
 */
import { query } from "../db/pool";

export interface PriorInteraction {
  issueId: string;
  zendeskTicketId: string | null;
  openedAt: string;
  state: string;
  /** What they asked for last time, if the extractor could tell. */
  primaryAsk: string | null;
  orderReference: string | null;
  paymentReference: string | null;
  claimedAmountCents: number | null;
  matchBand: string | null;
  /** A refund the system can see was actually issued on that issue. */
  refundedAmountCents: number | null;
  refundCurrency: string | null;
  refundStatus: string | null;
  /** Terminal actions this system executed on that issue. */
  actionsTaken: Array<{ actionType: string; completedAt: string | null }>;
  /** True when that issue names the same order or charge as the current one. */
  sameSubject: boolean;
}

export interface CustomerHistory {
  /** Null when the ticket has no identifiable requester. */
  customerId: string | null;
  priorInteractions: PriorInteraction[];
  /** Counts across the returned window, not all time — see `truncated`. */
  priorIssueCount: number;
  /** More history exists than was returned. */
  truncated: boolean;
  /**
   * Plain-language facts worth putting in front of the agent before they act.
   * Ordered most-consequential first. Deliberately factual: each one names a
   * record the agent can go and check.
   */
  notices: HistoryNotice[];
}

export interface HistoryNotice {
  severity: "critical" | "warning" | "info";
  code:
    | "prior_refund_same_subject"
    | "repeat_contact_same_subject"
    | "repeat_refund_requests"
    | "prior_refunds_total";
  message: string;
  /** Issues the agent should look at to verify the claim. */
  issueIds: string[];
}

/** How far back to look. Enough to catch a re-contact, bounded for latency. */
const HISTORY_LIMIT = 10;

/** Distinct refund requests within the window before it is worth remarking on. */
const REPEAT_REQUEST_THRESHOLD = 3;

interface HistoryRow {
  issue_id: string;
  zendesk_ticket_id: string | null;
  opened_at: string;
  state: string;
  primary_ask: string | null;
  order_reference: string | null;
  payment_reference: string | null;
  claimed_amount_cents: number | null;
  match_band: string | null;
  refund_amount_cents: number | null;
  refund_currency: string | null;
  refund_status: string | null;
  actions: Array<{ action_type: string; completed_at: string | null }> | null;
}

/**
 * Assemble what is known about this customer's earlier issues.
 *
 * Returns an empty history rather than throwing when the customer cannot be
 * identified: an anonymous ticket is a normal case, and the card must still
 * render. Never returns the current issue.
 */
export async function assembleCustomerHistory(
  tenantId: string,
  issueId: string
): Promise<CustomerHistory> {
  const subject = await currentSubject(tenantId, issueId);

  if (!subject.customerId) {
    return {
      customerId: null,
      priorInteractions: [],
      priorIssueCount: 0,
      truncated: false,
      notices: [],
    };
  }

  // One row per prior issue. Actions are aggregated in the query rather than
  // fetched per issue, so history costs one round trip regardless of depth.
  const result = await query<HistoryRow>(
    `SELECT
       i.id            AS issue_id,
       t.zendesk_ticket_id,
       i.opened_at,
       i.state,
       ctx.primary_ask,
       ctx.order_reference,
       ctx.payment_reference,
       ctx.claimed_amount_cents,
       cs.match_band,
       cs.refund_amount_cents,
       cs.refund_currency,
       cs.refund_status,
       COALESCE(acts.actions, '[]'::jsonb) AS actions
     FROM issues i
     LEFT JOIN issue_tickets t
       ON t.issue_id = i.id AND t.tenant_id = i.tenant_id AND t.is_primary
     LEFT JOIN issue_context ctx
       ON ctx.issue_id = i.id AND ctx.tenant_id = i.tenant_id
     LEFT JOIN issue_card_state cs
       ON cs.issue_id = i.id AND cs.tenant_id = i.tenant_id
     LEFT JOIN LATERAL (
       SELECT jsonb_agg(
                jsonb_build_object(
                  'action_type', ae.action_type,
                  'completed_at', ae.completed_at
                )
                ORDER BY ae.completed_at
              ) AS actions
         FROM action_executions ae
        WHERE ae.issue_id = i.id
          AND ae.tenant_id = i.tenant_id
          AND ae.status = 'COMPLETED'
     ) acts ON true
     WHERE i.tenant_id = $1
       AND i.customer_id = $2
       AND i.id <> $3
     ORDER BY i.opened_at DESC
     LIMIT $4`,
    [tenantId, subject.customerId, issueId, HISTORY_LIMIT + 1]
  );

  const truncated = result.rows.length > HISTORY_LIMIT;
  const rows = truncated ? result.rows.slice(0, HISTORY_LIMIT) : result.rows;

  const priorInteractions: PriorInteraction[] = rows.map((row) => ({
    issueId: row.issue_id,
    zendeskTicketId: row.zendesk_ticket_id,
    openedAt: row.opened_at,
    state: row.state,
    primaryAsk: row.primary_ask,
    orderReference: row.order_reference,
    paymentReference: row.payment_reference,
    claimedAmountCents: row.claimed_amount_cents,
    matchBand: row.match_band,
    refundedAmountCents: row.refund_amount_cents,
    refundCurrency: row.refund_currency,
    refundStatus: row.refund_status,
    actionsTaken: (row.actions ?? []).map((a) => ({
      actionType: a.action_type,
      completedAt: a.completed_at,
    })),
    sameSubject: isSameSubject(subject, row),
  }));

  return {
    customerId: subject.customerId,
    priorInteractions,
    priorIssueCount: priorInteractions.length,
    truncated,
    notices: deriveNotices(priorInteractions),
  };
}

interface CurrentSubject {
  customerId: string | null;
  orderReference: string | null;
  paymentReference: string | null;
}

/** Who this ticket is from, and which transaction it names. */
async function currentSubject(
  tenantId: string,
  issueId: string
): Promise<CurrentSubject> {
  const result = await query<{
    customer_id: string | null;
    order_reference: string | null;
    payment_reference: string | null;
  }>(
    `SELECT i.customer_id, ctx.order_reference, ctx.payment_reference
       FROM issues i
       LEFT JOIN issue_context ctx
         ON ctx.issue_id = i.id AND ctx.tenant_id = i.tenant_id
      WHERE i.tenant_id = $1 AND i.id = $2`,
    [tenantId, issueId]
  );

  const row = result.rows[0];
  if (!row) {
    return { customerId: null, orderReference: null, paymentReference: null };
  }

  return {
    // Defensive: an empty customer_id from older rows must not match every
    // other empty one and link unrelated people's histories together.
    customerId: row.customer_id?.trim() ? row.customer_id : null,
    orderReference: row.order_reference,
    paymentReference: row.payment_reference,
  };
}

/**
 * Whether a prior issue concerns the same transaction as the current one.
 *
 * Matched on identifiers only. Amount is deliberately excluded: two $49.99
 * orders from the same customer are common and are not the same purchase, and
 * treating them as one would produce exactly the false "already refunded"
 * warning that trains agents to ignore the banner.
 */
function isSameSubject(subject: CurrentSubject, row: HistoryRow): boolean {
  if (subject.orderReference && row.order_reference === subject.orderReference) {
    return true;
  }
  if (
    subject.paymentReference &&
    row.payment_reference === subject.paymentReference
  ) {
    return true;
  }
  return false;
}

/**
 * Turn the history into the handful of statements worth interrupting an agent
 * for. Silence is the default — a banner that fires on every ticket is a banner
 * nobody reads.
 */
function deriveNotices(interactions: PriorInteraction[]): HistoryNotice[] {
  const notices: HistoryNotice[] = [];

  // ── The one that prevents paying twice ──────────────────────────────────────
  const refundedSameSubject = interactions.filter(
    (i) => i.sameSubject && wasRefunded(i)
  );

  if (refundedSameSubject.length > 0) {
    const first = refundedSameSubject[0];
    notices.push({
      severity: "critical",
      code: "prior_refund_same_subject",
      message:
        `A refund was already issued for this same ${
          first.orderReference ? "order" : "charge"
        } on ${describeTicket(first)}` +
        `${
          first.refundedAmountCents !== null
            ? ` (${formatMoney(first.refundedAmountCents, first.refundCurrency)})`
            : ""
        }. Confirm this is a separate purchase before refunding again.`,
      issueIds: refundedSameSubject.map((i) => i.issueId),
    });
  }

  // ── Re-contact about the same transaction, without a refund yet ─────────────
  const sameSubjectOnly = interactions.filter(
    (i) => i.sameSubject && !wasRefunded(i)
  );

  if (sameSubjectOnly.length > 0) {
    notices.push({
      severity: "warning",
      code: "repeat_contact_same_subject",
      // Not "contacted you before": the window includes issues opened after
      // this one, and claiming an order of events the data does not support is
      // the kind of small inaccuracy that costs the whole card its credibility.
      message: `This customer has another open issue about the same ${
        sameSubjectOnly[0].orderReference ? "order" : "charge"
      } (${sameSubjectOnly.map(describeTicket).join(", ")}). Check what was promised.`,
      issueIds: sameSubjectOnly.map((i) => i.issueId),
    });
  }

  // ── Pattern across different transactions ───────────────────────────────────
  const refundRequests = interactions.filter(
    (i) => i.primaryAsk === "refund_request"
  );

  if (refundRequests.length >= REPEAT_REQUEST_THRESHOLD) {
    notices.push({
      severity: "info",
      code: "repeat_refund_requests",
      message: `${refundRequests.length} other refund requests from this customer are on record.`,
      issueIds: refundRequests.map((i) => i.issueId),
    });
  }

  // ── What has actually been paid out ─────────────────────────────────────────
  const refunded = interactions.filter(wasRefunded);
  const currencies = new Set(
    refunded.map((i) => i.refundCurrency).filter((c): c is string => !!c)
  );

  // Only total when there is one currency: summing across currencies would
  // produce a number that means nothing.
  if (refunded.length > 0 && currencies.size <= 1) {
    const total = refunded.reduce(
      (sum, i) => sum + (i.refundedAmountCents ?? 0),
      0
    );
    if (total > 0) {
      notices.push({
        severity: "info",
        code: "prior_refunds_total",
        message: `${formatMoney(total, [...currencies][0] ?? null)} refunded to this customer across ${
          refunded.length
        } other ${refunded.length === 1 ? "issue" : "issues"}.`,
        issueIds: refunded.map((i) => i.issueId),
      });
    }
  }

  return notices;
}

/**
 * A refund is only counted when the payment provider confirmed it. A pending or
 * failed refund is not money out the door, and counting it would produce a
 * "already refunded" warning for a refund that never landed.
 */
function wasRefunded(interaction: PriorInteraction): boolean {
  return interaction.refundStatus === "succeeded";
}

function describeTicket(interaction: PriorInteraction): string {
  const when = new Date(interaction.openedAt).toISOString().slice(0, 10);
  return interaction.zendeskTicketId
    ? `ticket #${interaction.zendeskTicketId} (${when})`
    : `an issue opened ${when}`;
}

/**
 * Minor units to display. Zero-decimal currencies are not scaled — ¥500 is 500
 * yen, not ¥5.00.
 */
const ZERO_DECIMAL = new Set([
  "bif", "clp", "djf", "gnf", "jpy", "kmf", "krw", "mga",
  "pyg", "rwf", "ugx", "vnd", "vuv", "xaf", "xof", "xpf",
]);

function formatMoney(minorUnits: number, currency: string | null): string {
  const code = (currency ?? "usd").toLowerCase();
  const amount = ZERO_DECIMAL.has(code) ? minorUnits : minorUnits / 100;

  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: code.toUpperCase(),
    }).format(amount);
  } catch {
    // An unknown currency code must not break the card.
    return `${amount} ${code.toUpperCase()}`;
  }
}
