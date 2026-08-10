#!/usr/bin/env ts-node
/**
 * @file scripts/seed.ts
 * @description Idempotent seed runner for demo data.
 *
 * Safe to run multiple times — checks for existing demo tenant before inserting.
 * Skips seed if the demo tenant already exists. Use npm run demo:reset to
 * get a completely fresh database.
 *
 * Inserts:
 *   - Demo tenant (Acme Support Co)
 *   - Tenant config (approvals OFF, 5min freshness window)
 *   - Tenant integrations (all simulators)
 *   - 3 demo scenarios: happy path, degraded, retry+unknown-outcome
 *   - Evidence raw snapshots and normalized evidence for each
 *   - Evidence match results
 *   - Issue card state (read model)
 *   - One seeded action execution + outbox message (Scenario 3)
 *   - Audit log entries for Scenario 3
 *   - Conversation bodies, with annotations computed by the real extractor
 */

import { Pool } from "pg";
import { createHash } from "crypto";
import * as fs from "fs";
import * as path from "path";
import { generateSeedAnnotations } from "./lib/seed-annotations";

const DEMO_TENANT = "00000000-0000-0000-0000-000000000001";

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/**
 * Provision API credentials from the environment.
 *
 * Only the SHA-256 hash is stored, and the plaintext never enters seed.sql, so
 * a usable token is never committed. Re-running rotates the stored hash to
 * whatever the current environment holds.
 */
async function seedCredentials(client: {
  query: (sql: string, params?: unknown[]) => Promise<unknown>;
}): Promise<void> {
  const credentials: Array<{ role: string; token?: string; principal: string }> = [
    { role: "agent", token: process.env.AGENT_TOKEN, principal: "agent-demo-001" },
    { role: "operator", token: process.env.OPERATOR_TOKEN, principal: "operator-demo" },
    { role: "webhook", token: process.env.WEBHOOK_TOKEN, principal: "webhook-ingest" },
  ];

  for (const credential of credentials) {
    if (!credential.token) {
      console.warn(
        `  ! ${credential.role.toUpperCase()}_TOKEN not set — skipping ${credential.role} credential`
      );
      continue;
    }

    await client.query(
      `INSERT INTO api_credentials (tenant_id, role, token_sha256, principal_id, description)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (token_sha256) DO UPDATE
         SET is_active = true, revoked_at = NULL`,
      [
        DEMO_TENANT,
        credential.role,
        sha256(credential.token),
        credential.principal,
        `Demo ${credential.role} credential`,
      ]
    );
    console.log(`  ✓ ${credential.role} credential provisioned`);
  }
}

/**
 * Webhook signing secrets are per-tenant. Without one configured, webhook
 * verification fails closed rather than falling back to a shared default.
 */
async function seedWebhookSecrets(client: {
  query: (sql: string, params?: unknown[]) => Promise<unknown>;
}): Promise<void> {
  const secrets: Array<[string, string | undefined]> = [
    ["zendesk", process.env.ZENDESK_WEBHOOK_SECRET],
    ["stripe", process.env.STRIPE_WEBHOOK_SECRET],
    ["shopify", process.env.SHOPIFY_WEBHOOK_SECRET],
  ];

  for (const [system, secret] of secrets) {
    if (!secret) continue;
    await client.query(
      `UPDATE tenant_integrations SET webhook_secret = $3, updated_at = now()
        WHERE tenant_id = $1 AND source_system = $2`,
      [DEMO_TENANT, system, secret]
    );
    console.log(`  ✓ ${system} webhook secret set`);
  }
}

/** Compute the demo's spans with the real extractor. See lib/seed-annotations. */
async function seedAnnotations(client: {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }>;
}): Promise<void> {
  const count = await generateSeedAnnotations(client);
  console.log(`  \u2713 annotations computed for ${count} conversation(s)`);
}

function normalizeDatabaseUrl(raw?: string): string | undefined {
  if (!raw) return raw;
  try {
    const parsed = new URL(raw);
    // Prefer IPv4 loopback so local Docker Postgres is selected reliably.
    if (parsed.hostname === "localhost") {
      parsed.hostname = "127.0.0.1";
      return parsed.toString();
    }
  } catch {
    // Keep original value; pg will emit a clear error.
  }
  return raw;
}

const pool = new Pool({ connectionString: normalizeDatabaseUrl(process.env.DATABASE_URL) });
const SEED_FILE = path.join(__dirname, "../db/seed.sql");

async function main() {
  const client = await pool.connect();

  try {
    // ── Idempotency check ─────────────────────────────────────────────────
    const { rows } = await client.query<{ id: string }>(
      `SELECT id FROM tenants WHERE id = $1 LIMIT 1`,
      [DEMO_TENANT]
    );

    if (rows.length > 0) {
      // Data is already there, but credentials still track the current
      // environment — re-provision them so a rotated token keeps working.
      console.log("✓ Demo data already present — refreshing credentials only");
      await client.query("BEGIN");
      await seedCredentials(client);
      await seedWebhookSecrets(client);
      await client.query("COMMIT");
      return;
    }

    // ── Apply seed ────────────────────────────────────────────────────────
    console.log("Seeding demo data...");
    const seedSql = fs.readFileSync(SEED_FILE, "utf-8");

    await client.query("BEGIN");
    await client.query(seedSql);
    await seedCredentials(client);
    await seedWebhookSecrets(client);
    await seedAnnotations(client);
    await client.query("COMMIT");

    console.log("✓ Demo data seeded:");
    console.log(`  Tenant:   Acme Support Co (${DEMO_TENANT})`);
    console.log("  Tickets:  10001 (happy path), 10002 (degraded),");
    console.log("            10003 (awaiting reconciliation), 10005 (already refunded)");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    console.error("✗ Seed failed:", err);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

main();
