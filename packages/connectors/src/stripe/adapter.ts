/**
 * @file packages/connectors/src/stripe/adapter.ts
 * @description Stripe connector with a fixture simulator fallback.
 *
 * When STRIPE_API_KEY is not set (local demo default) this uses the simulator.
 * Simulator responses mirror real Stripe API shapes.
 *
 * Retry classification:
 *   - getRefund / listRefundsByCharge → reads, safe to retry
 *   - createRefund                    → OPERATOR_RETRY_ONLY. Money movement is
 *                                       never auto-retried. On an uncertain
 *                                       outcome the worker blocks for an
 *                                       operator instead of re-sending.
 *
 * Every refund carries two idempotency guards:
 *   1. The Stripe `Idempotency-Key` header, so a replay of the identical
 *      request returns the original refund rather than creating a second one.
 *   2. `metadata.effect_key`, so reconciliation can determine whether *our*
 *      specific refund landed, even if the response was never received.
 */
import { TimeoutError, PermanentError, isTimeoutError } from "@iisl/shared";

export interface StripeRefund {
  id: string;
  object: "refund";
  amount: number;
  currency: string;
  status: "succeeded" | "pending" | "failed" | "canceled";
  charge: string;
  created: number;
  reason: string | null;
  failure_reason?: string;
  metadata?: Record<string, string>;
}

export interface StripeCharge {
  id: string;
  object: "charge";
  amount: number;
  currency: string;
  status: "succeeded" | "pending" | "failed";
  refunded: boolean;
  amount_refunded: number;
  created: number;
}

export interface CreateRefundInput {
  chargeId: string;
  amountCents: number;
  /** Deterministic effect key; used for the Idempotency-Key and metadata. */
  effectKey: string;
  reason?: string;
}

function isAbort(err: unknown): boolean {
  const name = (err as { name?: string } | null)?.name;
  return name === "AbortError" || name === "TimeoutError";
}

export class StripeAdapter {
  private readonly isSimulator: boolean;
  private readonly apiKey: string;

  constructor() {
    this.apiKey = process.env.STRIPE_API_KEY ?? "";
    this.isSimulator = !this.apiKey || process.env.USE_STRIPE_SIMULATOR === "true";

    if (this.isSimulator) {
      console.log("[StripeAdapter] No credentials found — using simulator");
    }
  }

  /**
   * Create a refund. This is the only money-moving call in the system.
   *
   * A TimeoutError here does NOT mean the refund failed — it means the outcome
   * is unknown. Callers must not retry on that; they must reconcile.
   */
  async createRefund(input: CreateRefundInput): Promise<StripeRefund> {
    if (this.isSimulator) {
      return stripeSimulator.createRefund(input);
    }

    const body = new URLSearchParams({
      charge: input.chargeId,
      amount: String(input.amountCents),
      "metadata[effect_key]": input.effectKey,
    });
    if (input.reason) body.set("reason", input.reason);

    const response = await this.request("POST", "https://api.stripe.com/v1/refunds", {
      body,
      idempotencyKey: input.effectKey,
    });

    await this.assertOk(response, `create refund for ${input.chargeId}`);
    return (await response.json()) as StripeRefund;
  }

  /**
   * Look up a refund by id. Used for SENT_UNCERTAIN reconciliation: if the
   * refund is found, the effect occurred and must never be re-sent.
   */
  async getRefund(refundId: string): Promise<StripeRefund | null> {
    if (this.isSimulator) {
      return stripeSimulator.getRefund(refundId);
    }

    const response = await this.request(
      "GET",
      `https://api.stripe.com/v1/refunds/${refundId}`
    );

    if (response.status === 404) return null;
    await this.assertOk(response, `get refund ${refundId}`);
    return (await response.json()) as StripeRefund;
  }

  /**
   * List refunds for a charge. Used when the refund id is unknown because the
   * create response never arrived — match on metadata.effect_key.
   */
  async listRefundsByCharge(chargeId: string): Promise<StripeRefund[]> {
    if (this.isSimulator) {
      return stripeSimulator.listRefundsByCharge(chargeId);
    }

    const response = await this.request(
      "GET",
      `https://api.stripe.com/v1/refunds?charge=${encodeURIComponent(chargeId)}&limit=100`
    );

    await this.assertOk(response, `list refunds for ${chargeId}`);
    const body = (await response.json()) as { data: StripeRefund[] };
    return body.data;
  }

  /**
   * Reconciliation primitive: did the refund identified by this effect key
   * actually happen? Returns the refund if so, null if definitively not.
   */
  async findRefundByEffectKey(
    chargeId: string,
    effectKey: string
  ): Promise<StripeRefund | null> {
    const refunds = await this.listRefundsByCharge(chargeId);
    return refunds.find((r) => r.metadata?.effect_key === effectKey) ?? null;
  }

  async getCharge(chargeId: string): Promise<StripeCharge | null> {
    if (this.isSimulator) {
      return stripeSimulator.getCharge(chargeId);
    }

    const response = await this.request(
      "GET",
      `https://api.stripe.com/v1/charges/${chargeId}`
    );

    if (response.status === 404) return null;
    await this.assertOk(response, `get charge ${chargeId}`);
    return (await response.json()) as StripeCharge;
  }

  private async request(
    method: string,
    url: string,
    opts: { body?: URLSearchParams; idempotencyKey?: string } = {}
  ): Promise<Response> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.apiKey}`,
    };
    if (opts.body) {
      headers["Content-Type"] = "application/x-www-form-urlencoded";
    }
    if (opts.idempotencyKey) {
      headers["Idempotency-Key"] = opts.idempotencyKey;
    }

    try {
      return await fetch(url, {
        method,
        headers,
        body: opts.body,
        signal: AbortSignal.timeout(15000),
      });
    } catch (err) {
      // The request reached the wire before aborting, so a refund may have been
      // created. Never convert this into a retriable failure.
      if (isAbort(err)) {
        throw new TimeoutError(`Stripe request timed out: ${method} ${url}`);
      }
      throw err;
    }
  }

  private async assertOk(response: Response, what: string): Promise<void> {
    if (response.ok) return;

    if (response.status === 408 || response.status === 504) {
      throw new TimeoutError(`Stripe timed out on ${what} (HTTP ${response.status})`);
    }
    if (response.status === 429) {
      throw new Error(`Stripe rate limited ${what} (HTTP 429)`);
    }
    if (response.status >= 400 && response.status < 500) {
      const detail = await response.text().catch(() => "");
      throw new PermanentError(
        `Stripe rejected ${what} (HTTP ${response.status}) ${detail}`.trim()
      );
    }
    throw new Error(`Stripe failed ${what} (HTTP ${response.status})`);
  }
}

// ─── Simulator ────────────────────────────────────────────────────────────────
// Stateful so that a created refund is subsequently findable — reconciliation
// tests depend on being able to observe an effect that already occurred.

class StripeSimulator {
  private refunds = new Map<string, StripeRefund>();
  private failNextWith: Error | null = null;
  private failNextEffectLanded = true;

  constructor() {
    this.seedFixtures();
  }

  /**
   * Make the next createRefund throw.
   *
   * `effectLanded` distinguishes the two halves of an uncertain outcome, which
   * the system must handle differently: true means the provider created the
   * refund but the response was lost (reconciliation will find it), false means
   * the request never took effect (nothing to find, so a human must decide).
   */
  failNext(err: Error, opts: { effectLanded?: boolean } = {}): void {
    this.failNextWith = err;
    this.failNextEffectLanded = opts.effectLanded ?? true;
  }

  reset(): void {
    this.refunds.clear();
    this.failNextWith = null;
    this.failNextEffectLanded = true;
    this.seedFixtures();
  }

  createRefund(input: CreateRefundInput): StripeRefund {
    if (this.failNextWith) {
      const err = this.failNextWith;
      const landed = this.failNextEffectLanded;
      this.failNextWith = null;
      this.failNextEffectLanded = true;
      // A timeout may still have created the refund — that is precisely why the
      // caller must never treat it as a plain failure and retry.
      if (isTimeoutError(err) && landed) {
        this.record(input);
      }
      throw err;
    }

    // Replaying the same key returns the original refund, as Stripe does.
    const existing = [...this.refunds.values()].find(
      (r) => r.metadata?.effect_key === input.effectKey
    );
    if (existing) return existing;

    return this.record(input);
  }

  private record(input: CreateRefundInput): StripeRefund {
    const refund: StripeRefund = {
      id: `re_sim_${input.effectKey.slice(-12)}`,
      object: "refund",
      amount: input.amountCents,
      currency: "usd",
      status: "succeeded",
      charge: input.chargeId,
      created: Math.floor(Date.now() / 1000),
      reason: input.reason ?? null,
      metadata: { effect_key: input.effectKey },
    };
    this.refunds.set(refund.id, refund);
    return refund;
  }

  getRefund(refundId: string): StripeRefund | null {
    return this.refunds.get(refundId) ?? null;
  }

  listRefundsByCharge(chargeId: string): StripeRefund[] {
    return [...this.refunds.values()].filter((r) => r.charge === chargeId);
  }

  getCharge(chargeId: string): StripeCharge | null {
    const fixtures: Record<string, StripeCharge> = {
      ch_001: { id: "ch_001", object: "charge", amount: 4999, currency: "usd", status: "succeeded", refunded: true, amount_refunded: 4999, created: 1704000000 },
      ch_002: { id: "ch_002", object: "charge", amount: 7500, currency: "usd", status: "succeeded", refunded: false, amount_refunded: 0, created: 1704000000 },
      ch_003: { id: "ch_003", object: "charge", amount: 3000, currency: "usd", status: "succeeded", refunded: true, amount_refunded: 3000, created: 1704000000 },
    };
    return fixtures[chargeId] ?? null;
  }

  private seedFixtures(): void {
    const seed: StripeRefund[] = [
      { id: "re_happy_001", object: "refund", amount: 4999, currency: "usd", status: "succeeded", charge: "ch_001", created: 1704067200, reason: null },
      { id: "re_degraded_001", object: "refund", amount: 7500, currency: "usd", status: "pending", charge: "ch_002", created: 1704067200, reason: null },
      { id: "re_retry_001", object: "refund", amount: 3000, currency: "usd", status: "succeeded", charge: "ch_003", created: 1704067200, reason: null },
    ];
    for (const refund of seed) this.refunds.set(refund.id, refund);
  }
}

/** Shared simulator instance — adapters are constructed per call. */
export const stripeSimulator = new StripeSimulator();
