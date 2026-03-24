#!/usr/bin/env ts-node
/**
 * @file scripts/demo-start.ts
 * @description One-command demo startup: `npm run demo:start`
 *
 * Sequence (each step blocks until success or exits with a fix message):
 *   1. Validate .env exists and required vars are present
 *   2. Verify DATABASE_URL credentials match docker-compose defaults
 *   3. Start Docker Compose services
 *   4. Wait for Postgres health (up to 60s)
 *   5. Run migrations (idempotent)
 *   6. Run seed (idempotent — skips if demo data already present)
 *   7. Start API + Worker + Sidebar via concurrently and print demo details
 *
 * NOTE: No Redis — the outbox worker uses DB polling, not Redis queues.
 * The "wait for Redis" step from the requirements spec does not apply here.
 * If Redis is added in a future phase, add it to docker-compose.yml and
 * this script simultaneously.
 */

import { execSync, spawn } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { validateEnv, parseDatabaseUrl } from "./lib/env-validator";

const ROOT = path.resolve(__dirname, "..");
const COMPOSE_FILE = path.join(ROOT, "infra", "docker-compose.yml");
const ENV_FILE = path.join(ROOT, ".env");

// ─── ANSI colours ────────────────────────────────────────────────────────────
const c = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
  dim: "\x1b[2m",
};

function ok(msg: string) { console.log(`${c.green}✓${c.reset} ${msg}`); }
function info(msg: string) { console.log(`${c.cyan}→${c.reset} ${msg}`); }
function warn(msg: string) { console.log(`${c.yellow}⚠${c.reset}  ${msg}`); }
function fail(msg: string, fix?: string): never {
  console.error(`\n${c.red}✗ ${msg}${c.reset}`);
  if (fix) console.error(`\n${c.yellow}Fix:${c.reset}\n  ${fix}\n`);
  process.exit(1);
}
function header(msg: string) {
  console.log(`\n${c.bold}${c.cyan}${msg}${c.reset}`);
}

// ─── Step 1: Ensure .env exists ───────────────────────────────────────────────

function ensureEnvFile() {
  header("Step 1/7 — Checking .env");

  if (!fs.existsSync(ENV_FILE)) {
    fail(
      ".env not found",
      "Create .env in the repo root with required keys, then run: npm run doctor"
    );
  }
  ok(".env found");

  // Load into process.env
  const raw = fs.readFileSync(ENV_FILE, "utf-8");
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const val = trimmed.slice(eqIdx + 1).trim();
    // Force local .env to win for one-command reliability.
    process.env[key] = val;
  }

  // Backward compatibility for modules that still read PORT.
  if (!process.env.PORT && process.env.API_PORT) {
    process.env.PORT = process.env.API_PORT;
  }

  if (!process.env.SIDEBAR_PORT || process.env.SIDEBAR_PORT.trim() === "") {
    process.env.SIDEBAR_PORT = "5173";
  }

  resolvePostgresPortConflicts();
  resolveSidebarPortConflicts();
}

// ─── Step 2: Validate env and credential consistency ─────────────────────────

function validateEnvironment() {
  header("Step 2/7 — Validating environment");

  const errors = validateEnv(process.env);
  if (errors.length > 0) {
    console.error(`${c.red}✗ .env validation failed:${c.reset}`);
    for (const e of errors) console.error(`  • ${e}`);
    fail(
      "Fix the above .env issues and retry",
      "Edit .env and rerun: npm run doctor"
    );
  }
  ok("All required env vars present");

  // Verify DATABASE_URL credentials match POSTGRES_* vars (most common mismatch)
  const dbUrl = parseDatabaseUrl(process.env.DATABASE_URL!);
  const pgUser = process.env.POSTGRES_USER ?? "iisl";
  const pgPass = process.env.POSTGRES_PASSWORD ?? "iisl_dev";
  const pgDb   = process.env.POSTGRES_DB ?? "iisl";
  const pgPort = parseInt(process.env.POSTGRES_PORT ?? "5432", 10);

  const mismatches: string[] = [];
  if (dbUrl.user !== pgUser)     mismatches.push(`user: DATABASE_URL has '${dbUrl.user}', POSTGRES_USER is '${pgUser}'`);
  if (dbUrl.password !== pgPass) mismatches.push(`password: DATABASE_URL password does not match POSTGRES_PASSWORD`);
  if (dbUrl.database !== pgDb)   mismatches.push(`database: DATABASE_URL has '${dbUrl.database}', POSTGRES_DB is '${pgDb}'`);
  if (dbUrl.port !== pgPort)     mismatches.push(`port: DATABASE_URL has '${dbUrl.port}', POSTGRES_PORT is '${pgPort}'`);

  if (mismatches.length > 0) {
    console.error(`${c.red}✗ Credential mismatch between DATABASE_URL and POSTGRES_* vars:${c.reset}`);
    for (const m of mismatches) console.error(`  • ${m}`);
    fail(
      "DATABASE_URL credentials must match POSTGRES_USER / POSTGRES_PASSWORD / POSTGRES_DB",
      "Edit .env so all four values are consistent, then rerun: npm run doctor"
    );
  }
  ok("DATABASE_URL credentials consistent with POSTGRES_* vars");
}

// ─── Step 3: Start Docker services ───────────────────────────────────────────

function startDockerServices() {
  header("Step 3/7 — Starting Docker services");

  // Check Docker daemon is running
  try {
    execSync("docker info --format '{{.ServerVersion}}'", { stdio: "pipe" });
  } catch {
    fail(
      "Docker is not running",
      "Start Docker Desktop, then retry: npm run demo:start"
    );
  }

  removeLegacyNamedContainers();

  try {
    execSync(`docker compose -f "${COMPOSE_FILE}" up -d --remove-orphans`, {
      stdio: "inherit",
      cwd: ROOT,
    });
    ok("Docker services started");
  } catch (err) {
    fail(
      "docker compose up failed",
      `Check docker-compose logs: docker compose -f infra/docker-compose.yml logs`
    );
  }
}

function removeLegacyNamedContainers() {
  // Old versions used fixed container names. Clean them up so one-command
  // startup works even after upgrading to the current compose config.
  const legacyNames = ["iisl_postgres", "iisl_redis"];

  for (const name of legacyNames) {
    try {
      const id = execSync(
        `docker ps -aq --filter name=^/${name}$`,
        { stdio: "pipe", cwd: ROOT }
      ).toString().trim();

      if (!id) continue;

      warn(`Found legacy container '${name}' from older local setup — removing it`);
      execSync(`docker rm -f ${name}`, { stdio: "inherit", cwd: ROOT });
      ok(`Removed legacy container '${name}'`);
    } catch {
      fail(
        `Unable to clean up legacy container '${name}'`,
        `Run manually:\n  docker rm -f ${name}`
      );
    }
  }
}

function resolvePostgresPortConflicts() {
  const rawDbUrl = process.env.DATABASE_URL;
  if (!rawDbUrl) return;

  let url: URL;
  try {
    url = new URL(rawDbUrl);
  } catch {
    return;
  }

  // Conflict handling only applies to local-hosted Postgres URLs.
  if (url.hostname !== "localhost" && url.hostname !== "127.0.0.1") return;

  const currentPort = url.port ? parseInt(url.port, 10) : 5432;
  if (Number.isNaN(currentPort)) return;

  const currentListeners = getPortListeners(currentPort);
  if (!hasNonDockerListener(currentListeners)) return;

  const candidates = [5433, 5434, 55432];
  let selectedPort: number | null = null;

  for (const port of candidates) {
    const listeners = getPortListeners(port);
    if (!hasNonDockerListener(listeners)) {
      selectedPort = port;
      break;
    }
  }

  if (!selectedPort) {
    fail(
      `Postgres port ${currentPort} is occupied by another local service`,
      [
        "Stop your local Postgres service, or free one of these ports: 5433, 5434, 55432",
        "Then retry: npm run demo:start",
      ].join("\n  ")
    );
  }

  warn(
    `Detected non-Docker service on port ${currentPort}; switching IISL local Postgres to ${selectedPort}`
  );

  url.hostname = "127.0.0.1";
  url.port = String(selectedPort);
  process.env.DATABASE_URL = url.toString();
  process.env.POSTGRES_PORT = String(selectedPort);

  upsertEnvValue("DATABASE_URL", process.env.DATABASE_URL);
  upsertEnvValue("POSTGRES_PORT", String(selectedPort));

  ok(`Updated .env with DATABASE_URL port ${selectedPort} and POSTGRES_PORT=${selectedPort}`);
}

function resolveSidebarPortConflicts() {
  const raw = process.env.SIDEBAR_PORT ?? "5173";
  const configuredPort = Number.parseInt(raw, 10);
  const currentPort = Number.isNaN(configuredPort) ? 5173 : configuredPort;
  process.env.SIDEBAR_PORT = String(currentPort);

  if (!hasAnyListener(getPortListeners(currentPort))) return;

  const candidates = [5174, 5175, 5273];
  let selectedPort: number | null = null;

  for (const candidate of candidates) {
    if (!hasAnyListener(getPortListeners(candidate))) {
      selectedPort = candidate;
      break;
    }
  }

  if (!selectedPort) {
    fail(
      `Sidebar port ${currentPort} is already in use`,
      [
        `Free port ${currentPort} or set SIDEBAR_PORT in .env`,
        "Then retry: npm run demo:start",
      ].join("\n  ")
    );
  }

  warn(`Sidebar port ${currentPort} is busy; switching to ${selectedPort}`);
  process.env.SIDEBAR_PORT = String(selectedPort);
  upsertEnvValue("SIDEBAR_PORT", String(selectedPort));
  ok(`Updated .env with SIDEBAR_PORT=${selectedPort}`);
}

function getPortListeners(port: number): string {
  try {
    return execSync(`lsof -nP -iTCP:${port} -sTCP:LISTEN`, {
      stdio: "pipe",
      cwd: ROOT,
    }).toString();
  } catch {
    return "";
  }
}

function hasNonDockerListener(lsofOutput: string): boolean {
  if (!lsofOutput.trim()) return false;
  const lines = lsofOutput
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  if (lines.length <= 1) return false; // header only

  for (const line of lines.slice(1)) {
    const low = line.toLowerCase();
    if (!low.includes("docker") && !low.includes("com.docke")) {
      return true;
    }
  }
  return false;
}

function hasAnyListener(lsofOutput: string): boolean {
  if (!lsofOutput.trim()) return false;
  const lines = lsofOutput
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  return lines.length > 1;
}

function upsertEnvValue(key: string, value: string) {
  if (!fs.existsSync(ENV_FILE)) return;
  const lines = fs.readFileSync(ENV_FILE, "utf-8").split("\n");
  let replaced = false;

  const updated = lines.map((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) return line;
    const eq = trimmed.indexOf("=");
    if (eq === -1) return line;
    const k = trimmed.slice(0, eq).trim();
    if (k !== key) return line;
    replaced = true;
    return `${key}=${value}`;
  });

  if (!replaced) updated.push(`${key}=${value}`);
  fs.writeFileSync(ENV_FILE, updated.join("\n"));
}

// ─── Step 4: Wait for Postgres health ────────────────────────────────────────

async function waitForPostgres() {
  header("Step 4/7 — Waiting for Postgres");
  await waitForPostgresReady();
}

async function waitForPostgresReady() {

  const maxWaitMs = 60_000;
  const pollMs = 2_000;
  const deadline = Date.now() + maxWaitMs;
  const pgUser = process.env.POSTGRES_USER ?? "iisl";
  const pgDb = process.env.POSTGRES_DB ?? "iisl";

  process.stdout.write("  Waiting");

  while (Date.now() < deadline) {
    try {
      const result = execSync(
        `docker compose -f "${COMPOSE_FILE}" exec -T postgres pg_isready -U ${pgUser} -d ${pgDb}`,
        { stdio: "pipe", cwd: ROOT }
      );
      console.log(" ready");
      ok(`Postgres is healthy`);
      return;
    } catch {
      process.stdout.write(".");
      await sleep(pollMs);
    }
  }

  console.log("");
  fail(
    "Postgres did not become healthy within 60s",
    [
      "Check container logs: docker compose -f infra/docker-compose.yml logs postgres",
      "Check port conflict:  lsof -i :5432",
      "Hard reset:           npm run demo:reset",
    ].join("\n  ")
  );
}

// ─── Step 5: Run migrations (idempotent) ─────────────────────────────────────

async function runMigrations() {
  header("Step 5/7 — Running migrations");

  const firstAttempt = runCommandCapture(`npx ts-node -P tsconfig.base.json scripts/migrate.ts`);
  if (firstAttempt.ok) {
    if (firstAttempt.output) process.stdout.write(firstAttempt.output);
    ok("Migrations complete");
    return;
  }

  if (firstAttempt.output) process.stderr.write(firstAttempt.output);

  if (isRecoverableBootstrapError(firstAttempt.output)) {
    warn("Detected local Postgres bootstrap mismatch (role/password/database).");
    warn("Auto-recovering once by recreating the local Postgres volume...");

    recreateLocalPostgresVolume();
    info("Waiting for Postgres after automatic recovery...");
    await waitForPostgresReady();

    const secondAttempt = runCommandCapture(`npx ts-node -P tsconfig.base.json scripts/migrate.ts`);
    if (secondAttempt.ok) {
      if (secondAttempt.output) process.stdout.write(secondAttempt.output);
      ok("Migrations complete (after automatic local DB recovery)");
      return;
    }

    if (secondAttempt.output) process.stderr.write(secondAttempt.output);
  }

  fail(
    "Migration failed",
    [
      "Check DATABASE_URL in .env",
      "Check Postgres is running: docker compose -f infra/docker-compose.yml ps",
      "Hard reset: npm run demo:reset",
    ].join("\n  ")
  );
}

function runCommandCapture(command: string): { ok: true; output: string } | { ok: false; output: string } {
  try {
    const out = execSync(command, {
      stdio: "pipe",
      cwd: ROOT,
      env: process.env,
    }).toString();
    return { ok: true, output: out };
  } catch (error) {
    const err = error as Error & { stdout?: Buffer | string; stderr?: Buffer | string };
    const stdout = err.stdout ? err.stdout.toString() : "";
    const stderr = err.stderr ? err.stderr.toString() : "";
    const message = err.message ? `${err.message}\n` : "";
    return { ok: false, output: `${stdout}${stderr}${message}` };
  }
}

function isRecoverableBootstrapError(output: string): boolean {
  const text = output.toLowerCase();
  return (
    (text.includes("role") && text.includes("does not exist")) ||
    text.includes("password authentication failed") ||
    (text.includes("database") && text.includes("does not exist")) ||
    text.includes("code: '28000'") ||
    text.includes("code: \"28000\"")
  );
}

function recreateLocalPostgresVolume() {
  info("Recreating local Docker Postgres volume (local demo data only)...");
  try {
    execSync(`docker compose -f "${COMPOSE_FILE}" down --volumes --remove-orphans`, {
      stdio: "inherit",
      cwd: ROOT,
    });
    execSync(`docker compose -f "${COMPOSE_FILE}" up -d`, {
      stdio: "inherit",
      cwd: ROOT,
    });
    ok("Local Postgres volume recreated");
  } catch {
    fail(
      "Automatic Postgres recovery failed",
      "Run manually: npm run demo:reset"
    );
  }
}

// ─── Step 6: Run seed (idempotent) ───────────────────────────────────────────

function runSeed() {
  header("Step 6/7 — Seeding demo data");
  try {
    execSync(`npx ts-node -P tsconfig.base.json scripts/seed.ts`, {
      stdio: "inherit",
      cwd: ROOT,
      env: process.env,
    });
    ok("Seed complete");
  } catch {
    fail(
      "Seed failed",
      "Run manually to see full error: npx ts-node scripts/seed.ts"
    );
  }
}

// ─── Step 7: Start services and print URLs ────────────────────────────────────

function startServices() {
  header("Step 7/7 — Starting API / Worker / Sidebar");

  printDemoInfo();

  // Use concurrently to start all three services
  const child = spawn("npm", ["run", "dev"], {
    stdio: "inherit",
    cwd: ROOT,
    env: process.env,
  });

  child.on("exit", (code, signal) => {
    // When demo:start is stopped via SIGINT/SIGTERM, code is null and signal
    // is set; that's an expected shutdown path, not an error.
    if (signal) return;
    if (code !== 0 && code !== null) {
      console.error(`\n${c.red}Services exited with code ${code}${c.reset}`);
      console.error("Run 'npm run doctor' to diagnose.");
    }
  });

  // Forward signals to child
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.on(sig, () => {
      child.kill(sig);
      process.exit(0);
    });
  }
}

function printDemoInfo() {
  const apiPort     = process.env.API_PORT ?? "3001";
  const sidebarPort = process.env.SIDEBAR_PORT ?? "5173";
  const opToken     = process.env.OPERATOR_TOKEN ?? "operator-token-dev";

  console.log(`
${c.bold}${c.green}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${c.reset}
${c.bold}  IISL Phase 1 — Demo Ready${c.reset}
${c.bold}${c.green}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${c.reset}

  ${c.bold}Resolution Card (Sidebar UI)${c.reset}
  ${c.cyan}http://localhost:${sidebarPort}${c.reset}

  ${c.bold}API${c.reset}
  ${c.cyan}http://localhost:${apiPort}${c.reset}
  ${c.cyan}http://localhost:${apiPort}/health${c.reset}

  ${c.bold}Operator token${c.reset}  ${c.dim}(Authorization: Bearer <token>)${c.reset}
  ${c.yellow}${opToken}${c.reset}

  ${c.bold}Demo tenant ID${c.reset}
  ${c.dim}00000000-0000-0000-0000-000000000001${c.reset}

  ${c.bold}Demo tickets${c.reset}
  ${c.dim}10001 — Happy path (Scenario 1)${c.reset}
  ${c.dim}10002 — Degraded / source unavailable (Scenario 2)${c.reset}
  ${c.dim}10003 — Retry + unknown outcome (Scenario 3)${c.reset}

  ${c.bold}Commands${c.reset}
  Smoke test:   ${c.cyan}npm run demo:smoke${c.reset}
  Reset all:    ${c.cyan}npm run demo:reset${c.reset}
  Doctor:       ${c.cyan}npm run doctor${c.reset}
  Full guide:   ${c.cyan}docs/DEMO.md${c.reset}

${c.bold}${c.green}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${c.reset}
`);
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function sleep(ms: number) { return new Promise((r) => setTimeout(r, ms)); }

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\n${c.bold}IISL Demo Startup${c.reset} — ${new Date().toLocaleTimeString()}\n`);
  ensureEnvFile();
  validateEnvironment();
  startDockerServices();
  await waitForPostgres();
  await runMigrations();
  runSeed();
  startServices();
}

main().catch((err) => {
  console.error(`\n${c.red}Unexpected error:${c.reset}`, err);
  process.exit(1);
});
