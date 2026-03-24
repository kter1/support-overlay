#!/usr/bin/env ts-node
/**
 * @file scripts/demo-reset.ts
 * @description `npm run demo:reset` — full local demo reset.
 *
 * Sequence:
 *   1. Print safety warning with 5-second countdown (CTRL+C to abort)
 *   2. Stop running services (docker compose down --volumes)
 *   3. Remove local Docker volumes (Postgres data)
 *   4. Bring Postgres back up
 *   5. Wait for Postgres health
 *   6. Run migrations (fresh)
 *   7. Run seed
 *   8. Print ready message
 *
 * SAFE FOR LOCAL DEMO ONLY. This destroys all local data.
 * It does not touch any external database or production system.
 */

import { execSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { loadEnvFile, validateEnv } from "./lib/env-validator";

const ROOT = path.resolve(__dirname, "..");
const COMPOSE_FILE = path.join(ROOT, "infra", "docker-compose.yml");
const ENV_FILE = path.join(ROOT, ".env");

const c = {
  reset:  "\x1b[0m",
  bold:   "\x1b[1m",
  red:    "\x1b[31m",
  green:  "\x1b[32m",
  yellow: "\x1b[33m",
  cyan:   "\x1b[36m",
  dim:    "\x1b[2m",
};

function ok(msg: string)   { console.log(`${c.green}✓${c.reset} ${msg}`); }
function info(msg: string) { console.log(`${c.cyan}→${c.reset} ${msg}`); }

function sleep(ms: number) { return new Promise((r) => setTimeout(r, ms)); }

async function countdown(seconds: number) {
  for (let i = seconds; i > 0; i--) {
    process.stdout.write(`\r  ${c.yellow}Resetting in ${i}s... (CTRL+C to abort)${c.reset}  `);
    await sleep(1000);
  }
  console.log(`\r  ${c.red}Proceeding with reset...${c.reset}                 `);
}

async function main() {
  console.log(`\n${c.bold}${c.red}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${c.reset}`);
  console.log(`${c.bold}${c.red}  IISL DEMO RESET — LOCAL ONLY${c.reset}`);
  console.log(`${c.bold}${c.red}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${c.reset}`);
  console.log(`
  This will:
    ${c.yellow}•${c.reset} Stop all running Docker services
    ${c.yellow}•${c.reset} Delete all Postgres data (local Docker volume)
    ${c.yellow}•${c.reset} Recreate the database from scratch
    ${c.yellow}•${c.reset} Reseed with demo data

  ${c.dim}This only affects your local Docker environment.
  It does NOT touch any external database or production system.${c.reset}
`);

  await countdown(5);

  // ── Step 1: Load env ─────────────────────────────────────────────────────
  loadEnvFile(ENV_FILE);
  resolvePostgresPortConflicts();
  const errors = validateEnv(process.env as Record<string, string | undefined>);
  if (errors.length > 0) {
    console.error(`${c.red}✗ .env issues (run npm run doctor for details):${c.reset}`);
    for (const e of errors) console.error(`  • ${e}`);
    console.error(`\nFix .env first: create/update .env in repo root, then run npm run doctor`);
    process.exit(1);
  }

  // ── Step 2: Stop all services and remove volumes ─────────────────────────
  info("Stopping Docker services and removing volumes...");
  try {
    execSync(`docker compose -f "${COMPOSE_FILE}" down --volumes --remove-orphans`, {
      stdio: "inherit",
      cwd: ROOT,
    });
    ok("Services stopped, volumes removed");
  } catch {
    // Non-fatal — containers may already be stopped
    ok("Services stopped (or were already down)");
  }

  // ── Step 3: Start Postgres ───────────────────────────────────────────────
  info("Starting Postgres...");
  execSync(`docker compose -f "${COMPOSE_FILE}" up -d`, {
    stdio: "inherit",
    cwd: ROOT,
  });
  ok("Postgres started");

  // ── Step 4: Wait for health ──────────────────────────────────────────────
  info("Waiting for Postgres to be ready...");
  const pgUser = process.env.POSTGRES_USER ?? "iisl";
  const pgDb = process.env.POSTGRES_DB ?? "iisl";
  const deadline = Date.now() + 60_000;
  let ready = false;

  process.stdout.write("  Waiting");
  while (Date.now() < deadline) {
    try {
      execSync(
        `docker compose -f "${COMPOSE_FILE}" exec -T postgres pg_isready -U ${pgUser} -d ${pgDb}`,
        { stdio: "pipe", cwd: ROOT }
      );
      ready = true;
      break;
    } catch {
      process.stdout.write(".");
      await sleep(2000);
    }
  }

  if (!ready) {
    console.log("");
    console.error(`\n${c.red}✗ Postgres did not become ready within 60s${c.reset}`);
    console.error(`  Check logs: docker compose -f infra/docker-compose.yml logs postgres`);
    process.exit(1);
  }
  console.log(" ready");
  ok("Postgres is healthy");

  // ── Step 5: Run migrations ───────────────────────────────────────────────
  info("Running migrations...");
  try {
    execSync(`npx ts-node -P tsconfig.base.json scripts/migrate.ts`, {
      stdio: "inherit",
      cwd: ROOT,
      env: process.env,
    });
    ok("Migrations complete");
  } catch {
    console.error(`\n${c.red}✗ Migration failed${c.reset}`);
    console.error("  Check DATABASE_URL in .env and Postgres logs");
    process.exit(1);
  }

  // ── Step 6: Run seed ─────────────────────────────────────────────────────
  info("Seeding demo data...");
  try {
    execSync(`npx ts-node -P tsconfig.base.json scripts/seed.ts`, {
      stdio: "inherit",
      cwd: ROOT,
      env: process.env,
    });
    ok("Seed complete");
  } catch {
    console.error(`\n${c.red}✗ Seed failed${c.reset}`);
    console.error("  Run manually: npx ts-node scripts/seed.ts");
    process.exit(1);
  }

  // ── Done ──────────────────────────────────────────────────────────────────
  console.log(`
${c.bold}${c.green}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${c.reset}
${c.bold}  Reset complete. Ready to start:${c.reset}
${c.bold}${c.green}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${c.reset}

  ${c.cyan}npm run demo:start${c.reset}
`);
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

  if (!selectedPort) return;

  info(
    `Detected non-Docker service on port ${currentPort}; switching IISL local Postgres to ${selectedPort}`
  );

  url.hostname = "127.0.0.1";
  url.port = String(selectedPort);
  process.env.DATABASE_URL = url.toString();
  process.env.POSTGRES_PORT = String(selectedPort);

  upsertEnvValue("DATABASE_URL", process.env.DATABASE_URL);
  upsertEnvValue("POSTGRES_PORT", String(selectedPort));
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

  if (lines.length <= 1) return false;

  for (const line of lines.slice(1)) {
    const low = line.toLowerCase();
    if (!low.includes("docker") && !low.includes("com.docke")) {
      return true;
    }
  }
  return false;
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

main().catch((err) => {
  console.error(`\n${c.red}Unexpected error:${c.reset}`, err);
  process.exit(1);
});
