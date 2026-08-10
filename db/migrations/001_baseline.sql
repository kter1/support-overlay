-- ============================================================================
-- support-overlay — Baseline Schema
--
-- This is the single authoritative schema migration. It supersedes the previous
-- 000_schema_reference.sql plus the 001-005 split files, which disagreed with
-- each other on column names and were never all applied: the migration runner
-- special-cased 000 and skipped the rest, so edits to 001-005 silently no-oped.
--
-- Column names here follow the application code and the shared vocabulary in
-- packages/shared/src/index.ts. Where the old files diverged, the code wins.
--
-- Adding a migration: create db/migrations/002_*.sql. Every file in this
-- directory is applied in filename order and recorded in _migrations.
-- ============================================================================

-- gen_random_uuid() is in Postgres core as of 13, so no pgcrypto extension is
-- needed. Requiring it would also block running this schema anywhere the
-- extension is unavailable, such as the in-process Postgres used by the tests.

-- ─── Tenants ─────────────────────────────────────────────────────────────────

CREATE TABLE tenants (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name         TEXT NOT NULL,
  subdomain    TEXT NOT NULL UNIQUE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ─── Tenant Config ───────────────────────────────────────────────────────────

CREATE TABLE tenant_config (
  id                               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                        UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  -- Approval toggle — OFF by default. When false the policy engine must not
  -- return REQUIRES_APPROVAL.
  approvals_enabled                BOOLEAN NOT NULL DEFAULT false,
  evidence_freshness_seconds       INT NOT NULL DEFAULT 300,
  refund_amount_tolerance_pct      NUMERIC(5,2) NOT NULL DEFAULT 2.0,
  reopen_gate_count                INT NOT NULL DEFAULT 3,
  manager_approval_threshold_cents INT NOT NULL DEFAULT 5000,
  manager_approval_group_id        TEXT,
  zendesk_subdomain                TEXT,
  zendesk_agent_group_id           TEXT,
  macro_prefix_resolved            TEXT NOT NULL DEFAULT '',
  macro_prefix_pending             TEXT NOT NULL DEFAULT '',
  created_at                       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                       TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id)
);

-- ─── Tenant Integrations ─────────────────────────────────────────────────────
-- Per-tenant provider credentials and webhook signing secrets. Webhook
-- verification reads webhook_secret from here; there is no global fallback.

CREATE TABLE tenant_integrations (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  source_system  TEXT NOT NULL CHECK (source_system IN ('zendesk','stripe','shopify')),
  credentials    JSONB NOT NULL DEFAULT '{}',
  webhook_secret TEXT,
  is_active      BOOLEAN NOT NULL DEFAULT true,
  use_simulator  BOOLEAN NOT NULL DEFAULT true,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, source_system)
);

-- ─── API Credentials ─────────────────────────────────────────────────────────
-- Bearer tokens are stored as SHA-256 hashes, never in plaintext. A token maps
-- to exactly one tenant, which is how request tenancy is established — callers
-- do not supply their own tenant id.

CREATE TABLE api_credentials (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  -- 'agent'    → sidebar/agent endpoints (actions, card, approvals, metrics)
  -- 'operator' → /ops repair endpoints
  -- 'webhook'  → webhook ingestion endpoints
  role         TEXT NOT NULL CHECK (role IN ('agent','operator','webhook')),
  token_sha256 TEXT NOT NULL UNIQUE,
  -- Stable identifier for the principal, written to audit_log.actor_id.
  principal_id TEXT NOT NULL,
  description  TEXT,
  is_active    BOOLEAN NOT NULL DEFAULT true,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at TIMESTAMPTZ,
  revoked_at   TIMESTAMPTZ
);

CREATE INDEX idx_api_credentials_lookup ON api_credentials (token_sha256)
  WHERE is_active = true AND revoked_at IS NULL;
CREATE INDEX idx_api_credentials_tenant ON api_credentials (tenant_id, role);

-- ─── Manager Grants ──────────────────────────────────────────────────────────
-- Which principals may approve. Approval endpoints derive the manager from the
-- authenticated principal and check it here; manager_id is never accepted from
-- a request body.

CREATE TABLE manager_grants (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  principal_id TEXT NOT NULL,
  queue_id     TEXT,
  is_active    BOOLEAN NOT NULL DEFAULT true,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, principal_id)
);

-- ─── Issues ──────────────────────────────────────────────────────────────────
-- Four canonical states, matching IssueState in packages/shared/src/index.ts.
-- Reopen is an event (reopen_events), never a state.

CREATE TABLE issues (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      UUID NOT NULL REFERENCES tenants(id),
  -- customer fields nullable: nulled on GDPR/CCPA erasure
  customer_id    TEXT,
  customer_email TEXT,
  state          TEXT NOT NULL DEFAULT 'OPEN'
    CHECK (state IN ('OPEN','AWAITING_FULFILLMENT','BLOCKED','RESOLVED')),
  -- optimistic concurrency control for state writes
  lock_version   INT NOT NULL DEFAULT 0,
  playbook_id    TEXT NOT NULL DEFAULT 'refund_v1',
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_issues_tenant_state ON issues (tenant_id, state);
CREATE INDEX idx_issues_tenant_customer ON issues (tenant_id, customer_id)
  WHERE customer_id IS NOT NULL;

-- ─── Issue Tickets (Zendesk linkage) ─────────────────────────────────────────

CREATE TABLE issue_tickets (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          UUID NOT NULL REFERENCES tenants(id),
  issue_id           UUID NOT NULL REFERENCES issues(id),
  zendesk_ticket_id  TEXT NOT NULL,
  is_primary         BOOLEAN NOT NULL DEFAULT false,
  -- is_deleted: Zendesk ticket deleted. Metadata row preserved; the issue and
  -- its evidence are never deleted.
  is_deleted         BOOLEAN NOT NULL DEFAULT false,
  deleted_at         TIMESTAMPTZ,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, zendesk_ticket_id)
);

CREATE INDEX idx_issue_tickets_active ON issue_tickets (tenant_id, is_deleted)
  WHERE is_deleted = false;
CREATE INDEX idx_issue_tickets_by_issue ON issue_tickets (issue_id);

-- ─── Reopen Events ───────────────────────────────────────────────────────────

CREATE TABLE reopen_events (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    UUID NOT NULL REFERENCES tenants(id),
  issue_id     UUID NOT NULL REFERENCES issues(id),
  reason       TEXT,
  source       TEXT NOT NULL DEFAULT 'zendesk',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_reopen_events_issue ON reopen_events (tenant_id, issue_id, created_at DESC);

-- ─── Evidence: Raw Snapshots ─────────────────────────────────────────────────

CREATE TABLE evidence_raw_snapshots (
  id                        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                 UUID NOT NULL REFERENCES tenants(id),
  issue_id                  UUID NOT NULL REFERENCES issues(id),
  source_system             TEXT NOT NULL CHECK (source_system IN ('zendesk','stripe','shopify')),
  source_record_id          TEXT NOT NULL,
  normalizer_version        TEXT NOT NULL,
  -- raw_data nullable: nulled after retention window or GDPR erasure
  raw_data                  JSONB,
  raw_data_redacted_at      TIMESTAMPTZ,
  raw_data_redaction_reason TEXT,
  raw_data_hash             TEXT,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_evidence_raw_by_issue ON evidence_raw_snapshots (tenant_id, issue_id);

-- ─── Evidence: Normalized ────────────────────────────────────────────────────
-- refund_* columns are projected out of normalized_data so the policy engine
-- and card read model can query them without parsing JSON.

CREATE TABLE evidence_normalized (
  id                        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                 UUID NOT NULL REFERENCES tenants(id),
  issue_id                  UUID NOT NULL REFERENCES issues(id),
  source_system             TEXT NOT NULL CHECK (source_system IN ('zendesk','stripe','shopify')),
  source_record_id          TEXT NOT NULL,
  raw_snapshot_id           UUID REFERENCES evidence_raw_snapshots(id),
  normalizer_version        TEXT NOT NULL,
  normalized_data           JSONB NOT NULL DEFAULT '{}',
  refund_status             TEXT CHECK (refund_status IN ('succeeded','pending','failed','not_found')),
  refund_amount_cents       INT,
  refund_currency           TEXT,
  refund_id                 TEXT,
  order_id                  TEXT,
  charge_id                 TEXT,
  fetched_at                TIMESTAMPTZ NOT NULL,
  -- is_source_unavailable: persisted tombstone/archival flag. NOT time-based
  -- freshness — that is computed at read time from fetched_at.
  is_source_unavailable     BOOLEAN NOT NULL DEFAULT false,
  source_unavailable_reason TEXT,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_evidence_normalized_issue ON evidence_normalized (tenant_id, issue_id, fetched_at DESC);
CREATE INDEX idx_evidence_normalized_source ON evidence_normalized (tenant_id, source_system, source_record_id);

-- ─── Evidence: Match Results ─────────────────────────────────────────────────

CREATE TABLE evidence_match_results (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id               UUID NOT NULL REFERENCES tenants(id),
  issue_id                UUID NOT NULL REFERENCES issues(id),
  evidence_normalized_id  UUID REFERENCES evidence_normalized(id) ON DELETE CASCADE,
  match_algorithm_version TEXT NOT NULL,
  match_band              TEXT NOT NULL CHECK (match_band IN ('EXACT','HIGH','MEDIUM','LOW','NO_MATCH')),
  confidence_score        NUMERIC(5,4) NOT NULL CHECK (confidence_score >= 0 AND confidence_score <= 1),
  matched_fields          TEXT[] NOT NULL DEFAULT '{}',
  -- Non-accusatory explanation shown to agents.
  match_notes             TEXT,
  computed_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_match_results_issue ON evidence_match_results (tenant_id, issue_id, computed_at DESC);
CREATE INDEX idx_match_results_evidence ON evidence_match_results (evidence_normalized_id);

-- ─── Issue Card State (Read Model) ───────────────────────────────────────────

CREATE TABLE issue_card_state (
  id                               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                        UUID NOT NULL REFERENCES tenants(id),
  issue_id                         UUID NOT NULL REFERENCES issues(id),
  zendesk_ticket_id                TEXT,
  issue_state                      TEXT NOT NULL,
  refund_status                    TEXT,
  refund_amount_cents              INT,
  refund_currency                  TEXT,
  refund_id                        TEXT,
  match_band                       TEXT,
  confidence_score                 NUMERIC(5,4),
  evidence_fetched_at              TIMESTAMPTZ,
  -- mirrors evidence_normalized.is_source_unavailable; not a freshness flag
  is_source_unavailable            BOOLEAN NOT NULL DEFAULT false,
  pending_action_execution_id      UUID,
  last_action_type                 TEXT,
  last_action_completed_at         TIMESTAMPTZ,
  pending_approval_request_id      UUID,
  evidence_summary                 JSONB,
  last_rebuilt_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
  rebuilt_from_action_execution_id UUID,
  updated_at                       TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, issue_id)
);

CREATE INDEX idx_card_state_ticket ON issue_card_state (tenant_id, zendesk_ticket_id);

-- ─── Inbound Events ──────────────────────────────────────────────────────────

CREATE TABLE inbound_events (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                UUID NOT NULL REFERENCES tenants(id),
  source_system            TEXT NOT NULL CHECK (source_system IN ('zendesk','stripe','shopify')),
  external_event_id        TEXT NOT NULL,
  -- authoritative timestamp from the source system; not all providers send one
  source_event_at          TIMESTAMPTZ,
  source_event_type        TEXT,
  payload                  JSONB,
  payload_redacted_at      TIMESTAMPTZ,
  payload_redaction_reason TEXT,
  payload_hash             TEXT,
  signature_valid          BOOLEAN NOT NULL,
  received_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at             TIMESTAMPTZ,
  status                   TEXT NOT NULL DEFAULT 'RECEIVED'
    CHECK (status IN ('RECEIVED','PROCESSING','PROCESSED','FAILED','DUPLICATE')),
  error                    TEXT,
  correlation_id           TEXT,
  UNIQUE (tenant_id, source_system, external_event_id)
);

CREATE INDEX idx_inbound_events_status ON inbound_events (tenant_id, status, received_at);
CREATE INDEX idx_inbound_events_source_at ON inbound_events (tenant_id, source_system, source_event_at)
  WHERE source_event_at IS NOT NULL;

-- ─── Approval Requests ───────────────────────────────────────────────────────

CREATE TABLE approval_requests (
  id                        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                 UUID NOT NULL REFERENCES tenants(id),
  issue_id                  UUID NOT NULL REFERENCES issues(id),
  action_type               TEXT NOT NULL,
  requested_by_agent_id     TEXT NOT NULL,
  -- what will be executed when approved
  action_payload            JSONB NOT NULL DEFAULT '{}',
  status                    TEXT NOT NULL DEFAULT 'PENDING'
    CHECK (status IN ('PENDING','APPROVED','DENIED','EXPIRED','CANCELLED')),
  approval_policy_code      TEXT NOT NULL,
  policy_version            TEXT,
  assigned_queue            TEXT,
  assigned_manager_id       TEXT,
  reason                    TEXT,
  approved_at               TIMESTAMPTZ,
  denied_at                 TIMESTAMPTZ,
  expires_at                TIMESTAMPTZ,
  linked_action_execution_id UUID,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_approval_requests_issue ON approval_requests (tenant_id, issue_id, status);
CREATE INDEX idx_approval_requests_pending ON approval_requests (tenant_id, status, expires_at)
  WHERE status = 'PENDING';

-- ─── Action Executions ───────────────────────────────────────────────────────

CREATE TABLE action_executions (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id              UUID NOT NULL REFERENCES tenants(id),
  issue_id               UUID NOT NULL REFERENCES issues(id),
  action_type            TEXT NOT NULL,
  requested_by_agent_id  TEXT NOT NULL,
  idempotency_key        TEXT NOT NULL,
  -- planned_state: intended issues.state after this action completes. NOT
  -- written to state_transitions until the execution confirms. On
  -- FAILED_TERMINAL it stays unwritten.
  planned_state          TEXT,
  status                 TEXT NOT NULL DEFAULT 'PENDING'
    CHECK (status IN ('PENDING','IN_PROGRESS','COMPLETED','FAILED_RETRIABLE','FAILED_TERMINAL')),
  result_payload         JSONB,
  error                  TEXT,
  attempt_count          INT NOT NULL DEFAULT 0,
  next_attempt_at        TIMESTAMPTZ,
  policy_rule_id         TEXT,
  policy_version         TEXT,
  approval_request_id    UUID REFERENCES approval_requests(id),
  -- Reconciliation metadata. Status stays FAILED_TERMINAL; these fields record
  -- manual operator resolution and never change the status.
  reconciled_at          TIMESTAMPTZ,
  reconciled_by          TEXT,
  reconciliation_outcome TEXT CHECK (reconciliation_outcome IN
    ('CONFIRMED_OCCURRED','CONFIRMED_NOT_OCCURRED','UNKNOWN')),
  investigation_notes    TEXT,
  corrective_action_taken TEXT,
  correlation_id         TEXT,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at           TIMESTAMPTZ,
  -- Idempotency is scoped per tenant: one tenant's key can never collide with
  -- another's, and a replayed submit resolves to the same execution.
  UNIQUE (tenant_id, idempotency_key)
);

-- Each approval maps to at most one execution.
CREATE UNIQUE INDEX uix_action_executions_approval
  ON action_executions (approval_request_id)
  WHERE approval_request_id IS NOT NULL;

CREATE INDEX idx_action_executions_issue ON action_executions (tenant_id, issue_id);
CREATE INDEX idx_action_executions_status ON action_executions (tenant_id, status, next_attempt_at)
  WHERE status IN ('PENDING','FAILED_RETRIABLE');

ALTER TABLE approval_requests
  ADD CONSTRAINT fk_approval_linked_execution
  FOREIGN KEY (linked_action_execution_id) REFERENCES action_executions(id);

-- ─── Outbox Messages ─────────────────────────────────────────────────────────

CREATE TABLE outbox_messages (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           UUID NOT NULL REFERENCES tenants(id),
  action_execution_id UUID REFERENCES action_executions(id),
  target_system       TEXT NOT NULL CHECK (target_system IN ('zendesk','stripe','shopify')),
  payload             JSONB NOT NULL,
  idempotency_key     TEXT NOT NULL,
  -- IN_PROGRESS is the claim marker: a worker flips a row to it in the same
  -- statement that selects it, so no second worker can claim the same row.
  -- BLOCKED_OPERATOR means the outcome is unknown and a human must reconcile —
  -- distinct from FAILED_TERMINAL, which means the effect definitively failed.
  status              TEXT NOT NULL DEFAULT 'PENDING'
    CHECK (status IN ('PENDING','IN_PROGRESS','SENT','FAILED_RETRIABLE',
                      'FAILED_TERMINAL','BLOCKED_OPERATOR')),
  attempt_count       INT NOT NULL DEFAULT 0,
  next_attempt_at     TIMESTAMPTZ,
  sent_at             TIMESTAMPTZ,
  -- Effects ledger: append-only array of EffectLedgerEntry records. Prior
  -- attempt entries are never deleted. Dedupe keys off effect_key.
  effects             JSONB NOT NULL DEFAULT '[]'::jsonb,
  -- Set once a terminal effect is confirmed, so a replayed claim cannot
  -- re-dispatch the same side effect.
  effect_settled_at   TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- One outbox row per distinct side effect per execution.
  UNIQUE (tenant_id, idempotency_key)
);

CREATE INDEX idx_outbox_pending ON outbox_messages (tenant_id, status, next_attempt_at)
  WHERE status IN ('PENDING','FAILED_RETRIABLE');
CREATE INDEX idx_outbox_by_execution ON outbox_messages (action_execution_id);

-- ─── Risk Signals ────────────────────────────────────────────────────────────
-- INSERT-ONLY. severity drives AbuseSeverity in the policy engine.

CREATE TABLE risk_signals (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID NOT NULL REFERENCES tenants(id),
  issue_id    UUID NOT NULL REFERENCES issues(id),
  signal_type TEXT NOT NULL,
  signal_data JSONB NOT NULL DEFAULT '{}',
  severity    TEXT NOT NULL DEFAULT 'NONE'
    CHECK (severity IN ('NONE','LOW','MEDIUM','HIGH')),
  source      TEXT NOT NULL DEFAULT 'system',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_risk_signals_issue ON risk_signals (tenant_id, issue_id, created_at DESC);

-- ─── State Transitions ───────────────────────────────────────────────────────
-- INSERT-ONLY. Records APPLIED canonical state changes, written only after an
-- execution confirms — never on intent. On FAILED_TERMINAL no row is written
-- and issues.state is unchanged.

CREATE TABLE state_transitions (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           UUID NOT NULL REFERENCES tenants(id),
  issue_id            UUID NOT NULL REFERENCES issues(id),
  from_state          TEXT NOT NULL,
  to_state            TEXT NOT NULL,
  action_execution_id UUID REFERENCES action_executions(id),
  trigger_event       TEXT NOT NULL,
  actor_type          TEXT NOT NULL CHECK (actor_type IN ('agent','system','webhook','operator')),
  actor_id            TEXT,
  note                TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_state_transitions_issue ON state_transitions (tenant_id, issue_id, created_at);

CREATE OR REPLACE FUNCTION prevent_state_transition_mutation()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'state_transitions is INSERT-ONLY. UPDATE and DELETE are forbidden.';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER enforce_state_transitions_immutability
  BEFORE UPDATE OR DELETE ON state_transitions
  FOR EACH ROW EXECUTE FUNCTION prevent_state_transition_mutation();

-- ─── Audit Log ───────────────────────────────────────────────────────────────
-- IMMUTABLE. No UPDATE or DELETE ever permitted.

CREATE TABLE audit_log (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id               UUID NOT NULL REFERENCES tenants(id),
  issue_id                UUID REFERENCES issues(id),
  event_type              TEXT NOT NULL,
  actor_type              TEXT CHECK (actor_type IN ('agent','system','webhook','operator')),
  actor_id                TEXT,
  payload                 JSONB,
  policy_rule_id          TEXT,
  policy_version          TEXT,
  normalizer_version      TEXT,
  match_algorithm_version TEXT,
  -- links inbound event → action → outbox → audit entries
  correlation_id          TEXT,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION prevent_audit_log_mutation()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'audit_log is IMMUTABLE. UPDATE and DELETE are forbidden.';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER enforce_audit_log_immutability
  BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION prevent_audit_log_mutation();

CREATE INDEX idx_audit_log_issue ON audit_log (tenant_id, issue_id, created_at DESC);
CREATE INDEX idx_audit_log_correlation ON audit_log (tenant_id, correlation_id)
  WHERE correlation_id IS NOT NULL;
CREATE INDEX idx_audit_log_event_type ON audit_log (tenant_id, event_type, created_at DESC);
