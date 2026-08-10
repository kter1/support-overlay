-- ─────────────────────────────────────────────────────────────────────────────
-- 002 — extracted conversation context, persisted for reading
--
-- Extraction already ran and already wrote an audit_log entry. That entry is the
-- immutable record of *why* a lookup happened, and it must stay append-only.
-- But it is the wrong thing to read from: answering "what did this customer
-- say?" would mean scanning an ever-growing event table for the newest row of
-- one type and trusting its payload shape.
--
-- So this table is the read model — one current row per issue, replaced on
-- re-ingestion — and audit_log remains the history. Same split as
-- evidence_normalized vs evidence_raw_snapshots.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE issue_context (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         UUID NOT NULL REFERENCES tenants(id),
  issue_id          UUID NOT NULL REFERENCES issues(id),

  extractor_version TEXT NOT NULL,

  -- The strongest single reference of each kind, used to drive provider lookups.
  payment_reference     TEXT,
  order_reference       TEXT,
  claimed_amount_cents  INT,
  claimed_currency      TEXT,
  primary_ask           TEXT,

  -- Every signal, ranked by salience, each carrying the span of text it came
  -- from. Stored whole because the shape is the extractor's contract and
  -- shredding it into columns would freeze that contract in the schema.
  highlights        JSONB NOT NULL DEFAULT '[]'::jsonb,

  -- How much of the conversation was read, so a thin result is distinguishable
  -- from an unread one.
  message_count     INT NOT NULL DEFAULT 0,

  extracted_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE (tenant_id, issue_id)
);

CREATE INDEX idx_issue_context_issue ON issue_context (tenant_id, issue_id);

-- History lookups walk backwards from one customer to their earlier issues, so
-- the ordering column belongs in the index.
CREATE INDEX idx_issues_customer_recent
  ON issues (tenant_id, customer_id, created_at DESC)
  WHERE customer_id IS NOT NULL;
