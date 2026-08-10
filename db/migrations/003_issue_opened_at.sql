-- ─────────────────────────────────────────────────────────────────────────────
-- 003 — when the customer actually got in touch
--
-- `issues.created_at` is when we wrote the row. For an issue created by a live
-- webhook those are seconds apart, so the distinction never showed up — but a
-- backfill, a replayed event, or a webhook delivered after an outage can write
-- a row days after the customer wrote in.
--
-- History puts a date in front of an agent ("refunded on ticket #900, Jan 16").
-- If that date is the row's insert time, the agent is being told something
-- false with the same confidence as everything else on the card. So the
-- customer-facing event time gets its own column and `created_at` goes back to
-- meaning only what it says.
--
-- Backfilled from created_at: for every row written so far the two were in fact
-- the same moment.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE issues
  ADD COLUMN opened_at TIMESTAMPTZ;

UPDATE issues SET opened_at = created_at WHERE opened_at IS NULL;

ALTER TABLE issues
  ALTER COLUMN opened_at SET NOT NULL,
  ALTER COLUMN opened_at SET DEFAULT now();

-- History reads newest-first per customer; this is the ordering it uses.
CREATE INDEX idx_issues_customer_opened
  ON issues (tenant_id, customer_id, opened_at DESC)
  WHERE customer_id IS NOT NULL;

DROP INDEX IF EXISTS idx_issues_customer_recent;
