/**
 * @iisl/api — Audit Log Service
 * VALIDATION: [STATIC-CONSISTENT]
 *
 * All writes to audit_log go through this service.
 * The table is INSERT-only (trigger prevents UPDATE/DELETE at DB level).
 * Every event must include event_type and actor_type.
 * policy_rule_id must be included for all policy evaluation events.
 *
 * Spec reference: Section 2.11, Section 1.1
 */
import { query, DbClient } from "../db/pool";
import { ActorType, AuditEventType } from "@iisl/shared";

// Re-exported so existing call sites can keep importing it from this module.
export { AuditEventType };

export interface AuditEvent {
  tenantId: string;
  issueId?: string;
  eventType: string;
  actorType: ActorType;
  actorId?: string;
  payload?: Record<string, unknown>;
  policyRuleId?: string;
  policyVersion?: string;
  normalizerVersion?: string;
  matchAlgorithmVersion?: string;
}

/**
 * Write an audit event. Uses pool (no transaction needed for audit log writes
 * that are outside a transaction context).
 */
export async function writeAuditEvent(event: AuditEvent): Promise<void> {
  await query(
    `INSERT INTO audit_log
       (tenant_id, issue_id, event_type, actor_type, actor_id, payload,
        policy_rule_id, policy_version, normalizer_version, match_algorithm_version)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [
      event.tenantId,
      event.issueId ?? null,
      event.eventType,
      event.actorType,
      event.actorId ?? null,
      event.payload ? JSON.stringify(event.payload) : null,
      event.policyRuleId ?? null,
      event.policyVersion ?? null,
      event.normalizerVersion ?? null,
      event.matchAlgorithmVersion ?? null,
    ]
  );
}

/**
 * Write an audit event within an existing transaction.
 * Use this when the audit write must be atomic with other operations.
 */
export async function writeAuditEventTx(
  client: DbClient,
  event: AuditEvent
): Promise<void> {
  await client.query(
    `INSERT INTO audit_log
       (tenant_id, issue_id, event_type, actor_type, actor_id, payload,
        policy_rule_id, policy_version, normalizer_version, match_algorithm_version)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [
      event.tenantId,
      event.issueId ?? null,
      event.eventType,
      event.actorType,
      event.actorId ?? null,
      event.payload ? JSON.stringify(event.payload) : null,
      event.policyRuleId ?? null,
      event.policyVersion ?? null,
      event.normalizerVersion ?? null,
      event.matchAlgorithmVersion ?? null,
    ]
  );
}
