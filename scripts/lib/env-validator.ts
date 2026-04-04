/**
 * @file scripts/lib/env-validator.ts
 * @description Shared env validation and parsing used by demo scripts.
 *
 * All validation is fail-fast with human-readable error messages.
 * No external dependencies — stdlib only.
 */

// ─── Required variables ───────────────────────────────────────────────────────
// Format: [key, description, example]

export interface EnvVarSpec {
  key: string;
  description: string;
  example: string;
  required: boolean;
}

export const ENV_SPECS: EnvVarSpec[] = [
  // Database — required
  { key: "DATABASE_URL",    description: "Full Postgres connection string", example: "postgresql://iisl:<postgres_password>@127.0.0.1:5432/iisl", required: true },
  { key: "POSTGRES_USER",   description: "Postgres username (must match DATABASE_URL)", example: "iisl", required: true },
  { key: "POSTGRES_PASSWORD", description: "Postgres password (must match DATABASE_URL)", example: "<postgres_password>", required: true },
  { key: "POSTGRES_DB",     description: "Postgres database name (must match DATABASE_URL)", example: "iisl", required: true },
  // API
  { key: "API_PORT",        description: "API server port", example: "3001", required: true },
  { key: "API_HOST",        description: "API server bind host", example: "127.0.0.1", required: false },
  // Auth
  { key: "OPERATOR_TOKEN",  description: "Bearer token for operator endpoints", example: "<operator_token>", required: true },
  { key: "AGENT_TOKEN",     description: "Bearer token for agent endpoints", example: "<agent_token>", required: true },
  // Worker
  { key: "WORKER_POLL_INTERVAL_MS", description: "Outbox poll interval in ms", example: "2000", required: true },
  { key: "WORKER_MAX_ATTEMPTS",     description: "Max outbox retry attempts", example: "5", required: true },
  // Simulator flags — required (controls which adapters to use)
  { key: "USE_ZENDESK_SIMULATOR", description: "Use Zendesk fixture simulator", example: "true", required: true },
  { key: "USE_STRIPE_SIMULATOR",  description: "Use Stripe fixture simulator",  example: "true", required: true },
  { key: "USE_SHOPIFY_SIMULATOR", description: "Use Shopify fixture simulator",  example: "true", required: true },
  // Frontend
  { key: "VITE_API_BASE_URL", description: "API base URL seen by sidebar", example: "http://localhost:3001", required: true },
  { key: "SIDEBAR_PORT", description: "Sidebar dev server port", example: "5173", required: false },
  // Optional — validated only if present
  { key: "LOG_LEVEL",       description: "Log verbosity (info|debug|warn|error)", example: "info", required: false },
];

const REQUIRED_KEYS = ENV_SPECS.filter((s) => s.required).map((s) => s.key);

/**
 * Validate an env object. Returns a list of human-readable error strings.
 * Empty array = all good.
 */
export function validateEnv(env: Record<string, string | undefined>): string[] {
  const errors: string[] = [];

  for (const key of REQUIRED_KEYS) {
    const val = env[key];
    if (!val || val.trim() === "") {
      const spec = ENV_SPECS.find((s) => s.key === key)!;
      errors.push(`${key} is missing or empty — ${spec.description} (e.g. ${spec.example})`);
    }
  }

  // Validate DATABASE_URL is parseable
  if (env.DATABASE_URL && env.DATABASE_URL.trim() !== "") {
    try {
      parseDatabaseUrl(env.DATABASE_URL);
    } catch (e) {
      errors.push(`DATABASE_URL is not a valid Postgres URL: ${e instanceof Error ? e.message : e}`);
    }
  }

  // Validate API_PORT is numeric
  if (env.API_PORT && !/^\d+$/.test(env.API_PORT.trim())) {
    errors.push(`API_PORT must be a number, got: '${env.API_PORT}'`);
  }

  // Validate WORKER_POLL_INTERVAL_MS is numeric
  if (env.WORKER_POLL_INTERVAL_MS && !/^\d+$/.test(env.WORKER_POLL_INTERVAL_MS.trim())) {
    errors.push(`WORKER_POLL_INTERVAL_MS must be a number, got: '${env.WORKER_POLL_INTERVAL_MS}'`);
  }

  return errors;
}

// ─── URL parser ───────────────────────────────────────────────────────────────

export interface ParsedDbUrl {
  user: string;
  password: string;
  host: string;
  port: number;
  database: string;
}

/**
 * Parse a postgresql:// URL.
 * Throws a descriptive error if the URL is malformed.
 */
export function parseDatabaseUrl(raw: string): ParsedDbUrl {
  if (!raw) throw new Error("DATABASE_URL is empty");

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(
      `Cannot parse as URL. Expected format: postgresql://user:password@host:port/database\nGot: ${raw}`
    );
  }

  if (url.protocol !== "postgresql:" && url.protocol !== "postgres:") {
    throw new Error(`Expected postgresql:// or postgres:// scheme, got: ${url.protocol}`);
  }

  const user = decodeURIComponent(url.username);
  const password = decodeURIComponent(url.password);
  const host = url.hostname;
  const port = url.port ? parseInt(url.port, 10) : 5432;
  const database = url.pathname.replace(/^\//, "");

  if (!user)     throw new Error("DATABASE_URL is missing a username");
  if (!database) throw new Error("DATABASE_URL is missing a database name (path component)");

  return { user, password, host, port, database };
}
