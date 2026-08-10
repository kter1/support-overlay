/**
 * @file scripts/lib/local-env.js
 * @description Generate and load the local `.env` for the demo.
 *
 * The demo needs sixteen environment variables. Requiring someone to export
 * them by hand before the first run is the single largest barrier to trying
 * this project — and every one of them has an obvious local default or can be
 * generated. So the first run writes a `.env`, and every run loads it.
 *
 * Plain CommonJS with no dependencies: this executes before `npm install` has
 * necessarily provided anything, from the bootstrap wrapper.
 *
 * Two rules:
 *   - Never overwrite an existing `.env`. It is the developer's file; a
 *     regenerated token would silently invalidate a running session.
 *   - Never put a fixed secret in it. Tokens are random per machine, so a
 *     value copied from a README can never become a real credential
 *     somewhere.
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const ROOT = path.resolve(__dirname, "..", "..");
const ENV_PATH = path.join(ROOT, ".env");

/** URL-safe random secret. */
function secret(bytes = 24) {
  return crypto.randomBytes(bytes).toString("base64url");
}

/**
 * Parse a .env file. Deliberately minimal — this reads a file this project
 * generated, not arbitrary shell.
 */
function parseEnv(text) {
  const out = {};

  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    const eq = line.indexOf("=");
    if (eq === -1) continue;

    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();

    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    if (key) out[key] = value;
  }

  return out;
}

function buildDefaults() {
  const pgPassword = secret(18);
  const agentToken = secret();
  const port = "5432";

  return `# Local demo configuration — generated on first run of \`npm run demo:start\`.
#
# Safe to edit, safe to delete (it will be regenerated). Git-ignored.
# Tokens are random per machine; nothing here is a shared or published secret.

# ─── Database ────────────────────────────────────────────────────────────────
# Started by Docker Compose. The three POSTGRES_* values must agree with
# DATABASE_URL — the startup script checks this and tells you if they drift.
POSTGRES_USER=iisl
POSTGRES_PASSWORD=${pgPassword}
POSTGRES_DB=iisl
POSTGRES_PORT=${port}
DATABASE_URL=postgresql://iisl:${pgPassword}@127.0.0.1:${port}/iisl

# ─── API ─────────────────────────────────────────────────────────────────────
API_PORT=3001
API_HOST=127.0.0.1
LOG_LEVEL=info

# ─── Credentials ─────────────────────────────────────────────────────────────
# Each token carries its tenant and role. The API derives tenancy from the
# token, so no endpoint accepts a caller-supplied tenant id.
AGENT_TOKEN=${agentToken}
OPERATOR_TOKEN=${secret()}
WEBHOOK_TOKEN=${secret()}

# ─── Webhook signing secrets ─────────────────────────────────────────────────
# Only needed to accept real provider traffic. Left unset, signature
# verification fails closed; the local fixture endpoint does not use them.
# ZENDESK_WEBHOOK_SECRET=
# STRIPE_WEBHOOK_SECRET=
# SHOPIFY_WEBHOOK_SECRET=

# ─── Worker ──────────────────────────────────────────────────────────────────
WORKER_POLL_INTERVAL_MS=2000
WORKER_MAX_ATTEMPTS=5

# ─── Connectors ──────────────────────────────────────────────────────────────
# Simulators replay recorded fixtures. Set to false only with real credentials
# configured for that provider.
USE_ZENDESK_SIMULATOR=true
USE_STRIPE_SIMULATOR=true
USE_SHOPIFY_SIMULATOR=true

# ─── Sidebar ─────────────────────────────────────────────────────────────────
SIDEBAR_PORT=5173
VITE_API_BASE_URL=http://localhost:3001
VITE_AGENT_TOKEN=${agentToken}
`;
}

/**
 * Create `.env` if it is missing.
 * Returns true when a new file was written.
 */
function ensureEnvFile() {
  if (fs.existsSync(ENV_PATH)) return false;

  // 0600: the file holds the database password and three bearer tokens.
  fs.writeFileSync(ENV_PATH, buildDefaults(), { mode: 0o600 });
  return true;
}

/**
 * Load `.env` into process.env.
 *
 * A variable already set in the real environment wins. Someone who exported
 * DATABASE_URL to point at a different database means it, and a file on disk
 * should not quietly override the command they just ran.
 */
function loadEnvFile() {
  if (!fs.existsSync(ENV_PATH)) return {};

  const parsed = parseEnv(fs.readFileSync(ENV_PATH, "utf8"));

  for (const [key, value] of Object.entries(parsed)) {
    if (process.env[key] === undefined || process.env[key] === "") {
      process.env[key] = value;
    }
  }

  return parsed;
}

module.exports = { ENV_PATH, ensureEnvFile, loadEnvFile, parseEnv };
