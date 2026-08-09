/**
 * In-process Postgres for tests.
 *
 * Runs the real migration files against PGlite (Postgres compiled to WASM), so
 * tests exercise actual SQL — column names, constraints, triggers — rather than
 * mocks. This is what catches schema/code drift.
 *
 * Limitation: PGlite is a single connection, so these tests cannot exercise
 * genuine multi-connection contention (FOR UPDATE SKIP LOCKED across workers).
 * Concurrency behaviour is covered by replaying a claim sequentially, which
 * catches dedupe bugs but not lock-ordering bugs. Multi-worker contention needs
 * a real Postgres — see TESTS.md.
 */
import { PGlite } from "@electric-sql/pglite";
import * as fs from "fs";
import * as path from "path";
import { setDriver, DbDriver } from "../../src/db/pool";

const MIGRATIONS_DIR = path.join(__dirname, "../../../../db/migrations");
const SEED_FILE = path.join(__dirname, "../../../../db/seed.sql");

export interface TestDb {
  driver: DbDriver;
  raw: PGlite;
  /** Load db/seed.sql. Off by default so tests start from an empty schema. */
  seed(): Promise<void>;
  close(): Promise<void>;
}

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

/**
 * Start a fresh database with all migrations applied, and point the app's query
 * helpers at it. Call close() in afterEach to restore the previous driver.
 */
export async function createTestDb(): Promise<TestDb> {
  const db = new PGlite();

  const files = fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  for (const file of files) {
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), "utf-8");
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
    raw: db,
    async seed() {
      await db.exec(fs.readFileSync(SEED_FILE, "utf-8"));
    },
    async close() {
      setDriver(previous);
      await db.close();
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
