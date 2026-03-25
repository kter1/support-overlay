/**
 * @file scripts/migrate.ts
 * @description Database migration runner.
 * Runs all .sql files in db/migrations/ in alphabetical order.
 * Tracks applied migrations in a _migrations table.
 *
 * Usage:
 *   npm run db:migrate          # Apply pending migrations
 *   npm run db:migrate --reset  # Drop all tables and re-run (DESTRUCTIVE)
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
const MIGRATIONS_DIR = path.join(__dirname, "../db/migrations");
const SEED_FILE = path.join(__dirname, "../db/seed.sql");

async function ensureMigrationsTable(pool: Pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS _migrations (
      id SERIAL PRIMARY KEY,
      filename TEXT NOT NULL UNIQUE,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
}

async function getAppliedMigrations(pool: Pool): Promise<Set<string>> {
  const { rows } = await pool.query<{ filename: string }>(
    "SELECT filename FROM _migrations ORDER BY id"
  );
  return new Set(rows.map((r) => r.filename));
}

async function applyMigration(pool: Pool, filename: string, sql: string) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(sql);
    await client.query(
      "INSERT INTO _migrations (filename) VALUES ($1)",
      [filename]
    );
    await client.query("COMMIT");
    console.log(`✓ Applied: ${filename}`);
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

async function resetDatabase(pool: Pool) {
  console.warn("⚠️  RESET: Dropping all tables...");
  await pool.query(`
    DROP SCHEMA public CASCADE;
    CREATE SCHEMA public;
    GRANT ALL ON SCHEMA public TO public;
  `);
  console.log("✓ Database reset complete");
}

async function main() {
  const shouldReset = process.argv.includes("--reset");
  const shouldSeed = process.argv.includes("--seed") || shouldReset;

  try {
    if (shouldReset) {
      await resetDatabase(pool);
    }

    await ensureMigrationsTable(pool);
    const applied = await getAppliedMigrations(pool);

    const allFiles = fs
      .readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith(".sql"))
      .sort();

    // This repo ships a canonical "master schema" migration plus historical
    // split files. For clean local bootstrap, run the canonical file only.
    const files = allFiles.includes("000_schema_reference.sql")
      ? ["000_schema_reference.sql"]
      : allFiles;

    if (allFiles.includes("000_schema_reference.sql") && allFiles.length > 1) {
      console.log(
        "Using canonical migration: 000_schema_reference.sql (skipping split historical files)"
      );
    }

    let pending = 0;
    for (const filename of files) {
      if (applied.has(filename)) {
        console.log(`  (already applied: ${filename})`);
        continue;
      }

      const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, filename), "utf-8");
      await applyMigration(pool, filename, sql);
      pending++;
    }

    if (pending === 0 && !shouldReset) {
      console.log("✓ No pending migrations");
    } else {
      console.log(`✓ Applied ${pending} migration(s)`);
    }

    if (shouldSeed) {
      console.log("Seeding demo data...");
      const seedSql = fs.readFileSync(SEED_FILE, "utf-8");
      await pool.query(seedSql);
      console.log("✓ Seed data applied");
    }
  } catch (err) {
    console.error("Migration failed:", err);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

main();
