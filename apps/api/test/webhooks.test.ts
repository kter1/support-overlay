/**
 * Webhook signature verification.
 *
 * Signatures were previously computed over JSON.stringify(request.body) — the
 * re-serialized parse, not the bytes the provider signed — so verification
 * could never succeed against real traffic. Secrets also fell back to
 * hardcoded literals published in this repository.
 *
 * These tests build requests the way a provider does: sign exact bytes, then
 * check that verification accepts them and rejects everything else.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createHmac } from "crypto";
import Fastify, { FastifyInstance } from "fastify";
import { createTestDb, createTenant, TestDb } from "./helpers/db";
import { hashToken } from "../src/middleware/auth";
import { webhookRoutes } from "../src/routes/webhooks";
import { correlationIdMiddleware } from "../src/middleware/correlationId";

const WEBHOOK_TOKEN = "webhook-token-under-test";
const STRIPE_SECRET = "whsec_test_stripe";
const SHOPIFY_SECRET = "shpss_test_shopify";

/** Mirrors the raw-body parser configured in server.ts. */
function buildApp(): FastifyInstance {
  const app = Fastify();

  app.addContentTypeParser(
    "application/json",
    { parseAs: "buffer" },
    (request, body: Buffer, done) => {
      (request as typeof request & { rawBody?: Buffer }).rawBody = body;
      if (body.length === 0) return done(null, undefined);
      try {
        done(null, JSON.parse(body.toString("utf8")));
      } catch (err) {
        const error = err as Error & { statusCode?: number };
        error.statusCode = 400;
        done(error, undefined);
      }
    }
  );

  app.addHook("onRequest", correlationIdMiddleware);
  app.register(webhookRoutes, { prefix: "/webhooks" });
  return app;
}

describe("webhook signature verification", () => {
  let db: TestDb;
  let app: FastifyInstance;
  let tenantId: string;

  beforeEach(async () => {
    db = await createTestDb();
    tenantId = await createTenant(db);

    await db.driver.query(
      `INSERT INTO api_credentials (tenant_id, role, token_sha256, principal_id)
       VALUES ($1, 'webhook', $2, 'hook')`,
      [tenantId, hashToken(WEBHOOK_TOKEN)]
    );
    await db.driver.query(
      `INSERT INTO tenant_integrations (tenant_id, source_system, webhook_secret)
       VALUES ($1, 'stripe', $2), ($1, 'shopify', $3)`,
      [tenantId, STRIPE_SECRET, SHOPIFY_SECRET]
    );

    app = buildApp();
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    await db.close();
  });

  /** Sign exactly the bytes being sent, as Stripe does. */
  function stripeHeaders(raw: string, secret = STRIPE_SECRET, skewSeconds = 0) {
    const timestamp = Math.floor(Date.now() / 1000) - skewSeconds;
    const signature = createHmac("sha256", secret)
      .update(`${timestamp}.${raw}`)
      .digest("hex");
    return { "stripe-signature": `t=${timestamp},v1=${signature}` };
  }

  async function eventStatus(externalId: string): Promise<string | null> {
    const result = await db.driver.query<{ status: string }>(
      `SELECT status FROM inbound_events WHERE external_event_id = $1`,
      [externalId]
    );
    return result.rows[0]?.status ?? null;
  }

  async function postStripe(raw: string, headers: Record<string, string>) {
    return app.inject({
      method: "POST",
      url: "/webhooks/stripe",
      headers: {
        authorization: `Bearer ${WEBHOOK_TOKEN}`,
        "content-type": "application/json",
        ...headers,
      },
      payload: raw,
    });
  }

  it("rejects an unauthenticated caller", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/webhooks/stripe",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ id: "evt_noauth" }),
    });

    expect(response.statusCode).toBe(401);
  });

  it("accepts a correctly signed payload", async () => {
    const raw = JSON.stringify({ id: "evt_ok", type: "charge.refunded", created: 1 });

    const response = await postStripe(raw, stripeHeaders(raw));

    expect(response.statusCode).toBe(200);
    expect(await eventStatus("evt_ok")).toBe("PROCESSED");
  });

  it("accepts a payload whose key order would not survive re-serialization", async () => {
    // The exact case the old implementation could not handle: valid JSON whose
    // byte sequence differs from what JSON.stringify(parsed) produces.
    const raw = '{"type":"charge.refunded","created":1,"id":"evt_order"}';

    const response = await postStripe(raw, stripeHeaders(raw));

    expect(response.statusCode).toBe(200);
    expect(await eventStatus("evt_order")).toBe("PROCESSED");
  });

  it("rejects a tampered payload", async () => {
    const raw = JSON.stringify({ id: "evt_tampered", type: "charge.refunded", created: 1 });
    const headers = stripeHeaders(raw);
    const tampered = JSON.stringify({
      id: "evt_tampered",
      type: "charge.refunded",
      created: 999,
    });

    const response = await postStripe(tampered, headers);

    expect(response.statusCode).toBe(200); // ack, but not trusted
    expect(await eventStatus("evt_tampered")).toBe("FAILED");
  });

  it("rejects a signature made with the wrong secret", async () => {
    const raw = JSON.stringify({ id: "evt_wrongkey", type: "charge.refunded", created: 1 });

    const response = await postStripe(raw, stripeHeaders(raw, "whsec_attacker"));

    expect(response.statusCode).toBe(200);
    expect(await eventStatus("evt_wrongkey")).toBe("FAILED");
  });

  it("rejects a replayed timestamp outside the tolerance window", async () => {
    const raw = JSON.stringify({ id: "evt_replay", type: "charge.refunded", created: 1 });

    const response = await postStripe(raw, stripeHeaders(raw, STRIPE_SECRET, 3600));

    expect(response.statusCode).toBe(200);
    expect(await eventStatus("evt_replay")).toBe("FAILED");
  });

  it("rejects an unsigned request", async () => {
    const raw = JSON.stringify({ id: "evt_unsigned", type: "charge.refunded", created: 1 });

    const response = await postStripe(raw, {});

    expect(response.statusCode).toBe(200);
    expect(await eventStatus("evt_unsigned")).toBe("FAILED");
  });

  it("fails closed when the tenant has no configured secret", async () => {
    // No zendesk row exists for this tenant, so there is nothing to verify
    // against. The old code fell back to a published default instead.
    const raw = JSON.stringify({ id: "evt_nosecret", ticket: { id: "1" } });
    const signature = createHmac("sha256", "dev_zendesk_webhook_secret")
      .update(raw)
      .digest("base64");

    const response = await app.inject({
      method: "POST",
      url: "/webhooks/zendesk",
      headers: {
        authorization: `Bearer ${WEBHOOK_TOKEN}`,
        "content-type": "application/json",
        "x-zendesk-webhook-signature": signature,
      },
      payload: raw,
    });

    expect(response.statusCode).toBe(200);
    expect(await eventStatus("evt_nosecret")).toBe("FAILED");
  });

  it("verifies a Shopify base64 HMAC over raw bytes", async () => {
    const raw = JSON.stringify({ id: "evt_shopify", updated_at: "2024-01-01T00:00:00Z" });
    const hmac = createHmac("sha256", SHOPIFY_SECRET).update(raw).digest("base64");

    const response = await app.inject({
      method: "POST",
      url: "/webhooks/shopify",
      headers: {
        authorization: `Bearer ${WEBHOOK_TOKEN}`,
        "content-type": "application/json",
        "x-shopify-hmac-sha256": hmac,
        "x-shopify-topic": "orders/updated",
      },
      payload: raw,
    });

    expect(response.statusCode).toBe(200);
    expect(await eventStatus("evt_shopify")).toBe("PROCESSED");
  });

  it("treats a duplicate event id as a duplicate", async () => {
    const raw = JSON.stringify({ id: "evt_dupe", type: "charge.refunded", created: 1 });

    await postStripe(raw, stripeHeaders(raw));
    await postStripe(raw, stripeHeaders(raw));

    const result = await db.driver.query(
      `SELECT id FROM inbound_events WHERE external_event_id = 'evt_dupe'`
    );
    expect(result.rows).toHaveLength(1);
    expect(await eventStatus("evt_dupe")).toBe("DUPLICATE");
  });

  // ─── Issue identity, as written from a ticket ──────────────────────────────
  //
  // These two fields feed customer history, and both have a failure mode that
  // is invisible on the ticket that caused it and only shows up later, on a
  // different ticket, as a wrong statement about a real customer.

  describe("issue identity from a ticket", () => {
    async function postTicket(ticket: Record<string, unknown>) {
      return app.inject({
        method: "POST",
        url: "/webhooks/fixture",
        headers: {
          authorization: `Bearer ${WEBHOOK_TOKEN}`,
          "content-type": "application/json",
        },
        payload: JSON.stringify({
          source_system: "zendesk",
          event_type: "ticket.created",
          payload: { tags: ["refund"], ...ticket },
        }),
      });
    }

    async function issueFor(ticketId: string) {
      const result = await db.driver.query<{
        customer_id: string | null;
        opened_at: string;
        created_at: string;
      }>(
        `SELECT i.customer_id, i.opened_at, i.created_at
           FROM issues i
           JOIN issue_tickets t ON t.issue_id = i.id
          WHERE t.zendesk_ticket_id = $1`,
        [ticketId]
      );
      return result.rows[0] ?? null;
    }

    it("dates the issue from when the customer wrote in", async () => {
      await postTicket({
        id: "70001",
        subject: "Refund please",
        description: "refund for order #1001",
        requester_id: 5150,
        created_at: "2026-01-16T10:00:00Z",
      });

      const issue = await issueFor("70001");
      expect(issue).not.toBeNull();
      // Not the insert time: history shows this date next to a refund amount.
      expect(new Date(issue!.opened_at).toISOString()).toBe(
        "2026-01-16T10:00:00.000Z"
      );
    });

    it("falls back to now rather than trusting an unusable timestamp", async () => {
      const before = Date.now() - 1000;

      await postTicket({
        id: "70002",
        subject: "Refund please",
        description: "refund for order #1001",
        requester_id: 5151,
        created_at: "not a date",
      });

      const issue = await issueFor("70002");
      expect(new Date(issue!.opened_at).getTime()).toBeGreaterThanOrEqual(before);
    });

    it("rejects a far-future timestamp that would sort above every real issue", async () => {
      await postTicket({
        id: "70003",
        subject: "Refund please",
        description: "refund for order #1001",
        requester_id: 5152,
        created_at: "2099-01-01T00:00:00Z",
      });

      const issue = await issueFor("70003");
      expect(new Date(issue!.opened_at).getFullYear()).toBeLessThan(2099);
    });

    it("stores no customer id rather than an empty one", async () => {
      // "" is a value, and every anonymous ticket would share it — which would
      // show one customer's refund history to another.
      await postTicket({
        id: "70004",
        subject: "Refund please",
        description: "refund for order #1001",
      });

      const issue = await issueFor("70004");
      expect(issue!.customer_id).toBeNull();
    });
  });
});
