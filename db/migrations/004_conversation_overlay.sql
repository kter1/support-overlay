-- ─────────────────────────────────────────────────────────────────────────────
-- 004 — the conversation, and where each annotation sits inside it
--
-- The extractor has always computed character offsets for every match
-- (Provenance.start/.end) and the ingestion pipeline has always read the full
-- ticket thread. Neither was kept. What reached the card was a set of detached
-- fragments — "order #1001", "$49.99" — with no way back to the sentence they
-- came from, so the panel could only ever list them beside the message rather
-- than mark them inside it.
--
-- This stores both halves: the text, and the spans.
-- ─────────────────────────────────────────────────────────────────────────────

-- ─── The thread ──────────────────────────────────────────────────────────────
--
-- One row per piece of text the extractor read, keyed by the same source_id it
-- records in provenance, so an annotation joins to its message by that id.

CREATE TABLE issue_messages (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     UUID NOT NULL REFERENCES tenants(id),
  issue_id      UUID NOT NULL REFERENCES issues(id),

  -- 'ticket:10005:subject', 'ticket:10005:description', 'comment:m1'
  source_id     TEXT NOT NULL,
  kind          TEXT NOT NULL
    CHECK (kind IN ('ticket_subject','ticket_description','comment')),
  author_role   TEXT NOT NULL CHECK (author_role IN ('customer','agent')),

  -- Verbatim message text. Nullable because it is erasable — see below.
  body          TEXT,

  -- Thread order. Assigned from the extractor's chronological sort rather than
  -- re-derived from created_at, so what is displayed matches what was read.
  position      INT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL,

  -- This column holds verbatim customer writing, which is the most sensitive
  -- data this system has stored so far. Same shape as the redaction fields on
  -- evidence_raw_snapshots and audit_log: null the text, keep the row, record
  -- why. A redacted message must still render — as a tombstone with its
  -- annotations suppressed — because a message that silently disappears looks
  -- like a bug rather than a deletion.
  body_redacted_at      TIMESTAMPTZ,
  body_redaction_reason TEXT,

  UNIQUE (tenant_id, issue_id, source_id)
);

CREATE INDEX idx_issue_messages_thread
  ON issue_messages (tenant_id, issue_id, position);

-- ─── The spans ───────────────────────────────────────────────────────────────
--
-- Annotations live on issue_context rather than in their own table: they are
-- always read as a set with the thread, never queried individually, and their
-- shape is the extractor's contract. Shredding them into columns would freeze
-- that contract in the schema.
--
-- Each entry carries source_id plus start/end offsets into that message's body,
-- which is what makes in-place marking possible.

ALTER TABLE issue_context
  ADD COLUMN annotations JSONB NOT NULL DEFAULT '[]'::jsonb;

-- `highlights` held the top six signals with no offsets. Everything it carried
-- is in `annotations`, which holds all of them; keeping both would leave two
-- sources of truth that drift.
ALTER TABLE issue_context
  DROP COLUMN highlights;
