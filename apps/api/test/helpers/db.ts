/**
 * Postgres for tests.
 *
 * Two backends, chosen automatically:
 *
 *   TEST_DATABASE_URL set → a real Postgres server, with a throwaway database
 *     per suite. Required for anything that depends on genuine multi-connection
 *     behaviour: FOR UPDATE SKIP LOCKED, row locks, concurrent claims.
 *   otherwise            → PGlite (Postgres compiled to WASM), in-process and
 *     dependency-free, but a single connection.
 *
 * Either way the real files in db/migrations/ are applied, so tests exercise
 * actual SQL — column names, constraints, triggers — and schema/code drift
 * fails here rather than at demo time.
 */
import { PGlite } from "@electric-sql/pglite";
import { Pool } from "pg";
import * as fs from "fs";
import * as path from "path";
import { randomBytes } from "crypto";
import { describe } from "vitest";
import { setDriver, DbDriver } from "../../src/db/pool";

const MIGRATIONS_DIR = path.join(__dirname, "../../../../db/migrations");
const SEED_FILE = path.join(__dirname, "../../../../db/seed.sql");

export interface TestDb {
  driver: DbDriver;
  /** True when backed by a real server, so concurrency assertions are meaningful. */
  isRealPostgres: boolean;
  /** Load db/seed.sql. Off by default so tests start from an empty schema. */
  seed(): Promise<void>;
  /** Run raw SQL that may contain multiple statements. */
  exec(sql: string): Promise<void>;
  close(): Promise<void>;
}

/** A real server is available when TEST_DATABASE_URL points at one. */
export const REAL_POSTGRES_URL = process.env.TEST_DATABASE_URL ?? "";
export const hasRealPostgres = REAL_POSTGRES_URL !== "";

/**
 * Skip helper for suites that are only meaningful against a real server.
 * These are not optional coverage — CI runs a Postgres service so they execute
 * there; locally they skip rather than pass misleadingly.
 */
export const describeRealPostgres = hasRealPostgres ? describe : describe.skip;

/**
 * Adapt PGlite to the slice of the node-postgres interface the app uses.
 * PGlite reports `affectedRows` where pg reports `rowCount`.
 */
function adapt(db: PGlite): DbDriver {
  const run = async (sql: string, params?: unknown[]) => {
    const result = await db.query(sql, params as never[]);
    return {
      rows: result.rows,
      rowCount: result.affectedRows ?? result.rows.length,
      command: "",
      oid: 0,
      fields: [],
    };
  };

  // Single underlying connection: a "checked out" client is the same session.
  // release() is a no-op because there is no pool to return it to.
  const client = {
    query: run,
    release: () => undefined,
  };

  return {
    query: run,
    connect: async () => client,
    end: async () => db.close(),
  } as unknown as DbDriver;
}

function migrationSql(): Array<{ file: string; sql: string }> {
  return fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .map((file) => ({
      file,
      sql: fs.readFileSync(path.join(MIGRATIONS_DIR, file), "utf-8"),
    }));
}

/**
 * Start a fresh database with all migrations applied, and point the app's query
 * helpers at it. Call close() in afterEach to restore the previous driver.
 */
export async function createTestDb(): Promise<TestDb> {
  return hasRealPostgres ? createServerDb() : createPgliteDb();
}

async function createPgliteDb(): Promise<TestDb> {
  const db = new PGlite();

  for (const { file, sql } of migrationSql()) {
    try {
      await db.exec(sql);
    } catch (err) {
      throw new Error(
        `Migration ${file} failed: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  const driver = adapt(db);
  const previous = setDriver(driver);

  return {
    driver,
    isRealPostgres: false,
    async seed() {
      await db.exec(fs.readFileSync(SEED_FILE, "utf-8"));
    },
    async exec(sql: string) {
      await db.exec(sql);
    },
    async close() {
      setDriver(previous);
      await db.close();
    },
  };
}

/**
 * A throwaway database on a real server. Each suite gets its own, so parallel
 * test files cannot see each other's rows.
 */
async function createServerDb(): Promise<TestDb> {
  const dbName = `overlay_test_${randomBytes(6).toString("hex")}`;
  const admin = new Pool({ connectionString: REAL_POSTGRES_URL });

  await admin.query(`CREATE DATABASE ${dbName}`);
  await admin.end();

  const url = new URL(REAL_POSTGRES_URL);
  url.pathname = `/${dbName}`;

  // More than one connection, which is the entire point: concurrency tests need
  // to hold two sessions at once.
  const pool = new Pool({ connectionString: url.toString(), max: 8 });

  for (const { file, sql } of migrationSql()) {
    try {
      await pool.query(sql);
    } catch (err) {
      throw new Error(
        `Migration ${file} failed: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  const driver = pool as unknown as DbDriver;
  const previous = setDriver(driver);

  return {
    driver,
    isRealPostgres: true,
    async seed() {
      await pool.query(fs.readFileSync(SEED_FILE, "utf-8"));
    },
    async exec(sql: string) {
      await pool.query(sql);
    },
    async close() {
      setDriver(previous);
      await pool.end();

      const cleanup = new Pool({ connectionString: REAL_POSTGRES_URL });
      await cleanup.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
      await cleanup.end();
    },
  };
}

/** Insert a tenant with config and return its id. */
export async function createTenant(
  db: TestDb,
  overrides: { approvalsEnabled?: boolean; thresholdCents?: number } = {}
): Promise<string> {
  const result = await db.driver.query<{ id: string }>(
    `INSERT INTO tenants (name, subdomain) VALUES ($1, $2) RETURNING id`,
    ["Test Tenant", `t${Math.random().toString(36).slice(2, 10)}`]
  );
  const tenantId = result.rows[0].id;

  await db.driver.query(
    `INSERT INTO tenant_config
       (tenant_id, approvals_enabled, manager_approval_threshold_cents)
     VALUES ($1, $2, $3)`,
    [
      tenantId,
      overrides.approvalsEnabled ?? false,
      overrides.thresholdCents ?? 5000,
    ]
  );

  return tenantId;
}

/** Insert an issue with a primary Zendesk ticket and return its id. */
export async function createIssue(
  db: TestDb,
  tenantId: string,
  opts: { state?: string; ticketId?: string } = {}
): Promise<string> {
  const result = await db.driver.query<{ id: string }>(
    `INSERT INTO issues (tenant_id, state, customer_id)
     VALUES ($1, $2, $3) RETURNING id`,
    [tenantId, opts.state ?? "OPEN", "cus_test"]
  );
  const issueId = result.rows[0].id;

  await db.driver.query(
    `INSERT INTO issue_tickets (tenant_id, issue_id, zendesk_ticket_id, is_primary)
     VALUES ($1, $2, $3, true)`,
    [tenantId, issueId, opts.ticketId ?? `tkt_${issueId.slice(0, 8)}`]
  );

  return issueId;
}

/** Insert normalized evidence plus a match result for an issue. */
export async function createEvidence(
  db: TestDb,
  tenantId: string,
  issueId: string,
  opts: {
    refundAmountCents?: number;
    isSourceUnavailable?: boolean;
    fetchedAt?: Date;
    matchBand?: string;
    confidenceScore?: number;
  } = {}
): Promise<string> {
  const evidence = await db.driver.query<{ id: string }>(
    `INSERT INTO evidence_normalized
       (tenant_id, issue_id, source_system, source_record_id, normalizer_version,
        refund_status, refund_amount_cents, refund_currency, refund_id,
        charge_id, fetched_at, is_source_unavailable)
     VALUES ($1, $2, 'stripe', 're_test', 'v1', 'succeeded', $3, 'usd',
             're_test', 'ch_test', $4, $5)
     RETURNING id`,
    [
      tenantId,
      issueId,
      opts.refundAmountCents ?? 2500,
      (opts.fetchedAt ?? new Date()).toISOString(),
      opts.isSourceUnavailable ?? false,
    ]
  );

  await db.driver.query(
    `INSERT INTO evidence_match_results
       (tenant_id, issue_id, evidence_normalized_id, match_algorithm_version,
        match_band, confidence_score)
     VALUES ($1, $2, $3, 'v1', $4, $5)`,
    [
      tenantId,
      issueId,
      evidence.rows[0].id,
      opts.matchBand ?? "HIGH",
      opts.confidenceScore ?? 0.94,
    ]
  );

  return evidence.rows[0].id;
}
