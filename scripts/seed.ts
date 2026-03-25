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
 */

import { Pool } from "pg";
import * as fs from "fs";
import * as path from "path";

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
      `SELECT id FROM tenants WHERE id = '00000000-0000-0000-0000-000000000001' LIMIT 1`
    );

    if (rows.length > 0) {
      console.log("✓ Demo seed data already present — skipping (run demo:reset for a fresh start)");
      return;
    }

    // ── Apply seed ────────────────────────────────────────────────────────
    console.log("Seeding demo data...");
    const seedSql = fs.readFileSync(SEED_FILE, "utf-8");

    await client.query("BEGIN");
    await client.query(seedSql);
    await client.query("COMMIT");

    console.log("✓ Demo data seeded:");
    console.log("  Tenant:   Acme Support Co (00000000-0000-0000-0000-000000000001)");
    console.log("  Tickets:  10001 (happy path), 10002 (degraded), 10003 (retry)");
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
