# Demo Walkthrough

## Prerequisites

- Docker Desktop running
- Node.js 18+ (`node --version`)
- npm 9+ (`npm --version`)

## Setup

Follow the Quick Start in the README to export the required environment
variables, then:

```bash
npm run demo:start
```

Services:
- API: http://localhost:3001
- Sidebar: http://localhost:5173

Every endpoint is authenticated and derives its tenant from the token, so the
`curl` commands below need the tokens you exported. There is no `x-tenant-id`
header any more — supplying one has no effect.

```bash
export OPERATOR_TOKEN=<operator_token>   # /ops endpoints
export AGENT_TOKEN=<agent_token>         # card, actions, approvals
```

---

## Scenario 1: Happy Path — Refund Confirmed

**What this shows:** High-confidence match, fast close, minimal friction.

1. Open http://localhost:5173
2. Select **Scenario 1: Happy Path** in the left panel (Ticket #10001)
3. Observe the Resolution Card:
   - Issue state: **Open**
   - Match band: **HIGH (94%)**
   - Evidence: Stripe refund `succeeded`, Shopify order `refunded`
   - Evidence freshness: **Fresh**
   - No degraded banner
4. Click **"Close as Resolved"** (primary CTA)
5. Observe:
   - CTA replaced by "Action submitted — processing"
   - Worker picks up outbox message within 2 seconds
   - Card auto-refreshes: state → **Resolved**, action complete
6. Verify the audit trail:
   ```bash
   curl http://localhost:3001/ops/audit/10000000-0000-0000-0000-000000000001 \
     -H "Authorization: Bearer $OPERATOR_TOKEN"
   ```
   Every policy evaluation appears with its `policy_rule_id` and
   `policy_version`.

**Expected behavior:** End-to-end in <5 seconds. Zero extra interactions.

---

## Scenario 2: Degraded Mode — Source Unavailable

**What this shows:** Shopify order archived, agent can still proceed with available evidence.

1. Select **Scenario 2: Degraded Mode** (Ticket #10002)
2. Observe the Resolution Card:
   - **Degraded banner** at top: "Source record no longer available — case record preserved"
   - Match band: **MEDIUM (71%)**
   - Shopify evidence: shows source-unavailable state
   - Stripe evidence: still available (pending refund)
   - Soft warning: "Source records are unavailable..."
3. CTA available: **"Escalate for Review"** (not close — match is MEDIUM)
4. Click "Escalate for Review"
5. Observe: action queued, issue moves to ESCALATED state

**Key spec behavior demonstrated:**
- `is_source_unavailable = true` (persisted flag, spec Finding 5)
- Time-based freshness computed separately from source unavailability
- Non-accusatory language throughout

---

## Scenario 3: Awaiting operator reconciliation

**What this shows:** an execution whose outcome was never confirmed, parked for
a human rather than retried.

> This is **seeded state** representing a past incident — it is not a live
> demonstration of uncertainty detection. To see the worker actually produce
> `SENT_UNCERTAIN` from a real timeout, run
> `npx vitest run apps/api/test/exactly-once.test.ts`, which drives timeouts
> and provider rejections through the adapter and asserts on the ledger.

1. Select **Scenario 3** (Ticket #10003)
2. Observe the Resolution Card: the execution is `FAILED_TERMINAL` and its
   outbox row is `BLOCKED_OPERATOR` with `effect_settled_at` set, so the worker
   will never re-dispatch it.
3. Inspect the effects ledger — two `SENT_UNCERTAIN` attempts are recorded and
   neither was followed by a re-send.

**Reconcile it:**

```bash
# Get the execution ID
curl http://localhost:3001/ops/action-executions \
  -H "Authorization: Bearer $OPERATOR_TOKEN"

# Reconcile with CONFIRMED_OCCURRED (effect did happen)
curl -X PATCH http://localhost:3001/ops/action-executions/<execution-id>/reconcile \
  -H "Authorization: Bearer $OPERATOR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "external_side_effect_status": "CONFIRMED_OCCURRED",
    "investigation_notes": "Verified in Zendesk admin: ticket 10003 shows solved status",
    "corrective_action_taken": "No corrective action needed — effect confirmed occurred"
  }'
```

**Behaviour demonstrated:**
- No `state_transitions` row is written on `FAILED_TERMINAL`
- `reconciled_at`, `reconciled_by`, `reconciliation_outcome`,
  `investigation_notes` are recorded on the execution
- Status stays `FAILED_TERMINAL` — reconciliation is metadata, never a status
  change, so the record of what happened cannot be rewritten
- `reconciled_by` is the authenticated operator, not a value from the request

---

## Scenario 4 (Optional): Approvals ON — Manager Approval Flow

**What this shows:** Approval lifecycle when `approvals_enabled = true`.

### Enable approvals for the demo tenant

```bash
curl -X PATCH http://localhost:3001/ops/tenant-config \
  -H "Authorization: Bearer $OPERATOR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"approvals_enabled": true}'
```

### Demo flow

1. Select **Scenario 2** (MEDIUM match — will now route to approval)
2. Card now shows: "Requires approval" badge on CTA
3. Click the CTA — instead of queueing execution, an approval request is created
4. Card shows: "Awaiting manager approval" state
5. Approve as manager:
   ```bash
   # List pending approvals
   curl http://localhost:3001/api/v1/approvals \
     -H "Authorization: Bearer $OPERATOR_TOKEN"

   # Grant it. The approving manager is the authenticated principal and must
   # have a manager_grants entry — a manager_id in the body is ignored.
   curl -X POST http://localhost:3001/api/v1/approvals/<approval-id>/grant \
     -H "Authorization: Bearer $OPERATOR_TOKEN" \
     -H "Content-Type: application/json" \
     -d '{"notes": "Approved — verified customer account"}'
   ```
6. Watch: action execution created atomically on approval, worker picks it up
7. Card transitions to ESCALATED/RESOLVED

### Disable approvals again

```bash
curl -X PATCH http://localhost:3001/ops/tenant-config \
  -H "Authorization: Bearer $OPERATOR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"approvals_enabled": false}'
```

---

## Operator Repair Commands

All require: `-H "Authorization: Bearer $OPERATOR_TOKEN"`

### Rebuild issue card state
```bash
curl -X POST http://localhost:3001/ops/issues/<issue-id>/rebuild-card-state \
  -H "Authorization: Bearer $OPERATOR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"reason": "Card state appeared stale after deployment"}'
```

### Replay inbound event
```bash
curl -X POST http://localhost:3001/ops/inbound-events/<event-id>/replay \
  -H "Authorization: Bearer $OPERATOR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"reason": "Event processing failed due to transient DB error"}'
```

### Force sync Zendesk status
```bash
curl -X POST http://localhost:3001/ops/issues/<issue-id>/sync-zendesk \
  -H "Authorization: Bearer $OPERATOR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"reason": "Zendesk showed wrong status after failed outbox", "target_status": "solved"}'
```

### View observability metrics
```bash
curl http://localhost:3001/metrics \
  -H "Authorization: Bearer $OPERATOR_TOKEN"
```

---

## Troubleshooting

**"Connection refused" on API**
- Check `npm run dev` is running in a terminal
- Check `docker compose -f infra/docker-compose.yml ps` shows Postgres healthy

**Migrations fail**
- `npm run db:migrate --reset` to reset and re-run (destructive, for local dev only)

**Seed data not loading**
- `npm run db:seed` can be run standalone after migrations

**Worker not processing**
- The worker runs as its own process from `apps/api/src/worker.ts`; `npm run dev`
  starts it alongside the API. Check the terminal for `[worker]` log lines.
- It polls every 2 seconds; allow time for it to pick up messages.
- A `BLOCKED_OPERATOR` row is *meant* to sit there — it needs reconciliation,
  not a retry.

**401 Unauthorized**
- Export `AGENT_TOKEN` / `OPERATOR_TOKEN` and pass them as
  `Authorization: Bearer <token>`. Tenancy comes from the token; `x-tenant-id`
  is no longer read.
- Tokens are provisioned by `npm run db:seed` from the environment. If you
  rotated a token, re-run the seed.
