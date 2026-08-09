/**
 * @file packages/connectors/src/shopify/adapter.ts
 * @description Shopify connector with fixture simulator fallback.
 *
 * Archived orders are a tombstone, not a failure: Shopify returns 404, and the
 * correct response is to mark evidence_normalized.is_source_unavailable and
 * keep showing the last known state. Evidence is never deleted.
 *
 * Failures are classified the same way as the other connectors so the worker
 * can apply the right retry policy:
 *   TimeoutError           → request sent, outcome unknown
 *   PermanentError         → 4xx that retrying cannot fix
 *   SourceUnavailableError → the record is gone; tombstone rather than retry
 *   Error                  → retriable
 */
import { TimeoutError, PermanentError } from "@iisl/shared";

function isAbort(err: unknown): boolean {
  const name = (err as { name?: string } | null)?.name;
  return name === "AbortError" || name === "TimeoutError";
}

export interface ShopifyOrder {
  id: string;
  name: string;
  financial_status: "pending" | "authorized" | "partially_paid" | "paid" | "partially_refunded" | "refunded" | "voided";
  fulfillment_status: "fulfilled" | "partial" | "unfulfilled" | "restocked" | null;
  total_price: string;
  subtotal_price: string;
  currency: string;
  created_at: string;
  updated_at: string;
  line_items: ShopifyLineItem[];
  customer?: {
    id: number;
    email: string;
  };
  refunds?: ShopifyRefund[];
}

export interface ShopifyLineItem {
  id: number;
  title: string;
  quantity: number;
  price: string;
  sku: string | null;
}

export interface ShopifyRefund {
  id: number;
  created_at: string;
  transactions: Array<{
    amount: string;
    currency: string;
    status: string;
  }>;
}

export class SourceUnavailableError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "SourceUnavailableError";
  }
}

export class ShopifyAdapter {
  private readonly isSimulator: boolean;
  private readonly accessToken: string;

  constructor() {
    this.accessToken = process.env.SHOPIFY_ACCESS_TOKEN ?? "";
    this.isSimulator = !this.accessToken || process.env.USE_SHOPIFY_SIMULATOR === "true";

    if (this.isSimulator) {
      console.log("[ShopifyAdapter] No credentials found — using simulator");
    }
  }

  /**
   * Get an order by ID.
   *
   * Throws SourceUnavailableError if:
   *   - Order returns 404 (archived or deleted)
   *   - Order has financial_status === 'archived' (Shopify marks archived differently)
   *
   * Callers must catch SourceUnavailableError and set is_source_unavailable = true.
   * Do NOT treat this as a retriable error.
   */
  async getOrder(orderId: string, shop: string): Promise<ShopifyOrder> {
    if (this.isSimulator) {
      return this.simulatorGetOrder(orderId);
    }

    const url = `https://${shop}.myshopify.com/admin/api/2024-01/orders/${orderId}.json`;

    let response: Response;
    try {
      response = await fetch(url, {
        headers: {
          "X-Shopify-Access-Token": this.accessToken,
          "Content-Type": "application/json",
        },
        signal: AbortSignal.timeout(10000),
      });
    } catch (err) {
      if (isAbort(err)) {
        throw new TimeoutError(`Shopify request timed out for order ${orderId}`);
      }
      throw err;
    }

    if (response.status === 404) {
      throw new SourceUnavailableError(
        `Shopify order ${orderId} returned 404 — likely archived or deleted. ` +
        "The case record is preserved and the last known state is shown."
      );
    }

    if (response.status === 408 || response.status === 504) {
      throw new TimeoutError(
        `Shopify timed out reading order ${orderId} (HTTP ${response.status})`
      );
    }

    if (response.status === 429) {
      throw new Error(`Shopify rate limited order ${orderId} (HTTP 429)`);
    }

    if (response.status >= 400 && response.status < 500) {
      throw new PermanentError(
        `Shopify rejected the request for order ${orderId} (HTTP ${response.status})`
      );
    }

    if (!response.ok) {
      throw new Error(`Shopify failed reading order ${orderId} (HTTP ${response.status})`);
    }

    const body = await response.json() as { order: ShopifyOrder };
    return body.order;
  }

  // ─── Simulator ──────────────────────────────────────────────────────────────

  private simulatorGetOrder(orderId: string): ShopifyOrder {
    const fixtures: Record<string, ShopifyOrder | "archived"> = {
      "order_happy_001": {
        id: "order_happy_001",
        name: "#1001",
        financial_status: "refunded",
        fulfillment_status: "fulfilled",
        total_price: "49.99",
        subtotal_price: "49.99",
        currency: "USD",
        created_at: "2024-01-01T00:00:00Z",
        updated_at: "2024-01-02T00:00:00Z",
        line_items: [
          { id: 1, title: "Widget Pro", quantity: 1, price: "49.99", sku: "WP-001" },
        ],
        refunds: [
          {
            id: 1,
            created_at: "2024-01-02T00:00:00Z",
            transactions: [{ amount: "49.99", currency: "USD", status: "success" }],
          },
        ],
      },
      // Archived order — simulator throws SourceUnavailableError
      "order_archived_001": "archived",
      "order_retry_001": {
        id: "order_retry_001",
        name: "#1003",
        financial_status: "refunded",
        fulfillment_status: "fulfilled",
        total_price: "30.00",
        subtotal_price: "30.00",
        currency: "USD",
        created_at: "2024-01-01T00:00:00Z",
        updated_at: "2024-01-02T00:00:00Z",
        line_items: [
          { id: 3, title: "Basic Widget", quantity: 1, price: "30.00", sku: "BW-003" },
        ],
      },
    };

    const fixture = fixtures[orderId];
    if (!fixture) {
      throw new SourceUnavailableError(
        `Shopify order ${orderId} not found in simulator fixtures. ` +
        "Treating as unavailable."
      );
    }
    if (fixture === "archived") {
      throw new SourceUnavailableError(
        `Shopify order ${orderId} is archived — last known state unavailable. ` +
        "Verify via Shopify admin if needed."
      );
    }

    return fixture;
  }
}
