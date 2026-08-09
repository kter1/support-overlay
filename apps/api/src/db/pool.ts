/**
 * @support-overlay/api — Database access
 *
 * The pool is created lazily on first use rather than at import time, so that
 * modules which merely import a query helper can be unit-tested without a live
 * database. Tests call setDriver() to point the same helpers at an in-process
 * Postgres (see apps/api/test/helpers/db.ts).
 */
import { Pool, PoolClient, QueryResult, QueryResultRow } from "pg";

/**
 * The subset of node-postgres this codebase actually uses. Anything that can
 * satisfy this can back the query helpers.
 */
export interface DbClient {
  query<T extends QueryResultRow = QueryResultRow>(
    sql: string,
    params?: unknown[]
  ): Promise<QueryResult<T>>;
}

export interface DbDriver extends DbClient {
  /** Check out a dedicated connection for a transaction. */
  connect(): Promise<PoolClient>;
  end(): Promise<void>;
}

let driver: DbDriver | null = null;

function normalizeDatabaseUrl(raw: string): string {
  try {
    const parsed = new URL(raw);
    // On some hosts localhost resolves to ::1 and can reach a different local
    // Postgres than the one Docker published on IPv4.
    if (parsed.hostname === "localhost") {
      parsed.hostname = "127.0.0.1";
      return parsed.toString();
    }
  } catch {
    // If URL parsing fails, let pg report the original connection error.
  }
  return raw;
}

function createPool(): DbDriver {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error("DATABASE_URL environment variable is required");
  }

  const pool = new Pool({
    connectionString: normalizeDatabaseUrl(url),
    max: 20,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
  });

  pool.on("error", (err) => {
    console.error("Unexpected PG pool error", err);
  });

  return pool as unknown as DbDriver;
}

/** Replace the backing driver. Returns the previous one so tests can restore it. */
export function setDriver(next: DbDriver | null): DbDriver | null {
  const previous = driver;
  driver = next;
  return previous;
}

export function getDriver(): DbDriver {
  if (!driver) {
    driver = createPool();
  }
  return driver;
}

/** Execute a query with optional parameters. */
export async function query<T extends QueryResultRow = QueryResultRow>(
  sql: string,
  params?: unknown[]
): Promise<QueryResult<T>> {
  return getDriver().query<T>(sql, params);
}

/**
 * Execute a function within a transaction. Rolls back on error.
 *
 * Every mutation that must be atomic — approval status transition plus
 * action_executions creation, effect ledger plus outbox status — must run
 * through this, and must use the supplied client rather than the module-level
 * query(), or the write escapes the transaction.
 */
export async function withTransaction<T>(
  fn: (client: PoolClient) => Promise<T>
): Promise<T> {
  const client = await getDriver().connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Execute a query with a lock_version optimistic concurrency check.
 * Throws ConcurrencyConflictError if no rows were updated.
 */
export async function updateWithLockVersion(
  client: DbClient,
  table: string,
  id: string,
  currentLockVersion: number,
  updates: Record<string, unknown>
): Promise<void> {
  const setEntries = Object.entries(updates);
  const setClauses = setEntries
    .map(([key], i) => `${key} = $${i + 3}`)
    .join(", ");
  const values = setEntries.map(([, v]) => v);

  const result = await client.query(
    `UPDATE ${table}
     SET ${setClauses}, lock_version = lock_version + 1, updated_at = now()
     WHERE id = $1 AND lock_version = $2`,
    [id, currentLockVersion, ...values]
  );

  if (result.rowCount === 0) {
    throw new ConcurrencyConflictError(
      `Concurrency conflict on ${table} id=${id} ` +
      `expected lock_version=${currentLockVersion}`
    );
  }
}

export class ConcurrencyConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConcurrencyConflictError";
  }
}

export class NotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotFoundError";
  }
}
