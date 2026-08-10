#!/usr/bin/env node
/**
 * @file scripts/dev-bootstrap.js
 * @description Entry point for `npm run dev`.
 *
 * Loads `.env` and then starts the API, worker, and sidebar. The load has to
 * happen here rather than inside each service: the three run as separate
 * processes and would otherwise each need their own dotenv wiring, and the
 * sidebar is Vite, which looks for `.env` next to itself rather than at the
 * repository root.
 *
 * The failure this prevents is a quiet one. Without configuration the API
 * still binds its port and answers `/health` — which does not touch the
 * database — so the stack looks up while every real request fails.
 */

const net = require("net");
const path = require("path");
const { spawn } = require("child_process");
const { ensureEnvFile, loadEnvFile, ENV_PATH } = require("./lib/local-env");
const { missingWorkspaceLinks } = require("./lib/workspaces");

const ROOT = path.resolve(__dirname, "..");

/** Whether something is already listening on a local port. */
function portInUse(port) {
  return new Promise((resolve) => {
    const server = net
      .createServer()
      .once("error", (err) => resolve(err.code === "EADDRINUSE"))
      .once("listening", () => server.close(() => resolve(false)))
      .listen(port, "127.0.0.1");
  });
}

/**
 * Refuse to start over an occupied port.
 *
 * Without this the failure is silent and deeply confusing: the sidebar runs
 * with `--strictPort`, so it exits immediately while the API and worker carry
 * on. The browser then loads a *previous* run's stale sidebar, which may be
 * built against different configuration — the symptom is a card that will not
 * authenticate, with nothing in the logs pointing at the cause.
 */
async function checkPorts() {
  const wanted = [
    ["API", process.env.API_PORT || "3001"],
    ["sidebar", process.env.SIDEBAR_PORT || "5173"],
  ];

  const taken = [];
  for (const [name, port] of wanted) {
    if (await portInUse(Number(port))) taken.push(`${name} port ${port}`);
  }

  if (taken.length === 0) return;

  console.error(
    `\nAlready in use: ${taken.join(", ")}.\n\n` +
      "Another copy of this stack is probably still running. Stop it, or set\n" +
      "API_PORT / SIDEBAR_PORT to free ports, then try again.\n"
  );
  process.exit(1);
}

async function main() {
  if (ensureEnvFile()) {
    console.log(`Wrote local configuration to ${path.relative(ROOT, ENV_PATH)}\n`);
  }
  loadEnvFile();

  if (!process.env.DATABASE_URL) {
    console.error(
      "\nDATABASE_URL is not set and no .env was found.\n" +
        "Run `npm run demo:start` for the full first-run setup.\n"
    );
    process.exit(1);
  }

  // Catch this before spawning three services. Otherwise the API dies on a
  // module-not-found naming a package that is visibly present in the repo,
  // while the worker and sidebar start normally — so the stack looks alive and
  // the browser reports only that it cannot reach the API.
  const missing = missingWorkspaceLinks();
  if (missing.length > 0) {
    console.error(
      `\nThese workspace packages are not linked into node_modules:\n` +
        `  ${missing.join("\n  ")}\n\n` +
        "That happens when a checkout adds a package to a tree installed on an\n" +
        "earlier branch. Fix it with:\n\n  npm install\n"
    );
    process.exit(1);
  }

  await checkPorts();

  const child = spawn(
    "npx",
    [
      "concurrently",
      "--names", "api,worker,sidebar",
      "--prefix-colors", "cyan,yellow,green",
      "npm run dev --workspace=apps/api",
      "npm run dev:worker --workspace=apps/api",
      "npm run dev --workspace=apps/sidebar",
    ],
    { cwd: ROOT, stdio: "inherit", env: process.env }
  );

  child.on("exit", (code) => process.exit(code ?? 0));
}

void main();
