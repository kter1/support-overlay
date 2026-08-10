/**
 * Evidence ingestion — stage one of the pipeline.
 *
 * Before this existed, a real ticket produced an issue, a ticket link, and an
 * empty card: nothing ever fetched from a provider, and evidence rows came only
 * from db/seed.sql. These tests assert the chain from ticket text to a stored,
 * matched, explainable band.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createTestDb, createTenant, createIssue, TestDb } from "./helpers/db";
import { ingestTicketContext } from "../src/services/ingestion";
import { simulatorStore, stripeSimulator } from "@iisl/connectors";

const TICKET = "55001";

describe("evidence ingestion", () => {
  let db: TestDb;
  let tenantId: string;
  let issueId: string;

  beforeEach(async () => {
    db = await createTestDb();
    stripeSimulator.reset();
    tenantId = await createTenant(db);
    issueId = await createIssue(db, tenantId, { ticketId: TICKET });
  });

  afterEach(async () => {
    await db.close();
  });

  /** Seed a ticket thread the way Zendesk would return it. */
  function seedThread(messages: Array<{ body: string; role: "customer" | "agent" }>) {
    simulatorStore.seedConversation(TICKET, {
      ticketId: TICKET,
      subject: "Refund request",
      description: messages[0]?.body ?? "",
      createdAt: "2026-03-10T09:00:00Z",
      requesterId: "cust-1",
      messages: messages.map((m, i) => ({
        id: `m${i}`,
        body: m.body,
        createdAt: new Date(Date.parse("2026-03-10T09:00:00Z") + i * 60_000).toISOString(),
        authorRole: m.role,
        isPublic: true,
      })),
    });
  }

  async function evidenceRows() {
    const result = await db.driver.query<{
      source_system: string;
      refund_amount_cents: number | null;
      charge_id: string | null;
      order_id: string | null;
      is_source_unavailable: boolean;
    }>(
      `SELECT source_system, refund_amount_cents, charge_id, order_id,
              is_source_unavailable
         FROM evidence_normalized WHERE issue_id = $1 ORDER BY source_system`,
      [issueId]
    );
    return result.rows;
  }

  it("acquires payment evidence from a charge id in the conversation", async () => {
    seedThread([
      { body: "I was charged for ch_001 and never got my order.", role: "customer" },
    ]);

    const result = await ingestTicketContext(tenantId, issueId, TICKET);

    expect(result.evidenceFrom).toContain("stripe");
    const rows = await evidenceRows();
    expect(rows.find((r) => r.source_system === "stripe")?.charge_id).toBe("ch_001");
  });

  it("produces a match band where there was none", async () => {
    seedThread([
      { body: "Refund for order 1001, charge ch_001 — I paid $49.99", role: "customer" },
    ]);

    const before = await db.driver.query(
      `SELECT id FROM evidence_match_results WHERE issue_id = $1`,
      [issueId]
    );
    expect(before.rows).toHaveLength(0);

    const result = await ingestTicketContext(tenantId, issueId, TICKET);

    expect(result.matchBand).not.toBeNull();
    const after = await db.driver.query(
      `SELECT match_band FROM evidence_match_results WHERE issue_id = $1`,
      [issueId]
    );
    expect(after.rows).toHaveLength(1);
  });

  it("records what it extracted and where it came from, before any lookup", async () => {
    seedThread([
      { body: "Charge ch_001 please refund, I paid $49.99", role: "customer" },
    ]);

    await ingestTicketContext(tenantId, issueId, TICKET);

    const audit = await db.driver.query<{
      payload: {
        leads: { payment_reference: string; primary_ask: string };
        highlights: Array<{ excerpt: string; rule: string }>;
      };
    }>(
      `SELECT payload FROM audit_log
        WHERE issue_id = $1 AND event_type = 'context_extracted'`,
      [issueId]
    );

    expect(audit.rows).toHaveLength(1);
    const payload = audit.rows[0].payload;
    expect(payload.leads.payment_reference).toBe("ch_001");
    expect(payload.leads.primary_ask).toBe("refund_request");
    // Every highlight names the text it came from.
    expect(payload.highlights.every((h) => h.excerpt && h.rule)).toBe(true);
  });

  it("stores a raw snapshot so a normalizer change can be re-run", async () => {
    seedThread([{ body: "charge ch_001 refund please", role: "customer" }]);

    await ingestTicketContext(tenantId, issueId, TICKET);

    const snapshots = await db.driver.query<{ raw_data: unknown; raw_data_hash: string }>(
      `SELECT raw_data, raw_data_hash FROM evidence_raw_snapshots WHERE issue_id = $1`,
      [issueId]
    );

    expect(snapshots.rows.length).toBeGreaterThan(0);
    expect(snapshots.rows[0].raw_data).not.toBeNull();
    expect(snapshots.rows[0].raw_data_hash).toHaveLength(64);
  });

  it("does not guess a payment when the conversation names none", async () => {
    // Searching Stripe by amount would cheerfully return someone else's refund
    // for the same price.
    seedThread([{ body: "I want my money back, this is unacceptable", role: "customer" }]);

    const result = await ingestTicketContext(tenantId, issueId, TICKET);

    expect(result.evidenceFrom).toHaveLength(0);
    expect(await evidenceRows()).toHaveLength(0);
    expect(result.matchBand).toBeNull();
  });

  it("keeps partial evidence when one provider is unreachable", async () => {
    seedThread([{ body: "order 1001 and charge ch_001, refund please", role: "customer" }]);

    const result = await ingestTicketContext(tenantId, issueId, TICKET);

    // Stripe resolves; Shopify's fixture has no order 1001. Partial evidence is
    // the normal case and must still produce a card.
    expect(result.evidenceFrom).toContain("stripe");
    expect((await evidenceRows()).length).toBeGreaterThan(0);
  });

  it("survives a ticket it cannot read at all", async () => {
    // No seeded conversation: the thread fetch returns nothing.
    const result = await ingestTicketContext(tenantId, issueId, "no-such-ticket");

    expect(result.evidenceFrom).toHaveLength(0);
    expect(result.matchBand).toBeNull();
  });

  it("re-ingesting replaces rather than duplicates evidence", async () => {
    seedThread([{ body: "charge ch_001 refund", role: "customer" }]);

    await ingestTicketContext(tenantId, issueId, TICKET);
    await ingestTicketContext(tenantId, issueId, TICKET);

    const stripeRows = (await evidenceRows()).filter((r) => r.source_system === "stripe");
    expect(stripeRows).toHaveLength(1);

    // But both reads are preserved as snapshots.
    const snapshots = await db.driver.query(
      `SELECT id FROM evidence_raw_snapshots WHERE issue_id = $1`,
      [issueId]
    );
    expect(snapshots.rows).toHaveLength(2);
  });

  it("prefers a customer's later correction when the conversation revises itself", async () => {
    seedThread([
      { body: "charge ch_002 I think", role: "customer" },
      { body: "Let me check that.", role: "agent" },
      { body: "Sorry — it was actually ch_001", role: "customer" },
    ]);

    await ingestTicketContext(tenantId, issueId, TICKET);

    const rows = await evidenceRows();
    expect(rows.find((r) => r.source_system === "stripe")?.charge_id).toBe("ch_001");
  });

  it("updates the card so the agent sees the result", async () => {
    seedThread([{ body: "refund charge ch_001, paid $49.99", role: "customer" }]);

    await ingestTicketContext(tenantId, issueId, TICKET);

    const card = await db.driver.query<{ match_band: string | null; refund_id: string | null }>(
      `SELECT match_band, refund_id FROM issue_card_state WHERE issue_id = $1`,
      [issueId]
    );

    expect(card.rows).toHaveLength(1);
    expect(card.rows[0].match_band).not.toBeNull();
  });
});
