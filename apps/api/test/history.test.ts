/**
 * Customer history assembly.
 *
 * The behaviour under test is a warning that has to be right in both
 * directions. Missing a prior refund means the team pays twice. Firing on a
 * customer who simply bought two things means agents learn to click past the
 * banner, which costs the same as not having it. Most of these tests are about
 * the second failure.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createTestDb, createTenant, createIssue, TestDb } from "./helpers/db";
import { assembleCustomerHistory } from "../src/services/history";

describe("customer history", () => {
  let db: TestDb;
  let tenantId: string;

  beforeEach(async () => {
    db = await createTestDb();
    tenantId = await createTenant(db);
  });

  afterEach(async () => {
    await db.close();
  });

  /** Give an issue an extracted context row, as ingestion would. */
  async function withContext(
    issueId: string,
    opts: {
      orderReference?: string | null;
      paymentReference?: string | null;
      primaryAsk?: string | null;
    } = {}
  ) {
    await db.driver.query(
      `INSERT INTO issue_context
         (tenant_id, issue_id, extractor_version, order_reference,
          payment_reference, primary_ask, highlights, message_count)
       VALUES ($1, $2, 'extract_v1', $3, $4, $5, '[]'::jsonb, 2)`,
      [
        tenantId,
        issueId,
        opts.orderReference ?? null,
        opts.paymentReference ?? null,
        opts.primaryAsk ?? "refund_request",
      ]
    );
  }

  /** Give an issue a card showing a refund outcome, as the worker would. */
  async function withRefund(
    issueId: string,
    opts: { amountCents?: number; status?: string; currency?: string } = {}
  ) {
    await db.driver.query(
      `INSERT INTO issue_card_state
         (tenant_id, issue_id, issue_state, refund_status,
          refund_amount_cents, refund_currency)
       VALUES ($1, $2, 'RESOLVED', $3, $4, $5)`,
      [
        tenantId,
        issueId,
        opts.status ?? "succeeded",
        opts.amountCents ?? 4999,
        opts.currency ?? "usd",
      ]
    );
  }

  it("warns when the same order was already refunded", async () => {
    const past = await createIssue(db, tenantId, { ticketId: "900" });
    await withContext(past, { orderReference: "1001" });
    await withRefund(past, { amountCents: 4999 });

    const current = await createIssue(db, tenantId, { ticketId: "901" });
    await withContext(current, { orderReference: "1001" });

    const history = await assembleCustomerHistory(tenantId, current);

    const critical = history.notices.find(
      (n) => n.code === "prior_refund_same_subject"
    );
    expect(critical).toBeDefined();
    expect(critical?.severity).toBe("critical");
    expect(critical?.message).toContain("#900");
    expect(critical?.message).toContain("$49.99");
    expect(critical?.issueIds).toContain(past);
  });

  it("does not warn when a different order was refunded for the same amount", async () => {
    // Two $49.99 purchases by one customer is an ordinary Tuesday. Warning here
    // is how a useful banner becomes background noise.
    const past = await createIssue(db, tenantId, { ticketId: "900" });
    await withContext(past, { orderReference: "1001" });
    await withRefund(past, { amountCents: 4999 });

    const current = await createIssue(db, tenantId, { ticketId: "901" });
    await withContext(current, { orderReference: "2002" });

    const history = await assembleCustomerHistory(tenantId, current);

    expect(
      history.notices.find((n) => n.code === "prior_refund_same_subject")
    ).toBeUndefined();
    // The earlier issue is still listed — it just isn't an alarm.
    expect(history.priorIssueCount).toBe(1);
    expect(history.priorInteractions[0].sameSubject).toBe(false);
  });

  it("matches on charge id when no order number was given", async () => {
    const past = await createIssue(db, tenantId, { ticketId: "900" });
    await withContext(past, { paymentReference: "ch_001" });
    await withRefund(past);

    const current = await createIssue(db, tenantId, { ticketId: "901" });
    await withContext(current, { paymentReference: "ch_001" });

    const history = await assembleCustomerHistory(tenantId, current);

    const critical = history.notices.find(
      (n) => n.code === "prior_refund_same_subject"
    );
    expect(critical).toBeDefined();
    expect(critical?.message).toContain("charge");
  });

  it("treats a failed refund as money not paid", async () => {
    // A refund that failed is not a duplicate risk, and telling the agent one
    // was already issued would block a refund the customer is owed.
    const past = await createIssue(db, tenantId, { ticketId: "900" });
    await withContext(past, { orderReference: "1001" });
    await withRefund(past, { status: "failed" });

    const current = await createIssue(db, tenantId, { ticketId: "901" });
    await withContext(current, { orderReference: "1001" });

    const history = await assembleCustomerHistory(tenantId, current);

    expect(
      history.notices.find((n) => n.code === "prior_refund_same_subject")
    ).toBeUndefined();
    // It is still a repeat contact about the same order.
    expect(
      history.notices.find((n) => n.code === "repeat_contact_same_subject")
    ).toBeDefined();
  });

  it("flags a re-contact about the same order before any refund", async () => {
    const past = await createIssue(db, tenantId, { ticketId: "900" });
    await withContext(past, { orderReference: "1001" });

    const current = await createIssue(db, tenantId, { ticketId: "901" });
    await withContext(current, { orderReference: "1001" });

    const history = await assembleCustomerHistory(tenantId, current);

    const notice = history.notices.find(
      (n) => n.code === "repeat_contact_same_subject"
    );
    expect(notice?.severity).toBe("warning");
    expect(notice?.message).toContain("#900");
  });

  it("never reports the current issue as its own history", async () => {
    const current = await createIssue(db, tenantId, { ticketId: "901" });
    await withContext(current, { orderReference: "1001" });
    await withRefund(current);

    const history = await assembleCustomerHistory(tenantId, current);

    expect(history.priorInteractions).toHaveLength(0);
    expect(history.notices).toHaveLength(0);
  });

  it("does not link customers who both have no requester id", async () => {
    // Two anonymous tickets are two strangers. Grouping them would show one
    // person's refunds to another.
    const past = await createIssue(db, tenantId, {
      ticketId: "900",
      customerId: null,
    });
    await withContext(past, { orderReference: "1001" });
    await withRefund(past);

    const current = await createIssue(db, tenantId, {
      ticketId: "901",
      customerId: null,
    });
    await withContext(current, { orderReference: "1001" });

    const history = await assembleCustomerHistory(tenantId, current);

    expect(history.customerId).toBeNull();
    expect(history.priorInteractions).toHaveLength(0);
    expect(history.notices).toHaveLength(0);
  });

  it("does not cross tenants", async () => {
    const otherTenant = await createTenant(db);
    const theirIssue = await createIssue(db, otherTenant, { ticketId: "900" });
    await withOtherTenantContext(otherTenant, theirIssue, "1001");

    const current = await createIssue(db, tenantId, { ticketId: "901" });
    await withContext(current, { orderReference: "1001" });

    const history = await assembleCustomerHistory(tenantId, current);

    expect(history.priorInteractions).toHaveLength(0);
  });

  async function withOtherTenantContext(
    otherTenantId: string,
    issueId: string,
    orderRef: string
  ) {
    await db.driver.query(
      `INSERT INTO issue_context
         (tenant_id, issue_id, extractor_version, order_reference,
          primary_ask, highlights, message_count)
       VALUES ($1, $2, 'extract_v1', $3, 'refund_request', '[]'::jsonb, 1)`,
      [otherTenantId, issueId, orderRef]
    );
  }

  it("totals prior refunds only when the currency is consistent", async () => {
    const usd1 = await createIssue(db, tenantId, { ticketId: "900" });
    await withContext(usd1, { orderReference: "1001" });
    await withRefund(usd1, { amountCents: 1000, currency: "usd" });

    const usd2 = await createIssue(db, tenantId, { ticketId: "901" });
    await withContext(usd2, { orderReference: "1002" });
    await withRefund(usd2, { amountCents: 2500, currency: "usd" });

    const current = await createIssue(db, tenantId, { ticketId: "902" });
    await withContext(current, { orderReference: "3003" });

    const history = await assembleCustomerHistory(tenantId, current);

    const total = history.notices.find((n) => n.code === "prior_refunds_total");
    expect(total?.message).toContain("$35.00");
  });

  it("omits a total rather than summing across currencies", async () => {
    // $10 + ¥2500 is not 2510 of anything.
    const usd = await createIssue(db, tenantId, { ticketId: "900" });
    await withContext(usd, { orderReference: "1001" });
    await withRefund(usd, { amountCents: 1000, currency: "usd" });

    const jpy = await createIssue(db, tenantId, { ticketId: "901" });
    await withContext(jpy, { orderReference: "1002" });
    await withRefund(jpy, { amountCents: 2500, currency: "jpy" });

    const current = await createIssue(db, tenantId, { ticketId: "902" });
    await withContext(current, { orderReference: "3003" });

    const history = await assembleCustomerHistory(tenantId, current);

    expect(
      history.notices.find((n) => n.code === "prior_refunds_total")
    ).toBeUndefined();
  });

  it("does not scale zero-decimal currencies", async () => {
    const past = await createIssue(db, tenantId, { ticketId: "900" });
    await withContext(past, { orderReference: "1001" });
    await withRefund(past, { amountCents: 500, currency: "jpy" });

    const current = await createIssue(db, tenantId, { ticketId: "901" });
    await withContext(current, { orderReference: "1001" });

    const history = await assembleCustomerHistory(tenantId, current);

    const critical = history.notices.find(
      (n) => n.code === "prior_refund_same_subject"
    );
    // ¥500 is five hundred yen, not five.
    expect(critical?.message).toContain("500");
    expect(critical?.message).not.toContain("5.00");
  });

  it("stays quiet for a customer with an unremarkable history", async () => {
    const past = await createIssue(db, tenantId, { ticketId: "900" });
    await withContext(past, { orderReference: "1001", primaryAsk: "status_check" });

    const current = await createIssue(db, tenantId, { ticketId: "901" });
    await withContext(current, { orderReference: "2002" });

    const history = await assembleCustomerHistory(tenantId, current);

    expect(history.notices).toHaveLength(0);
    expect(history.priorIssueCount).toBe(1);
  });

  it("returns newest first and marks when more history exists", async () => {
    const base = Date.parse("2026-01-01T00:00:00Z");
    for (let i = 0; i < 12; i++) {
      const issue = await createIssue(db, tenantId, {
        ticketId: `9${String(i).padStart(2, "0")}`,
        createdAt: new Date(base + i * 86_400_000),
      });
      await withContext(issue, { orderReference: `100${i}` });
    }

    const current = await createIssue(db, tenantId, {
      ticketId: "999",
      createdAt: new Date(base + 20 * 86_400_000),
    });
    await withContext(current, { orderReference: "5005" });

    const history = await assembleCustomerHistory(tenantId, current);

    expect(history.priorInteractions).toHaveLength(10);
    expect(history.truncated).toBe(true);
    const times = history.priorInteractions.map((i) =>
      new Date(i.openedAt).getTime()
    );
    expect([...times].sort((a, b) => b - a)).toEqual(times);
  });

  it("survives an issue that was never ingested", async () => {
    // No issue_context row at all for this one.
    await createIssue(db, tenantId, { ticketId: "900" });
    const current = await createIssue(db, tenantId, { ticketId: "901" });
    await withContext(current, { orderReference: "1001" });

    const history = await assembleCustomerHistory(tenantId, current);

    expect(history.priorIssueCount).toBe(1);
    expect(history.priorInteractions[0].primaryAsk).toBeNull();
    expect(history.priorInteractions[0].sameSubject).toBe(false);
  });
});
