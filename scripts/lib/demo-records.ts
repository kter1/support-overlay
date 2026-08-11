/**
 * @file scripts/lib/demo-records.ts
 * @description The provider side of the demo.
 *
 * The overlay's whole claim is that pointing at "8/1" or "$39" produces the
 * record behind it. That requires records to exist — a customer with a purchase
 * history the extractor's spans can be matched against.
 *
 * These go into the connector simulators rather than the database, because the
 * resolution path reads them through the same adapters production uses. Seeding
 * the answers straight into Postgres would demo a code path no real ticket
 * takes.
 */
import { shopifySimulator, stripeSimulator } from "@iisl/connectors";

/** Matches `issues.customer_id` for the food-delivery ticket in db/seed.sql. */
export const DEMO_FOOD_CUSTOMER = "cust_food_006";

/** Matches the customer on the repeat-refund tickets. */
export const DEMO_REPEAT_CUSTOMER = "cust_repeat_004";

/**
 * When the food order was placed — August 1st, matching the "8/1" in the
 * seeded message.
 *
 * Fixed rather than relative to today, and it does not need to track the
 * current year. The customer wrote no year, so the span resolves on month and
 * day against whatever the records say, and the year on the card comes back
 * from this order. That is the behaviour worth demonstrating: run the demo in
 * 2030 and the date still resolves, still to 2026.
 */
export const DEMO_ORDER_PLACED = "2026-08-01T19:42:00Z";

export function seedDemoProviderRecords(): void {
  const placed = new Date(DEMO_ORDER_PLACED);

  // ── The food-delivery ticket ────────────────────────────────────────────────
  // A $39 order that was charged and never delivered. Hovering the date finds
  // the order; hovering the amount finds the charge.
  shopifySimulator.seedOrder({
    id: "order_food_4471",
    name: "#4471",
    financial_status: "paid",
    fulfillment_status: null,
    total_price: "39.00",
    subtotal_price: "39.00",
    currency: "USD",
    created_at: placed.toISOString(),
    updated_at: placed.toISOString(),
    customer: { id: DEMO_FOOD_CUSTOMER, email: "sam@example.com" },
    line_items: [
      { id: 41, title: "McDonald's — Cedar & 3rd", quantity: 1, price: "39.00", sku: "MCD-4471" },
    ],
  });

  stripeSimulator.seedCharge({
    id: "ch_food_4471",
    object: "charge",
    amount: 3900,
    currency: "usd",
    status: "succeeded",
    refunded: false,
    amount_refunded: 0,
    created: Math.floor(placed.getTime() / 1000),
    customer: DEMO_FOOD_CUSTOMER,
    description: "McDonald's — Cedar & 3rd",
  });

  // A second, unrelated order for the same customer on a different day. Present
  // so the demo is not a single-record fixture where any match looks right, and
  // so "$39" has something it must *not* match.
  shopifySimulator.seedOrder({
    id: "order_food_4210",
    name: "#4210",
    financial_status: "paid",
    fulfillment_status: "fulfilled",
    total_price: "22.50",
    subtotal_price: "22.50",
    currency: "USD",
    created_at: new Date(placed.getTime() - 12 * 86_400_000).toISOString(),
    updated_at: new Date(placed.getTime() - 12 * 86_400_000).toISOString(),
    customer: { id: DEMO_FOOD_CUSTOMER, email: "sam@example.com" },
    line_items: [
      { id: 42, title: "Thai Basil Kitchen", quantity: 1, price: "22.50", sku: "TBK-4210" },
    ],
  });

  // ── The repeat-refund tickets ───────────────────────────────────────────────
  // Order #1001 already exists as a fixture; give it this customer so their
  // history is listable and the duplicate-refund case still resolves.
  shopifySimulator.seedOrder({
    id: "order_happy_001",
    name: "#1001",
    financial_status: "refunded",
    fulfillment_status: "fulfilled",
    total_price: "49.99",
    subtotal_price: "49.99",
    currency: "USD",
    created_at: "2026-01-15T00:00:00Z",
    updated_at: "2026-01-16T00:00:00Z",
    customer: { id: DEMO_REPEAT_CUSTOMER, email: "dana@example.com" },
    line_items: [
      { id: 1, title: "Widget Pro", quantity: 1, price: "49.99", sku: "WP-001" },
    ],
    refunds: [
      {
        id: 1,
        created_at: "2026-01-16T00:00:00Z",
        transactions: [{ amount: "49.99", currency: "USD", status: "success" }],
      },
    ],
  });

  stripeSimulator.seedCharge({
    id: "ch_001",
    object: "charge",
    amount: 4999,
    currency: "usd",
    status: "succeeded",
    refunded: true,
    amount_refunded: 4999,
    created: Math.floor(Date.parse("2026-01-15T00:00:00Z") / 1000),
    customer: DEMO_REPEAT_CUSTOMER,
    description: "Widget Pro",
  });
}
