# IISL Phase 1 — Demo Walkthrough

## Prerequisites

- Docker Desktop running
- Node.js 18+ (`node --version`)
- npm 9+ (`npm --version`)

## Setup (one-time)

```bash
# 1. Install dependencies
npm install

# 2. Start Postgres
docker compose -f infra/docker-compose.yml up -d

# 3. Wait for Postgres to be ready (~5s), then:
npm run db:migrate
npm run db:seed

# 4. Start all services
npm run dev
```

Services:
- API: http://localhost:3001
- Sidebar: http://localhost:5173

Before running operator API commands in this guide:

```bash
export OPERATOR_TOKEN=<operator_token>
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
6. Verify audit trail:
   ```bash
   curl http://localhost:3001/ops/audit/10000000-0000-0000-0000-000000000001 \
     -H "Authorization: Bearer $OPERATOR_TOKEN"
   ```

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

## Scenario 3: Retry + Unknown Outcome Reconciliation

**What this shows:** SENT_UNCERTAIN state, worker retry, operator reconcile path.

1. Select **Scenario 3: Retry + Unknown Outcome** (Ticket #10003)
2. Observe the Resolution Card:
   - Issue state: **Action In Progress**
   - Execution panel: shows retrying state
   - The seeded data has 2 SENT_UNCERTAIN attempts already recorded in effects ledger
3. Watch the worker (in your terminal):
   ```
   [worker] Processing <id> | action=close_confirmed | attempt=3
   [worker:zendesk-sim] ✓ Ticket 10003 status → solved
   ```
4. Card auto-refreshes: state → **Resolved**

**Demonstrate reconciliation manually:**

For the scenario where worker reaches FAILED_TERMINAL (simulate by stopping the worker mid-retry):

```bash
# Get the execution ID
curl http://localhost:3001/ops/action-executions \
  -H "Authorization: Bearer $OPERATOR_TOKEN" \
  -H "x-tenant-id: 00000000-0000-0000-0000-000000000001"

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

**Key spec behavior demonstrated:**
- `state_transitions` NOT written on FAILED_TERMINAL (spec Finding 3)
- `reconciled_at`, `reconciled_by`, `reconciliation_outcome` columns (spec Finding 7)
- Status stays `FAILED_TERMINAL` — reconciliation is metadata, not status change

---

## Scenario 4 (Optional): Approvals ON — Manager Approval Flow

**What this shows:** Approval lifecycle when `approvals_enabled = true`.

### Enable approvals for the demo tenant

```bash
curl -X PATCH http://localhost:3001/ops/tenants/00000000-0000-0000-0000-000000000001/config \
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
   curl http://localhost:3001/approvals \
     -H "x-tenant-id: 00000000-0000-0000-0000-000000000001" \
     -H "Authorization: Bearer $OPERATOR_TOKEN"

   # Approve (as manager)
   curl -X POST http://localhost:3001/approvals/<approval-id>/approve \
     -H "x-tenant-id: 00000000-0000-0000-0000-000000000001" \
     -H "Authorization: Bearer $OPERATOR_TOKEN" \
     -H "Content-Type: application/json" \
     -d '{"manager_id": "manager-demo-001", "notes": "Approved — verified customer account"}'
   ```
6. Watch: action execution created atomically on approval, worker picks it up
7. Card transitions to ESCALATED/RESOLVED

### Disable approvals again

```bash
curl -X PATCH http://localhost:3001/ops/tenants/00000000-0000-0000-0000-000000000001/config \
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
  -H "x-tenant-id: 00000000-0000-0000-0000-000000000001"
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
- Worker starts as part of `npm run dev` — check the terminal for `[worker]` log lines
- Worker polls every 2 seconds; allow time for it to pick up messages
