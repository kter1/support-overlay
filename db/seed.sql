-- ============================================================================
-- support-overlay — Demo seed data
--
-- Three scenarios covering the happy path, degraded evidence, and an execution
-- awaiting operator reconciliation. Run after db/migrations/001_baseline.sql.
--
-- API credentials are NOT seeded here — scripts/seed.ts provisions them from
-- the AGENT_TOKEN / OPERATOR_TOKEN environment variables, so no usable token
-- is ever committed to the repository.
-- ============================================================================

-- ─── Demo Tenant ─────────────────────────────────────────────────────────────

INSERT INTO tenants (id, name, subdomain) VALUES
  ('00000000-0000-0000-0000-000000000001', 'Acme Support Co', 'acme');

INSERT INTO tenant_config (
  tenant_id,
  approvals_enabled,
  evidence_freshness_seconds,
  refund_amount_tolerance_pct,
  reopen_gate_count,
  manager_approval_threshold_cents,
  manager_approval_group_id,
  zendesk_subdomain
) VALUES (
  '00000000-0000-0000-0000-000000000001',
  false,   -- approvals OFF by default
  300,     -- 5-minute freshness window
  2.0,
  3,
  5000,    -- $50.00 threshold
  'managers-group-123',
  'acme'
);

INSERT INTO tenant_integrations (tenant_id, source_system, use_simulator) VALUES
  ('00000000-0000-0000-0000-000000000001', 'zendesk', true),
  ('00000000-0000-0000-0000-000000000001', 'stripe',  true),
  ('00000000-0000-0000-0000-000000000001', 'shopify', true);

-- The operator principal may approve. Approval endpoints check this rather than
-- trusting a manager id from the request body.
INSERT INTO manager_grants (tenant_id, principal_id) VALUES
  ('00000000-0000-0000-0000-000000000001', 'operator-demo');

-- ─── Scenario 1: Happy Path — Refund Confirmed ───────────────────────────────
-- Ticket 10001: High-confidence match, refund succeeded in Stripe
-- Expected demo: agent sees CLOSE button, clicks it, issue resolves in <3s

INSERT INTO issues (id, tenant_id, customer_id, customer_email, state) VALUES
  ('10000000-0000-0000-0000-000000000001',
   '00000000-0000-0000-0000-000000000001',
   'cust_happy_001',
   'alice@example.com',
   'OPEN');

INSERT INTO issue_tickets (tenant_id, issue_id, zendesk_ticket_id, is_primary) VALUES
  ('00000000-0000-0000-0000-000000000001',
   '10000000-0000-0000-0000-000000000001',
   '10001', true);

INSERT INTO evidence_raw_snapshots (
  id, tenant_id, issue_id, source_system, source_record_id, normalizer_version, raw_data
) VALUES
  ('20000000-0000-0000-0000-000000000001',
   '00000000-0000-0000-0000-000000000001',
   '10000000-0000-0000-0000-000000000001',
   'stripe', 're_happy_001', 'v1',
   '{"id":"re_happy_001","amount":4999,"currency":"usd","status":"succeeded","charge":"ch_001","created":1704067200}'),
  ('20000000-0000-0000-0000-000000000002',
   '00000000-0000-0000-0000-000000000001',
   '10000000-0000-0000-0000-000000000001',
   'shopify', 'order_happy_001', 'v1',
   '{"id":"order_happy_001","name":"#1001","financial_status":"refunded","fulfillment_status":"fulfilled","total_price":"49.99","currency":"USD","created_at":"2024-01-01T00:00:00Z"}');

INSERT INTO evidence_normalized (
  id, tenant_id, issue_id, source_system, source_record_id, raw_snapshot_id,
  normalizer_version, normalized_data,
  refund_status, refund_amount_cents, refund_currency, refund_id, charge_id,
  fetched_at, is_source_unavailable
) VALUES
  ('50000000-0000-0000-0000-000000000001',
   '00000000-0000-0000-0000-000000000001',
   '10000000-0000-0000-0000-000000000001',
   'stripe', 're_happy_001',
   '20000000-0000-0000-0000-000000000001',
   'v1',
   '{"stripeRefundId":"re_happy_001","stripeRefundStatus":"succeeded","stripeChargeAmount":4999,"stripeCurrency":"usd","refundAmount":4999,"refundCurrency":"usd"}',
   'succeeded', 4999, 'usd', 're_happy_001', 'ch_001',
   now(), false),
  ('50000000-0000-0000-0000-000000000002',
   '00000000-0000-0000-0000-000000000001',
   '10000000-0000-0000-0000-000000000001',
   'shopify', 'order_happy_001',
   '20000000-0000-0000-0000-000000000002',
   'v1',
   '{"shopifyOrderId":"order_happy_001","shopifyOrderName":"#1001","shopifyFinancialStatus":"refunded","shopifyFulfillmentStatus":"fulfilled","shopifyOrderTotal":4999,"shopifyOrderCurrency":"USD"}',
   null, 4999, 'usd', null, null,
   now(), false);

INSERT INTO evidence_match_results (
  tenant_id, issue_id, evidence_normalized_id, match_algorithm_version, match_band,
  confidence_score, matched_fields, match_notes
) VALUES
  ('00000000-0000-0000-0000-000000000001',
   '10000000-0000-0000-0000-000000000001',
   '50000000-0000-0000-0000-000000000001',
   'v1', 'HIGH', 0.94,
   ARRAY['refund_amount','currency','financial_status'],
   'Stripe refund and Shopify order amounts match within tolerance. Financial status confirms refund posted.');

INSERT INTO issue_card_state (
  tenant_id, issue_id, zendesk_ticket_id, issue_state,
  match_band, confidence_score, evidence_fetched_at,
  is_source_unavailable, evidence_summary
) VALUES
  ('00000000-0000-0000-0000-000000000001',
   '10000000-0000-0000-0000-000000000001',
   '10001', 'OPEN', 'HIGH', 0.94, now(), false,
   '{"stripeRefundStatus":"succeeded","stripeChargeAmount":4999,"shopifyOrderName":"#1001","shopifyFinancialStatus":"refunded","refundAmount":4999,"currency":"usd"}');

-- ─── Scenario 2: Degraded Mode — Source Unavailable ──────────────────────────
-- Ticket 10002: Shopify order archived. Stripe data present but Shopify unavailable.
-- Expected demo: agent sees soft warning, PROCEED option still available

INSERT INTO issues (id, tenant_id, customer_id, customer_email, state) VALUES
  ('10000000-0000-0000-0000-000000000002',
   '00000000-0000-0000-0000-000000000001',
   'cust_degraded_001',
   'bob@example.com',
   'OPEN');

INSERT INTO issue_tickets (tenant_id, issue_id, zendesk_ticket_id, is_primary) VALUES
  ('00000000-0000-0000-0000-000000000001',
   '10000000-0000-0000-0000-000000000002',
   '10002', true);

INSERT INTO evidence_raw_snapshots (
  id, tenant_id, issue_id, source_system, source_record_id, normalizer_version, raw_data
) VALUES
  ('20000000-0000-0000-0000-000000000003',
   '00000000-0000-0000-0000-000000000001',
   '10000000-0000-0000-0000-000000000002',
   'stripe', 're_degraded_001', 'v1',
   '{"id":"re_degraded_001","amount":7500,"currency":"usd","status":"pending","charge":"ch_002","created":1704067200}'),
  ('20000000-0000-0000-0000-000000000004',
   '00000000-0000-0000-0000-000000000001',
   '10000000-0000-0000-0000-000000000002',
   'shopify', 'order_archived_001', 'v1',
   null);  -- raw_data nulled because source is archived

-- Mark Shopify snapshot raw data as unavailable
UPDATE evidence_raw_snapshots
SET raw_data_redaction_reason = 'source_archived'
WHERE id = '20000000-0000-0000-0000-000000000004';

INSERT INTO evidence_normalized (
  id, tenant_id, issue_id, source_system, source_record_id, raw_snapshot_id,
  normalizer_version, normalized_data,
  refund_status, refund_amount_cents, refund_currency, refund_id, charge_id,
  fetched_at, is_source_unavailable, source_unavailable_reason
) VALUES
  ('50000000-0000-0000-0000-000000000003',
   '00000000-0000-0000-0000-000000000001',
   '10000000-0000-0000-0000-000000000002',
   'stripe', 're_degraded_001',
   '20000000-0000-0000-0000-000000000003',
   'v1',
   '{"stripeRefundId":"re_degraded_001","stripeRefundStatus":"pending","stripeChargeAmount":7500,"stripeCurrency":"usd","refundAmount":7500,"refundCurrency":"usd"}',
   'pending', 7500, 'usd', 're_degraded_001', 'ch_002',
   now(), false, null),
  ('50000000-0000-0000-0000-000000000004',
   '00000000-0000-0000-0000-000000000001',
   '10000000-0000-0000-0000-000000000002',
   'shopify', 'order_archived_001',
   '20000000-0000-0000-0000-000000000004',
   'v1',
   '{}',  -- no usable normalized data
   null, null, null, null, null,
   now(), true, 'Shopify order archived — last known state unavailable. Verify via Shopify admin if needed.');

INSERT INTO evidence_match_results (
  tenant_id, issue_id, evidence_normalized_id, match_algorithm_version, match_band,
  confidence_score, matched_fields, match_notes
) VALUES
  ('00000000-0000-0000-0000-000000000001',
   '10000000-0000-0000-0000-000000000002',
   '50000000-0000-0000-0000-000000000003',
   'v1', 'MEDIUM', 0.71,
   ARRAY['refund_amount'],
   'Stripe data available. Shopify order no longer accessible — match based on Stripe evidence only.');

INSERT INTO issue_card_state (
  tenant_id, issue_id, zendesk_ticket_id, issue_state,
  match_band, confidence_score, evidence_fetched_at,
  is_source_unavailable, evidence_summary
) VALUES
  ('00000000-0000-0000-0000-000000000001',
   '10000000-0000-0000-0000-000000000002',
   '10002', 'OPEN', 'MEDIUM', 0.71, now(), true,
   '{"stripeRefundStatus":"pending","stripeChargeAmount":7500,"refundAmount":7500,"currency":"usd","sourceUnavailable":true,"sourceUnavailableReason":"Shopify order archived — last known state unavailable. Verify via Shopify admin if needed."}');

-- ─── Scenario 3: Awaiting operator reconciliation ────────────────────────────
-- Ticket 10003: a past close attempt whose outcome was never confirmed. The
-- execution is parked in FAILED_TERMINAL with the outbox row BLOCKED_OPERATOR.
--
-- This is seeded state representing a prior incident, not a live demonstration
-- of uncertainty detection. To see the worker actually produce SENT_UNCERTAIN,
-- run the exactly-once tests, which drive a timeout through the adapter.

INSERT INTO issues (id, tenant_id, customer_id, customer_email, state) VALUES
  ('10000000-0000-0000-0000-000000000003',
   '00000000-0000-0000-0000-000000000001',
   'cust_retry_001',
   'carol@example.com',
   'OPEN');

INSERT INTO issue_tickets (tenant_id, issue_id, zendesk_ticket_id, is_primary) VALUES
  ('00000000-0000-0000-0000-000000000001',
   '10000000-0000-0000-0000-000000000003',
   '10003', true);

INSERT INTO evidence_raw_snapshots (
  id, tenant_id, issue_id, source_system, source_record_id, normalizer_version, raw_data
) VALUES
  ('20000000-0000-0000-0000-000000000005',
   '00000000-0000-0000-0000-000000000001',
   '10000000-0000-0000-0000-000000000003',
   'stripe', 're_retry_001', 'v1',
   '{"id":"re_retry_001","amount":3000,"currency":"usd","status":"succeeded","charge":"ch_003","created":1704067200}');

INSERT INTO evidence_normalized (
  id, tenant_id, issue_id, source_system, source_record_id, raw_snapshot_id,
  normalizer_version, normalized_data,
  refund_status, refund_amount_cents, refund_currency, refund_id, charge_id,
  fetched_at, is_source_unavailable
) VALUES
  ('50000000-0000-0000-0000-000000000005',
   '00000000-0000-0000-0000-000000000001',
   '10000000-0000-0000-0000-000000000003',
   'stripe', 're_retry_001',
   '20000000-0000-0000-0000-000000000005',
   'v1',
   '{"stripeRefundId":"re_retry_001","stripeRefundStatus":"succeeded","stripeChargeAmount":3000,"stripeCurrency":"usd","refundAmount":3000,"refundCurrency":"usd"}',
   'succeeded', 3000, 'usd', 're_retry_001', 'ch_003',
   now(), false);

INSERT INTO evidence_match_results (
  tenant_id, issue_id, evidence_normalized_id, match_algorithm_version, match_band,
  confidence_score, matched_fields, match_notes
) VALUES
  ('00000000-0000-0000-0000-000000000001',
   '10000000-0000-0000-0000-000000000003',
   '50000000-0000-0000-0000-000000000005',
   'v1', 'HIGH', 0.91,
   ARRAY['refund_amount','refund_status'],
   'Stripe refund confirmed succeeded. High confidence match.');

-- Execution parked for reconciliation: the outcome was never confirmed, so it
-- must not be retried automatically.
INSERT INTO action_executions (
  id, tenant_id, issue_id, action_type, requested_by_agent_id,
  idempotency_key, planned_state, status, attempt_count, next_attempt_at,
  policy_rule_id, policy_version
) VALUES
  ('30000000-0000-0000-0000-000000000001',
   '00000000-0000-0000-0000-000000000001',
   '10000000-0000-0000-0000-000000000003',
   'close_confirmed', 'agent-demo-001',
   'demo-idempotency-close-10003', 'RESOLVED',
   'FAILED_TERMINAL', 2, null,
   'refund.close_confirmed.high_match', 'v1');

-- Outbox row whose effect is settled as SENT_UNCERTAIN. BLOCKED_OPERATOR and
-- effect_settled_at together guarantee the worker will never re-dispatch it.
INSERT INTO outbox_messages (
  id, tenant_id, action_execution_id, target_system, payload,
  idempotency_key, status, attempt_count, effect_settled_at, effects
) VALUES
  ('40000000-0000-0000-0000-000000000001',
   '00000000-0000-0000-0000-000000000001',
   '30000000-0000-0000-0000-000000000001',
   'zendesk',
   '{"type":"set_status","ticket_id":"10003","status":"solved"}',
   'demo-outbox-close-10003',
   'BLOCKED_OPERATOR', 2, now(),
   '[
     {
       "effect_type": "zendesk_status_set",
       "target_system": "zendesk",
       "target_resource_id": "ticket/10003",
       "effect_key": "exec-30000000-close_confirmed-ticket/10003",
       "attempt_number": 1,
       "outcome_status": "SENT_UNCERTAIN",
       "provider_correlation_id": null,
       "intended_at": "2024-01-01T10:00:00Z",
       "sent_at": "2024-01-01T10:00:01Z",
       "confirmed_at": null
     },
     {
       "effect_type": "zendesk_status_set",
       "target_system": "zendesk",
       "target_resource_id": "ticket/10003",
       "effect_key": "exec-30000000-close_confirmed-ticket/10003",
       "attempt_number": 2,
       "outcome_status": "SENT_UNCERTAIN",
       "provider_correlation_id": null,
       "intended_at": "2024-01-01T10:01:00Z",
       "sent_at": "2024-01-01T10:01:01Z",
       "confirmed_at": null
     }
   ]'::jsonb);

INSERT INTO issue_card_state (
  tenant_id, issue_id, zendesk_ticket_id, issue_state,
  match_band, confidence_score, evidence_fetched_at,
  is_source_unavailable, pending_action_execution_id,
  last_action_type, evidence_summary
) VALUES
  ('00000000-0000-0000-0000-000000000001',
   '10000000-0000-0000-0000-000000000003',
   '10003', 'OPEN', 'HIGH', 0.91, now(), false,
   '30000000-0000-0000-0000-000000000001',
   'close_confirmed',
   '{"stripeRefundStatus":"succeeded","stripeChargeAmount":3000,"refundAmount":3000,"currency":"usd"}');

-- ─── Audit log entries for demo ───────────────────────────────────────────────

INSERT INTO audit_log (tenant_id, issue_id, event_type, actor_type, actor_id, payload, policy_rule_id, policy_version)
VALUES
  ('00000000-0000-0000-0000-000000000001',
   '10000000-0000-0000-0000-000000000003',
   'policy_decision', 'agent', 'agent-demo-001',
   '{"outcome":"ALLOW","action_type":"close_confirmed","match_band":"HIGH"}',
   'refund.close_confirmed.high_match', 'v1'),
  ('00000000-0000-0000-0000-000000000001',
   '10000000-0000-0000-0000-000000000003',
   'action_execution_created', 'system', 'system',
   '{"action_execution_id":"30000000-0000-0000-0000-000000000001","action_type":"close_confirmed"}',
   null, null),
  ('00000000-0000-0000-0000-000000000001',
   '10000000-0000-0000-0000-000000000003',
   'action_execution_retry', 'system', 'system',
   '{"action_execution_id":"30000000-0000-0000-0000-000000000001","attempt":2,"outcome_status":"SENT_UNCERTAIN"}',
   null, null);


-- ─── Scenario 4: Already refunded — the duplicate-refund catch ────────────────
--
-- Two tickets, one customer, one order. Ticket 10004 was refunded in January.
-- Ticket 10005 is the same customer writing back two weeks later because the
-- money had not appeared in their bank yet — which is what refunds do for a
-- week, and why this is the most common way a support team pays twice for one
-- purchase.
--
-- The agent looking at 10005 has no reason to suspect anything: the ticket
-- reads like an ordinary refund request, and its own evidence does not match
-- (there is no charge id in the text). The card catches it from history alone.
--
-- Both issues carry extracted context, because history matches on the
-- identifiers the extractor found — never on amount, since two $49.99 orders
-- from one customer are not one purchase.

-- Ticket 10004 — the original request, refunded.
INSERT INTO issues (id, tenant_id, customer_id, customer_email, state, opened_at) VALUES
  ('10000000-0000-0000-0000-000000000004',
   '00000000-0000-0000-0000-000000000001',
   'cust_repeat_004',
   'dana@example.com',
   'RESOLVED',
   now() - interval '21 days');

INSERT INTO issue_tickets (tenant_id, issue_id, zendesk_ticket_id, is_primary) VALUES
  ('00000000-0000-0000-0000-000000000001',
   '10000000-0000-0000-0000-000000000004',
   '10004', true);

INSERT INTO issue_context (
  tenant_id, issue_id, extractor_version, payment_reference, order_reference,
  claimed_amount_cents, claimed_currency, primary_ask, message_count
) VALUES
  ('00000000-0000-0000-0000-000000000001',
   '10000000-0000-0000-0000-000000000004',
   'extract_v1', 'ch_001', '1001', 4999, 'usd', 'refund_request', 2);

INSERT INTO issue_card_state (
  tenant_id, issue_id, zendesk_ticket_id, issue_state,
  match_band, confidence_score, evidence_fetched_at, is_source_unavailable,
  refund_status, refund_amount_cents, refund_currency, refund_id, evidence_summary
) VALUES
  ('00000000-0000-0000-0000-000000000001',
   '10000000-0000-0000-0000-000000000004',
   '10004', 'RESOLVED', 'HIGH', 0.94, now() - interval '21 days', false,
   'succeeded', 4999, 'usd', 're_demo_004',
   '{"stripeRefundStatus":"succeeded","stripeChargeAmount":4999,"shopifyOrderName":"#1001","refundAmount":4999,"currency":"usd"}');

-- Ticket 10005 — same customer, same order, no charge id this time.
INSERT INTO issues (id, tenant_id, customer_id, customer_email, state, opened_at) VALUES
  ('10000000-0000-0000-0000-000000000005',
   '00000000-0000-0000-0000-000000000001',
   'cust_repeat_004',
   'dana@example.com',
   'OPEN',
   now() - interval '2 hours');

INSERT INTO issue_tickets (tenant_id, issue_id, zendesk_ticket_id, is_primary) VALUES
  ('00000000-0000-0000-0000-000000000001',
   '10000000-0000-0000-0000-000000000005',
   '10005', true);

INSERT INTO issue_context (
  tenant_id, issue_id, extractor_version, payment_reference, order_reference,
  claimed_amount_cents, claimed_currency, primary_ask, message_count
) VALUES
  ('00000000-0000-0000-0000-000000000001',
   '10000000-0000-0000-0000-000000000005',
   'extract_v1', NULL, '1001', 4999, 'usd', 'refund_request', 2);

INSERT INTO issue_card_state (
  tenant_id, issue_id, zendesk_ticket_id, issue_state,
  match_band, confidence_score, evidence_fetched_at, is_source_unavailable,
  evidence_summary
) VALUES
  ('00000000-0000-0000-0000-000000000001',
   '10000000-0000-0000-0000-000000000005',
   '10005', 'OPEN', 'LOW', 0.31, now(), false,
   '{"shopifyOrderName":"#1001","refundAmount":4999,"currency":"usd"}');


-- ─── The conversations ───────────────────────────────────────────────────────
--
-- The text the agent reads, and the text the extractor reads. Annotations are
-- NOT written here: scripts/seed.ts runs the real extractor over these bodies
-- and stores the spans it produces. Hand-written offsets would be correct on
-- the day they were typed and silently wrong after any change to a rule.
--
-- Bodies are written to exercise the extractors that exist — an amount, a date,
-- an order number, a payment reference, and a request — not to flatter them.

INSERT INTO issue_messages
  (tenant_id, issue_id, source_id, kind, author_role, body, position, created_at)
VALUES
  -- 10001 — happy path
  ('00000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001',
   'ticket:10001:subject', 'ticket_subject', 'customer',
   'Refund for order #1001', 0, now() - interval '3 hours'),
  ('00000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001',
   'ticket:10001:description', 'ticket_description', 'customer',
   'I returned order #1001 on 2026-01-15. I paid $49.99 on charge ch_001 and would like a refund.',
   1, now() - interval '3 hours'),
  ('00000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001',
   'comment:10001-2', 'comment', 'agent',
   'Thanks for the details — checking the payment record now.',
   2, now() - interval '2 hours'),

  -- 10002 — the Shopify order is archived
  ('00000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000002',
   'ticket:10002:subject', 'ticket_subject', 'customer',
   'Where is my refund for order #2002?', 0, now() - interval '2 days'),
  ('00000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000002',
   'ticket:10002:description', 'ticket_description', 'customer',
   'Order #2002 was returned on 2026-02-01. The total was $129.50. Please refund it.',
   1, now() - interval '2 days'),

  -- 10003 — a previous action whose outcome was never confirmed
  ('00000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000003',
   'ticket:10003:subject', 'ticket_subject', 'customer',
   'Cancel order #3003', 0, now() - interval '5 hours'),
  ('00000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000003',
   'ticket:10003:description', 'ticket_description', 'customer',
   'I would like to cancel order #3003 placed on 2026-03-02 for $75.00.',
   1, now() - interval '5 hours'),

  -- 10004 — the original request, refunded
  ('00000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000004',
   'ticket:10004:subject', 'ticket_subject', 'customer',
   'Refund for order #1001', 0, now() - interval '21 days'),
  ('00000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000004',
   'ticket:10004:description', 'ticket_description', 'customer',
   'I want a refund for order #1001, charge ch_001. I paid $49.99 on 2026-01-15.',
   1, now() - interval '21 days'),

  -- 10005 — same customer, same order, no charge id this time
  ('00000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000005',
   'ticket:10005:subject', 'ticket_subject', 'customer',
   'Still waiting on my refund for 1001', 0, now() - interval '2 hours'),
  ('00000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000005',
   'ticket:10005:description', 'ticket_description', 'customer',
   'I asked about order #1001 two weeks ago and still have not seen the $49.99 back. My bank says nothing arrived since 2026-01-30.',
   1, now() - interval '2 hours');
