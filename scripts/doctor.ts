#!/usr/bin/env ts-node
/**
 * @file scripts/doctor.ts
 * @description `npm run doctor` — pre-flight diagnostic for local demo.
 *
 * Checks:
 *   1. Node version >= 18
 *   2. npm version >= 9
 *   3. Docker available and daemon running
 *   4. docker compose available
 *   5. Required env vars present
 *   6. DATABASE_URL parseable
 *   7. DATABASE_URL credentials match POSTGRES_* vars
 *   8. Docker containers running and healthy
 *   9. Postgres port (5432) not conflicted by an external process
 *  10. API port (3001) free or listening to iisl
 *  11. Sidebar port (5173) free or listening to iisl
 *
 * Each failure prints an exact fix command — no guessing required.
 * Exits 0 only if all checks pass.
 */

import { execSync } from "child_process";
import * as path from "path";
import { validateEnv, parseDatabaseUrl } from "./lib/env-validator";

const ROOT = path.resolve(__dirname, "..");
const COMPOSE_FILE = path.join(ROOT, "infra", "docker-compose.yml");

// ─── Result tracking ──────────────────────────────────────────────────────────

interface CheckResult {
  name: string;
  passed: boolean;
  message: string;
  fix?: string;
}

const results: CheckResult[] = [];

function pass(name: string, message: string) {
  results.push({ name, passed: true, message });
}

function fail(name: string, message: string, fix: string) {
  results.push({ name, passed: false, message, fix });
}

// ─── ANSI ────────────────────────────────────────────────────────────────────

const c = {
  reset:  "\x1b[0m",
  bold:   "\x1b[1m",
  red:    "\x1b[31m",
  green:  "\x1b[32m",
  yellow: "\x1b[33m",
  cyan:   "\x1b[36m",
  dim:    "\x1b[2m",
};

// ─── Check 1: Node version ────────────────────────────────────────────────────

function checkNode() {
  const raw = process.version; // "v20.11.0"
  const match = raw.match(/^v(\d+)/);
  const major = match ? parseInt(match[1], 10) : 0;

  if (major >= 18) {
    pass("Node.js version", `${raw} ✓ (requires >=18)`);
  } else {
    fail(
      "Node.js version",
      `${raw} — requires >=18`,
      `Install Node.js 22 via nvm:\n    nvm install 22 && nvm use 22\n  Or download: https://nodejs.org`
    );
  }
}

// ─── Check 2: npm version ─────────────────────────────────────────────────────

function checkNpm() {
  try {
    const raw = execSync("npm --version", { stdio: "pipe" }).toString().trim();
    const major = parseInt(raw.split(".")[0], 10);
    if (major >= 9) {
      pass("npm version", `${raw} ✓ (requires >=9)`);
    } else {
      fail(
        "npm version",
        `${raw} — requires >=9`,
        `npm install -g npm@latest`
      );
    }
  } catch {
    fail("npm version", "npm not found", "Install Node.js (npm is bundled): https://nodejs.org");
  }
}

// ─── Check 3: Docker CLI ──────────────────────────────────────────────────────

function checkDockerCli() {
  try {
    const ver = execSync("docker --version", { stdio: "pipe" }).toString().trim();
    pass("Docker CLI", ver);
  } catch {
    fail(
      "Docker CLI",
      "docker command not found",
      "Install Docker Desktop: https://www.docker.com/products/docker-desktop"
    );
  }
}

// ─── Check 4: Docker daemon ───────────────────────────────────────────────────

function checkDockerDaemon() {
  try {
    execSync("docker info --format '{{.ServerVersion}}'", { stdio: "pipe" });
    pass("Docker daemon", "running");
  } catch {
    fail(
      "Docker daemon",
      "Docker daemon is not running",
      "Start Docker Desktop, then wait for the whale icon to stop animating"
    );
  }
}

// ─── Check 5: docker compose ──────────────────────────────────────────────────

function checkDockerCompose() {
  try {
    const ver = execSync("docker compose version", { stdio: "pipe" }).toString().trim();
    pass("docker compose", ver);
  } catch {
    fail(
      "docker compose",
      "docker compose subcommand not available",
      "Update Docker Desktop to a version that includes Compose V2 (>= 3.6)"
    );
  }
}

// ─── Check 5: Required env vars ───────────────────────────────────────────────

function checkEnvVars() {
  const errors = validateEnv(process.env as Record<string, string | undefined>);

  if (errors.length === 0) {
    pass("Required env vars", "all present");
  } else {
    fail(
      "Required env vars",
      `${errors.length} missing/invalid var(s):\n    ${errors.join("\n    ")}`,
      "Export required environment variables, then rerun: npm run doctor"
    );
  }
}

// ─── Check 6: DATABASE_URL credential consistency ─────────────────────────────

function checkCredentialConsistency() {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) return; // Already caught in check 7

  try {
    const parsed = parseDatabaseUrl(dbUrl);
    const pgUser = process.env.POSTGRES_USER ?? "iisl";
    const pgPass = process.env.POSTGRES_PASSWORD ?? "iisl_dev";
    const pgDb   = process.env.POSTGRES_DB ?? "iisl";
    const pgPort = parseInt(process.env.POSTGRES_PORT ?? "5432", 10);

    const mismatches: string[] = [];
    if (parsed.user !== pgUser) {
      mismatches.push(`username: DATABASE_URL='${parsed.user}' vs POSTGRES_USER='${pgUser}'`);
    }
    if (parsed.password !== pgPass) {
      mismatches.push(`password: DATABASE_URL password does not match POSTGRES_PASSWORD`);
    }
    if (parsed.database !== pgDb) {
      mismatches.push(`database: DATABASE_URL='${parsed.database}' vs POSTGRES_DB='${pgDb}'`);
    }
    if (parsed.port !== pgPort) {
      mismatches.push(`port: DATABASE_URL='${parsed.port}' vs POSTGRES_PORT='${pgPort}'`);
    }

    if (mismatches.length === 0) {
      pass("Credential consistency", "DATABASE_URL matches POSTGRES_* vars");
    } else {
      fail(
        "Credential consistency",
        `Mismatch between DATABASE_URL and POSTGRES_* vars:\n    ${mismatches.join("\n    ")}`,
        [
          "Set environment variables so all four values are consistent. Example:",
          "  DATABASE_URL=postgresql://iisl:iisl_dev@127.0.0.1:5432/iisl",
          "  POSTGRES_USER=iisl",
          "  POSTGRES_PASSWORD=iisl_dev",
          "  POSTGRES_DB=iisl",
          "  POSTGRES_PORT=5432",
          "",
          "If you changed a password, also reset the container:",
          "  npm run demo:reset",
        ].join("\n    ")
      );
    }
  } catch (e) {
    fail(
      "Credential consistency",
      `Cannot parse DATABASE_URL: ${e instanceof Error ? e.message : e}`,
      "Fix DATABASE_URL in your environment — format: postgresql://user:password@host:port/database"
    );
  }
}

// ─── Check 9: Container health ────────────────────────────────────────────────

function checkContainerHealth() {
  try {
    const output = execSync(
      `docker compose -f "${COMPOSE_FILE}" ps --format json`,
      { stdio: "pipe", cwd: ROOT }
    ).toString().trim();

    if (!output) {
      fail(
        "Docker containers",
        "No containers found",
        "npm run demo:start  (or: docker compose -f infra/docker-compose.yml up -d)"
      );
      return;
    }

    // Each line is a JSON object in newer Docker Compose versions
    const containers = output
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        try { return JSON.parse(line); } catch { return null; }
      })
      .filter(Boolean);

    if (containers.length === 0) {
      fail(
        "Docker containers",
        "No containers found",
        "npm run demo:start"
      );
      return;
    }

    const unhealthy = containers.filter(
      (c: Record<string, string>) => c.Health && c.Health !== "healthy" && c.Health !== ""
    );

    if (unhealthy.length === 0) {
      pass("Docker containers", `${containers.length} container(s) running`);
    } else {
      const names = unhealthy.map((c: Record<string, string>) => `${c.Name} (${c.Health})`).join(", ");
      fail(
        "Docker containers",
        `Unhealthy: ${names}`,
        [
          "View logs:  docker compose -f infra/docker-compose.yml logs",
          "Hard reset: npm run demo:reset",
        ].join("\n    ")
      );
    }
  } catch {
    fail(
      "Docker containers",
      "Could not query container status",
      "Ensure Docker is running and try: docker compose -f infra/docker-compose.yml ps"
    );
  }
}

// ─── Check 10: Postgres port ──────────────────────────────────────────────────

function checkPort(port: number, serviceName: string, envVarName?: string) {
  try {
    // Try lsof first (mac/linux), fall back to netstat
    let inUse = false;
    try {
      const out = execSync(`lsof -i :${port} -sTCP:LISTEN -n -P`, { stdio: "pipe" }).toString();
      inUse = out.trim().length > 0;
    } catch {
      // lsof returned non-zero (port free) or not available
      inUse = false;
    }

    if (!inUse) {
      // Port is free — could mean service not started yet
      pass(`Port ${port} (${serviceName})`, "available");
    } else {
      // Port in use — check if it's our container
      try {
        const out = execSync(`lsof -i :${port} -sTCP:LISTEN -n -P`, { stdio: "pipe" }).toString();
        const low = out.toLowerCase();
        const isDocker =
          low.includes("docker") ||
          low.includes("com.docker") ||
          low.includes("com.docke");
        if (isDocker) {
          pass(`Port ${port} (${serviceName})`, "in use by Docker (expected)");
        } else {
          fail(
            `Port ${port} (${serviceName})`,
            `Port ${port} is in use by a non-Docker process`,
            [
              `See what's using it: lsof -i :${port}`,
              `Kill it:             kill $(lsof -t -i :${port})`,
              `Or set ${envVarName ?? `${serviceName.toUpperCase()}_PORT`} in your shell environment and restart`,
            ].join("\n    ")
          );
        }
      } catch {
        pass(`Port ${port} (${serviceName})`, "in use (likely Docker)");
      }
    }
  } catch {
    pass(`Port ${port} (${serviceName})`, "check skipped (lsof unavailable)");
  }
}

// ─── Check: Postgres connectivity ────────────────────────────────────────────

function checkPostgresConnectivity() {
  const pgUser = process.env.POSTGRES_USER ?? "iisl";
  const pgDb = process.env.POSTGRES_DB ?? "iisl";
  try {
    execSync(
      `docker compose -f "${COMPOSE_FILE}" exec -T postgres pg_isready -U ${pgUser} -d ${pgDb}`,
      { stdio: "pipe", cwd: ROOT }
    );
    pass("Postgres connectivity", `pg_isready passed (user: ${pgUser}, db: ${pgDb})`);
  } catch {
    fail(
      "Postgres connectivity",
      "pg_isready failed — Postgres may not be running or accepting connections",
      [
        "Start infra:    docker compose -f infra/docker-compose.yml up -d",
        "View logs:      docker compose -f infra/docker-compose.yml logs postgres",
        "Hard reset:     npm run demo:reset",
      ].join("\n    ")
    );
  }
}

function parsePort(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw || raw.trim() === "") return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isNaN(parsed) ? fallback : parsed;
}

// ─── Print results ────────────────────────────────────────────────────────────

function printResults() {
  const passed = results.filter((r) => r.passed);
  const failed = results.filter((r) => !r.passed);

  console.log(`\n${c.bold}IISL Doctor — ${new Date().toLocaleTimeString()}${c.reset}\n`);
  console.log("─".repeat(56));

  for (const r of results) {
    const icon = r.passed ? `${c.green}✓${c.reset}` : `${c.red}✗${c.reset}`;
    const label = r.passed ? r.name : `${c.red}${r.name}${c.reset}`;
    console.log(`  ${icon} ${label}`);
    console.log(`    ${c.dim}${r.message}${c.reset}`);
  }

  console.log("─".repeat(56));
  console.log(`  ${c.green}${passed.length} passed${c.reset}  ${failed.length > 0 ? c.red : c.dim}${failed.length} failed${c.reset}`);

  if (failed.length > 0) {
    console.log(`\n${c.bold}${c.red}Failures — fix commands:${c.reset}\n`);
    for (const r of failed) {
      console.log(`  ${c.bold}${r.name}${c.reset}`);
      console.log(`  ${c.red}Problem:${c.reset} ${r.message}`);
      if (r.fix) {
        console.log(`  ${c.yellow}Fix:${c.reset}`);
        for (const line of r.fix.split("\n")) {
          console.log(`    ${line}`);
        }
      }
      console.log();
    }
    process.exit(1);
  } else {
    console.log(`\n${c.green}${c.bold}All checks passed. Ready to run: npm run demo:start${c.reset}\n`);
  }
}

// ─── Main ────────────────────────────────────────────────────────────────────

function main() {
  checkNode();
  checkNpm();
  checkDockerCli();
  checkDockerDaemon();
  checkDockerCompose();
  checkEnvVars();
  checkCredentialConsistency();
  checkContainerHealth();
  checkPostgresConnectivity();
  checkPort(parsePort("POSTGRES_PORT", 5432), "Postgres", "POSTGRES_PORT");
  checkPort(parsePort("API_PORT", parsePort("PORT", 3001)), "API", "API_PORT");
  checkPort(parsePort("SIDEBAR_PORT", 5173), "Sidebar", "SIDEBAR_PORT");
  printResults();
}

main();
