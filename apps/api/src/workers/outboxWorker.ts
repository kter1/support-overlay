/**
 * @support-overlay/api — Outbox worker
 *
 * Processes pending outbox_messages with effects-ledger deduplication and
 * per-action retry classification.
 *
 * Invariants this file exists to hold:
 *
 *  - A side effect is dispatched at most once per effect_key. The ledger is the
 *    record; a claim that finds a settled effect skips dispatch entirely.
 *  - state_transitions is written only after every outbox message for an
 *    execution is SENT. FAILED_TERMINAL never writes one.
 *  - SENT_UNCERTAIN (request sent, outcome unknown) is handled by retry class,
 *    never by generic retry. For money movement it never auto-retries: the
 *    execution parks in BLOCKED_OPERATOR for a human to reconcile.
 *
 * Claiming is done by an atomic UPDATE ... RETURNING so a row is reserved
 * before the claim transaction commits. Selecting with FOR UPDATE SKIP LOCKED
 * and committing before dispatch — as this previously did — releases the locks
 * immediately and lets a second worker pick up the same row.
 */
import { query, withTransaction, DbClient } from "../db/pool";
import { writeAuditEventTx, AuditEventType } from "../services/audit";
import { applyStateTransition } from "../services/actionService";
import { ZendeskAdapter } from "@iisl/connectors";
import { StripeAdapter } from "@iisl/connectors";
import {
  ActionType,
  EffectOutcomeStatus,
  ActorType,
  ACTION_RETRY_CLASS,
  RetryClass,
  PermanentError,
  isTimeoutError,
  isPermanentError,
  EffectLedgerEntry,
} from "@iisl/shared";

const RETRY_DELAYS_MS = [1000, 2000, 4000, 8000, 16000];
const MAX_ATTEMPTS = parseInt(process.env.WORKER_MAX_ATTEMPTS ?? "5", 10);
const POLL_INTERVAL_MS = parseInt(process.env.WORKER_POLL_INTERVAL_MS ?? "2000", 10);
const BATCH_SIZE = 10;

/** Ledger states meaning "this effect is finished; never dispatch it again". */
const SETTLED_STATES: string[] = [
  EffectOutcomeStatus.CONFIRMED,
  EffectOutcomeStatus.SENT_ACKED,
  EffectOutcomeStatus.SENT_UNCERTAIN,
  EffectOutcomeStatus.FAILED_TERMINAL,
];

export interface OutboxRow {
  id: string;
  tenant_id: string;
  action_execution_id: string;
  target_system: string;
  payload: Record<string, unknown>;
  idempotency_key: string;
  status: string;
  attempt_count: number;
  effects: EffectLedgerEntry[];
  effect_settled_at: string | null;
  action_type: string;
  planned_state: string | null;
  issue_id: string;
  requested_by_agent_id: string;
}

let running = false;

export async function startOutboxWorker(): Promise<void> {
  running = true;
  console.log("[worker] Outbox worker started");

  while (running) {
    try {
      const processed = await processNextBatch();
      if (processed === 0) await sleep(POLL_INTERVAL_MS);
    } catch (err) {
      console.error("[worker] Batch processing error:", err);
      await sleep(POLL_INTERVAL_MS);
    }
  }
}

export function stopOutboxWorker(): void {
  running = false;
}

/**
 * Claim and process one batch. Returns how many messages were handled.
 * Exported so tests can drive the worker deterministically instead of racing
 * a background loop.
 */
export async function processNextBatch(): Promise<number> {
  const claimed = await claimBatch();
  for (const msg of claimed) {
    await processMessage(msg);
  }
  return claimed.length;
}

/**
 * Reserve up to BATCH_SIZE due messages by flipping them to IN_PROGRESS in the
 * same statement that selects them. Rows already claimed by another worker are
 * skipped rather than waited on.
 */
async function claimBatch(): Promise<OutboxRow[]> {
  const result = await query<OutboxRow>(
    `UPDATE outbox_messages om
        SET status = 'IN_PROGRESS',
            attempt_count = om.attempt_count + 1
       FROM (
         SELECT id FROM outbox_messages
          WHERE status IN ('PENDING', 'FAILED_RETRIABLE')
            AND (next_attempt_at IS NULL OR next_attempt_at <= now())
          ORDER BY created_at ASC
          LIMIT $1
          FOR UPDATE SKIP LOCKED
       ) due
      WHERE om.id = due.id
      RETURNING om.id, om.tenant_id, om.action_execution_id, om.target_system,
                om.payload, om.idempotency_key, om.status, om.attempt_count,
                om.effects, om.effect_settled_at,
                (SELECT action_type FROM action_executions WHERE id = om.action_execution_id) AS action_type,
                (SELECT planned_state FROM action_executions WHERE id = om.action_execution_id) AS planned_state,
                (SELECT issue_id FROM action_executions WHERE id = om.action_execution_id) AS issue_id,
                (SELECT requested_by_agent_id FROM action_executions WHERE id = om.action_execution_id) AS requested_by_agent_id`,
    [BATCH_SIZE]
  );

  return result.rows;
}

async function processMessage(msg: OutboxRow): Promise<void> {
  const retryClass =
    ACTION_RETRY_CLASS[msg.action_type as ActionType] ?? RetryClass.SAFE_AUTO_RETRY;
  const effectKey = primaryEffectKey(msg);

  // Dedupe gate. If this effect already reached a settled state — because a
  // previous attempt confirmed it, or because a crash lost the response after
  // the provider acted — never dispatch again.
  if (isSettled(msg, effectKey)) {
    console.log(`[worker] Effect ${effectKey} already settled — skipping dispatch`);
    await markOutboxSent(msg.id);
    await checkAndCompleteExecution(msg);
    return;
  }

  await query(
    `UPDATE action_executions SET status = 'IN_PROGRESS' WHERE id = $1`,
    [msg.action_execution_id]
  );

  await appendEffectEntry(msg.id, {
    ...buildEffectEntry(msg, effectKey, msg.attempt_count),
    outcome_status: EffectOutcomeStatus.INTENDED,
  });

  try {
    const result = await executeExternalCall(msg, effectKey);
    await handleSuccess(msg, effectKey, result.providerId ?? null);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);

    if (isTimeoutError(err)) {
      await handleSentUncertain(msg, effectKey, retryClass, detail);
      return;
    }
    if (isPermanentError(err)) {
      await markTerminal(msg, effectKey, detail);
      return;
    }
    await handleRetriableFailure(msg, effectKey, detail);
  }
}

// ─── SENT_UNCERTAIN handling (per retry class) ───────────────────────────────

/**
 * The request was sent and no response came back. The effect may or may not
 * have occurred, so what happens next depends entirely on the action.
 */
async function handleSentUncertain(
  msg: OutboxRow,
  effectKey: string,
  retryClass: RetryClass,
  detail: string
): Promise<void> {
  await updateEffectStatus(msg.id, effectKey, EffectOutcomeStatus.SENT_UNCERTAIN);

  if (retryClass === RetryClass.OPERATOR_RETRY_ONLY) {
    // Money movement. Try to observe whether the effect landed; either way we
    // never re-send. If it did land, that is a confirmation, not a retry.
    const confirmed = await reconcileStripeRefund(msg, effectKey);

    if (confirmed) {
      await appendReconciledEntry(msg, effectKey, confirmed);
      await markOutboxSent(msg.id);
      await checkAndCompleteExecution(msg);
      return;
    }

    await blockForOperator(
      msg,
      effectKey,
      `Refund outcome unknown and could not be confirmed from Stripe. ` +
        `Verify in the Stripe dashboard before any further action. (${detail})`
    );
    return;
  }

  if (retryClass === RetryClass.RECONCILIATION_FIRST) {
    const confirmed = await reconcileZendeskStatus(msg);
    if (confirmed) {
      await appendReconciledEntry(msg, effectKey, null);
      await markOutboxSent(msg.id);
      await checkAndCompleteExecution(msg);
    } else {
      await scheduleRetry(msg, effectKey, detail);
    }
    return;
  }

  if (retryClass === RetryClass.AUTO_RETRY_WITH_DEDUPE) {
    const confirmed = await reconcileZendeskComment(msg);
    if (confirmed) {
      await appendReconciledEntry(msg, effectKey, null);
      await markOutboxSent(msg.id);
      await checkAndCompleteExecution(msg);
    } else {
      await scheduleRetry(msg, effectKey, detail);
    }
    return;
  }

  if (retryClass === RetryClass.BEST_EFFORT_NO_BLOCK) {
    await markOutboxSent(msg.id);
    await checkAndCompleteExecution(msg);
    return;
  }

  await scheduleRetry(msg, effectKey, detail);
}

/**
 * Park the execution for human reconciliation. Deliberately not
 * FAILED_TERMINAL: nothing here says the effect failed, only that its outcome
 * is unknown, and the two must not be conflated in the audit trail.
 */
async function blockForOperator(
  msg: OutboxRow,
  effectKey: string,
  reason: string
): Promise<void> {
  await withTransaction(async (client) => {
    await client.query(
      `UPDATE outbox_messages
          SET status = 'BLOCKED_OPERATOR', effect_settled_at = now()
        WHERE id = $1`,
      [msg.id]
    );
    await client.query(
      `UPDATE action_executions
          SET status = 'FAILED_TERMINAL', error = $2
        WHERE id = $1`,
      [msg.action_execution_id, reason]
    );
    await writeAuditEventTx(client, {
      tenantId: msg.tenant_id,
      issueId: msg.issue_id,
      eventType: AuditEventType.ACTION_EXECUTION_BLOCKED_OPERATOR,
      actorType: ActorType.SYSTEM,
      payload: {
        action_execution_id: msg.action_execution_id,
        outbox_message_id: msg.id,
        effect_key: effectKey,
        action_type: msg.action_type,
        reason,
      },
    });
  });

  console.warn(`[worker] BLOCKED_OPERATOR ${msg.id}: ${reason}`);
}

// ─── Execution completion ────────────────────────────────────────────────────

/**
 * If every outbox message for this execution is SENT, write the state
 * transition and mark the execution COMPLETED.
 *
 * The count and the transition run in one transaction with the issue row
 * locked, so two workers finishing the last two effects concurrently cannot
 * both observe zero pending and both apply the transition.
 */
async function checkAndCompleteExecution(msg: OutboxRow): Promise<void> {
  const completed = await withTransaction(async (client) => {
    // Serialize completion attempts for this issue.
    const issueResult = await client.query<{ state: string }>(
      `SELECT state FROM issues WHERE id = $1 FOR UPDATE`,
      [msg.issue_id]
    );
    if (issueResult.rows.length === 0) return false;

    const pending = await client.query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM outbox_messages
        WHERE action_execution_id = $1 AND status <> 'SENT'`,
      [msg.action_execution_id]
    );
    if (parseInt(pending.rows[0].count, 10) > 0) return false;

    // Another worker may have completed this execution already.
    const execution = await client.query<{ status: string }>(
      `SELECT status FROM action_executions WHERE id = $1 FOR UPDATE`,
      [msg.action_execution_id]
    );
    if (execution.rows[0]?.status === "COMPLETED") return false;

    const currentState = issueResult.rows[0].state;

    if (msg.planned_state && msg.planned_state !== currentState) {
      await applyStateTransition(
        client,
        msg.tenant_id,
        msg.issue_id,
        currentState,
        msg.planned_state,
        msg.action_execution_id,
        msg.action_type,
        msg.requested_by_agent_id
      );
    }

    await client.query(
      `UPDATE action_executions
          SET status = 'COMPLETED', completed_at = now()
        WHERE id = $1`,
      [msg.action_execution_id]
    );

    await writeAuditEventTx(client, {
      tenantId: msg.tenant_id,
      issueId: msg.issue_id,
      eventType: AuditEventType.ACTION_EXECUTION_COMPLETED,
      actorType: ActorType.SYSTEM,
      payload: {
        action_execution_id: msg.action_execution_id,
        action_type: msg.action_type,
        planned_state: msg.planned_state,
      },
    });

    return true;
  });

  if (completed) {
    await rebuildCardState(msg.tenant_id, msg.issue_id);
  }
}

// ─── Outcome handlers ────────────────────────────────────────────────────────

async function handleSuccess(
  msg: OutboxRow,
  effectKey: string,
  providerId: string | null
): Promise<void> {
  await updateEffectStatus(
    msg.id,
    effectKey,
    EffectOutcomeStatus.CONFIRMED,
    providerId
  );
  await markOutboxSent(msg.id);
  await checkAndCompleteExecution(msg);
}

async function handleRetriableFailure(
  msg: OutboxRow,
  effectKey: string,
  error: string
): Promise<void> {
  if (msg.attempt_count >= MAX_ATTEMPTS) {
    await markTerminal(msg, effectKey, `${error} (retry budget exhausted)`);
    return;
  }
  await updateEffectStatus(msg.id, effectKey, EffectOutcomeStatus.FAILED_RETRIABLE);
  await scheduleRetry(msg, effectKey, error);
}

async function markTerminal(
  msg: OutboxRow,
  effectKey: string,
  error: string
): Promise<void> {
  await withTransaction(async (client) => {
    // These writes must use the transaction client. Routing the ledger update
    // through the pool instead — as this used to — let it survive a rollback,
    // leaving the ledger and the execution row disagreeing.
    await updateEffectStatus(
      msg.id,
      effectKey,
      EffectOutcomeStatus.FAILED_TERMINAL,
      null,
      client
    );

    await client.query(
      `UPDATE outbox_messages
          SET status = 'FAILED_TERMINAL', effect_settled_at = now()
        WHERE id = $1`,
      [msg.id]
    );

    // FAILED_TERMINAL deliberately does not write state_transitions.
    await client.query(
      `UPDATE action_executions
          SET status = 'FAILED_TERMINAL', error = $2
        WHERE id = $1`,
      [msg.action_execution_id, error]
    );

    await writeAuditEventTx(client, {
      tenantId: msg.tenant_id,
      issueId: msg.issue_id,
      eventType: AuditEventType.ACTION_EXECUTION_FAILED_TERMINAL,
      actorType: ActorType.SYSTEM,
      payload: {
        action_execution_id: msg.action_execution_id,
        action_type: msg.action_type,
        outbox_message_id: msg.id,
        effect_key: effectKey,
        error,
        attempt_count: msg.attempt_count,
      },
    });
  });
}

async function scheduleRetry(
  msg: OutboxRow,
  effectKey: string,
  error: string
): Promise<void> {
  const delayMs =
    RETRY_DELAYS_MS[Math.min(msg.attempt_count - 1, RETRY_DELAYS_MS.length - 1)];

  await withTransaction(async (client) => {
    await client.query(
      `UPDATE outbox_messages
          SET status = 'FAILED_RETRIABLE', next_attempt_at = $2
        WHERE id = $1`,
      [msg.id, new Date(Date.now() + delayMs).toISOString()]
    );
    await client.query(
      `UPDATE action_executions
          SET status = 'FAILED_RETRIABLE',
              attempt_count = $2,
              next_attempt_at = $3,
              error = $4
        WHERE id = $1`,
      [
        msg.action_execution_id,
        msg.attempt_count,
        new Date(Date.now() + delayMs).toISOString(),
        error,
      ]
    );
  });
}

// ─── Effects ledger ──────────────────────────────────────────────────────────

function primaryEffectKey(msg: OutboxRow): string {
  return msg.effects?.[0]?.effect_key ?? msg.idempotency_key;
}

/** Has this effect already reached a state that forbids re-dispatch? */
function isSettled(msg: OutboxRow, effectKey: string): boolean {
  if (msg.effect_settled_at) return true;
  return (msg.effects ?? []).some(
    (e) => e.effect_key === effectKey && SETTLED_STATES.includes(e.outcome_status)
  );
}

/**
 * Record that an uncertain effect was later resolved by reading provider state.
 *
 * This appends rather than overwriting: the fact that the outcome was once
 * unknown is itself the audit signal, and mutating the SENT_UNCERTAIN entry
 * into CONFIRMED would erase the only evidence that reconciliation happened.
 */
async function appendReconciledEntry(
  msg: OutboxRow,
  effectKey: string,
  providerId: string | null
): Promise<void> {
  await appendEffectEntry(msg.id, {
    ...buildEffectEntry(msg, effectKey, msg.attempt_count),
    outcome_status: EffectOutcomeStatus.CONFIRMED,
    provider_correlation_id: providerId,
    confirmed_at: new Date().toISOString(),
  });
}

async function appendEffectEntry(
  outboxId: string,
  entry: EffectLedgerEntry,
  client?: DbClient
): Promise<void> {
  const run = client ?? { query };
  await run.query(
    `UPDATE outbox_messages SET effects = effects || $2::jsonb WHERE id = $1`,
    [outboxId, JSON.stringify([entry])]
  );
}

/**
 * Update the most recent ledger entry for this effect key. Earlier attempt
 * entries are left untouched — the ledger is append-only history, not a
 * mutable status field.
 */
async function updateEffectStatus(
  outboxId: string,
  effectKey: string,
  status: EffectOutcomeStatus,
  providerId?: string | null,
  client?: DbClient
): Promise<void> {
  const run = client ?? { query };
  await run.query(
    `UPDATE outbox_messages
        SET effects = (
          SELECT jsonb_agg(
                   CASE
                     WHEN e.idx = last_match.idx
                     THEN e.value
                          || jsonb_build_object('outcome_status', $3::text)
                          || CASE WHEN $4::text IS NOT NULL
                                  THEN jsonb_build_object(
                                         'provider_correlation_id', $4::text,
                                         'confirmed_at', now())
                                  ELSE '{}'::jsonb END
                     ELSE e.value
                   END
                   ORDER BY e.idx
                 )
            FROM jsonb_array_elements(effects) WITH ORDINALITY AS e(value, idx)
            CROSS JOIN LATERAL (
              SELECT max(i.idx) AS idx
                FROM jsonb_array_elements(effects) WITH ORDINALITY AS i(value, idx)
               WHERE i.value ->> 'effect_key' = $2
            ) AS last_match
        )
      WHERE id = $1`,
    [outboxId, effectKey, status, providerId ?? null]
  );
}

async function markOutboxSent(outboxId: string): Promise<void> {
  await query(
    `UPDATE outbox_messages
        SET status = 'SENT', sent_at = now(), effect_settled_at = COALESCE(effect_settled_at, now())
      WHERE id = $1`,
    [outboxId]
  );
}

function buildEffectEntry(
  msg: OutboxRow,
  effectKey: string,
  attemptNumber: number
): EffectLedgerEntry {
  const payload = msg.payload as Record<string, unknown>;
  // Reuse the descriptors from the first entry so every attempt for an effect
  // reads consistently in the ledger.
  const first = (msg.effects ?? []).find((e) => e.effect_key === effectKey);
  return {
    effect_type: first?.effect_type ?? (payload.operation as string),
    target_system: msg.target_system as EffectLedgerEntry["target_system"],
    target_resource_id: first?.target_resource_id ?? effectKey,
    effect_key: effectKey,
    attempt_number: attemptNumber,
    outcome_status: EffectOutcomeStatus.INTENDED,
    provider_correlation_id: null,
    intended_at: new Date().toISOString(),
    sent_at: null,
    confirmed_at: null,
  };
}

// ─── External dispatch ───────────────────────────────────────────────────────

interface CallResult {
  providerId?: string | null;
}

async function executeExternalCall(
  msg: OutboxRow,
  effectKey: string
): Promise<CallResult> {
  const payload = msg.payload as Record<string, unknown>;
  const operation = payload.operation as string;

  if (msg.target_system === "zendesk") {
    return executeZendeskCall(operation, payload, msg.idempotency_key);
  }
  if (msg.target_system === "stripe") {
    return executeStripeCall(operation, payload, effectKey);
  }

  throw new PermanentError(`Unknown target_system: ${msg.target_system}`);
}

async function executeZendeskCall(
  operation: string,
  payload: Record<string, unknown>,
  idempotencyKey: string
): Promise<CallResult> {
  const adapter = new ZendeskAdapter();

  if (operation === "update_ticket_status") {
    await adapter.updateTicketStatus(
      payload.zendesk_ticket_id as string,
      payload.target_status as string
    );
    return { providerId: null };
  }

  if (operation === "post_comment") {
    const commentId = await adapter.postComment(
      payload.zendesk_ticket_id as string,
      payload.comment_body as string,
      idempotencyKey
    );
    return { providerId: `zd_comment_${commentId}` };
  }

  throw new PermanentError(`Unknown Zendesk operation: ${operation}`);
}

async function executeStripeCall(
  operation: string,
  payload: Record<string, unknown>,
  effectKey: string
): Promise<CallResult> {
  const adapter = new StripeAdapter();

  if (operation === "create_refund") {
    const refund = await adapter.createRefund({
      chargeId: payload.stripe_charge_id as string,
      amountCents: payload.refund_amount_cents as number,
      effectKey,
      reason: (payload.reason as string) ?? undefined,
    });
    return { providerId: refund.id };
  }

  if (operation === "verify_refund") {
    const refund = await adapter.getRefund(payload.refund_id as string);
    if (!refund) throw new PermanentError(`Refund ${payload.refund_id} not found`);
    return { providerId: refund.id };
  }

  throw new PermanentError(`Unknown Stripe operation: ${operation}`);
}

// ─── Reconciliation ──────────────────────────────────────────────────────────

/**
 * Did our refund actually land? Matched on metadata.effect_key rather than
 * amount, so an unrelated refund for the same charge is never mistaken for
 * ours. Returns the provider id when confirmed.
 */
async function reconcileStripeRefund(
  msg: OutboxRow,
  effectKey: string
): Promise<string | null> {
  try {
    const adapter = new StripeAdapter();
    const payload = msg.payload as Record<string, unknown>;
    const refund = await adapter.findRefundByEffectKey(
      payload.stripe_charge_id as string,
      effectKey
    );
    return refund?.id ?? null;
  } catch (err) {
    console.error("[worker] Stripe reconciliation read failed:", err);
    return null;
  }
}

async function reconcileZendeskStatus(msg: OutboxRow): Promise<boolean> {
  try {
    const adapter = new ZendeskAdapter();
    const payload = msg.payload as Record<string, unknown>;
    const currentStatus = await adapter.getTicketStatus(
      payload.zendesk_ticket_id as string
    );
    return currentStatus === payload.target_status;
  } catch {
    return false;
  }
}

async function reconcileZendeskComment(msg: OutboxRow): Promise<boolean> {
  try {
    const adapter = new ZendeskAdapter();
    const payload = msg.payload as Record<string, unknown>;
    const comments = await adapter.getRecentComments(
      payload.zendesk_ticket_id as string
    );
    const body = payload.comment_body as string;
    return comments.some((c) => c === body);
  } catch {
    return false;
  }
}

// ─── Card state read model ───────────────────────────────────────────────────

export async function rebuildCardState(
  tenantId: string,
  issueId: string
): Promise<void> {
  await query(
    `INSERT INTO issue_card_state
       (tenant_id, issue_id, zendesk_ticket_id, issue_state,
        refund_status, refund_amount_cents, refund_currency, refund_id,
        match_band, confidence_score, evidence_fetched_at, is_source_unavailable,
        last_rebuilt_at, updated_at)
     SELECT i.tenant_id, i.id, it.zendesk_ticket_id, i.state,
            en.refund_status, en.refund_amount_cents, en.refund_currency, en.refund_id,
            emr.match_band, emr.confidence_score, en.fetched_at,
            COALESCE(en.is_source_unavailable, false),
            now(), now()
       FROM issues i
       LEFT JOIN issue_tickets it
         ON it.issue_id = i.id AND it.is_primary = true AND it.is_deleted = false
       LEFT JOIN LATERAL (
         SELECT * FROM evidence_normalized e
          WHERE e.issue_id = i.id AND e.tenant_id = i.tenant_id
          ORDER BY e.fetched_at DESC
          LIMIT 1
       ) en ON true
       LEFT JOIN LATERAL (
         SELECT * FROM evidence_match_results m
          WHERE m.evidence_normalized_id = en.id
          ORDER BY m.computed_at DESC
          LIMIT 1
       ) emr ON true
      WHERE i.id = $1 AND i.tenant_id = $2
     ON CONFLICT (tenant_id, issue_id) DO UPDATE SET
       issue_state = EXCLUDED.issue_state,
       refund_status = EXCLUDED.refund_status,
       refund_amount_cents = EXCLUDED.refund_amount_cents,
       refund_currency = EXCLUDED.refund_currency,
       refund_id = EXCLUDED.refund_id,
       match_band = EXCLUDED.match_band,
       confidence_score = EXCLUDED.confidence_score,
       evidence_fetched_at = EXCLUDED.evidence_fetched_at,
       is_source_unavailable = EXCLUDED.is_source_unavailable,
       last_rebuilt_at = now(),
       updated_at = now()`,
    [issueId, tenantId]
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
