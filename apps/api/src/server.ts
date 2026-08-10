/**
 * @support-overlay/api — Fastify server entry point
 *
 * Run: npm run dev (from apps/api)
 *
 * Every route group except /health and /ready is behind a bearer credential
 * that carries its own tenant; see middleware/auth.ts.
 */
import Fastify from "fastify";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";

import { webhookRoutes } from "./routes/webhooks";
import { cardRoutes } from "./routes/card";
import { actionsRoutes } from "./routes/actions";
import { approvalRoutes } from "./routes/approvals";
import { opsRoutes } from "./routes/ops";
import { metricsRoutes } from "./routes/metrics";
import { correlationIdMiddleware } from "./middleware/correlationId";
import { registerErrorHandling } from "./middleware/errors";
import { query, getDriver } from "./db/pool";
import { corsOriginRule } from "./middleware/cors";

const server = Fastify({
  logger: {
    level: process.env.LOG_LEVEL ?? "info",
    // Never log credentials, even at debug level.
    redact: {
      paths: [
        "req.headers.authorization",
        "req.headers.cookie",
        "req.headers['stripe-signature']",
        "req.headers['x-shopify-hmac-sha256']",
        "req.headers['x-zendesk-webhook-signature']",
      ],
      censor: "[redacted]",
    },
  },
  // Bound request size: webhook payloads are small, and an unbounded body is a
  // trivial way to exhaust memory.
  bodyLimit: 1_048_576,
  trustProxy: true,
});

// ─── Plugins ──────────────────────────────────────────────────────────────────

server.register(cors, {
  origin: corsOriginRule(),
  credentials: true,
});

server.register(helmet, { contentSecurityPolicy: false });

/**
 * Rate limiting keyed by credential rather than IP: installed in Zendesk, every
 * request arrives from Zendesk's proxy, so all tenants would otherwise share
 * one IP bucket and a single busy account could throttle everyone else.
 */
server.register(rateLimit, {
  max: parseInt(process.env.RATE_LIMIT_MAX ?? "300", 10),
  timeWindow: process.env.RATE_LIMIT_WINDOW ?? "1 minute",
  keyGenerator: (request) => {
    const auth = request.headers.authorization;
    return auth ? `token:${hashKey(auth)}` : `ip:${request.ip}`;
  },
  errorResponseBuilder: (request, context) => ({
    error: "Too many requests",
    hint: `Retry after ${Math.ceil(context.ttl / 1000)} seconds.`,
    correlation_id: request.correlationId,
  }),
});

/** Short, non-reversible bucket key — the raw token never reaches the limiter. */
function hashKey(value: string): string {
  let hash = 0;
  for (let i = 0; i < value.length; i++) {
    hash = (hash * 31 + value.charCodeAt(i)) | 0;
  }
  return String(hash);
}

// ─── Body parsing ─────────────────────────────────────────────────────────────

/**
 * Keep the raw bytes alongside the parsed JSON. Webhook signatures are computed
 * over exactly what the provider sent; re-serializing the parsed object
 * produces different bytes and the HMAC never matches.
 */
server.addContentTypeParser(
  "application/json",
  { parseAs: "buffer" },
  (request, body: Buffer, done) => {
    (request as typeof request & { rawBody?: Buffer }).rawBody = body;

    if (body.length === 0) {
      done(null, undefined);
      return;
    }

    try {
      done(null, JSON.parse(body.toString("utf8")));
    } catch (err) {
      const error = err as Error & { statusCode?: number };
      error.statusCode = 400;
      done(error, undefined);
    }
  }
);

// ─── Middleware ───────────────────────────────────────────────────────────────

server.addHook("onRequest", correlationIdMiddleware);
registerErrorHandling(server);

// ─── Liveness and readiness ───────────────────────────────────────────────────

/** Liveness: the process is up. Deliberately does not touch the database. */
server.get("/health", async () => ({
  status: "ok",
  version: process.env.APP_VERSION ?? "0.1.0",
  timestamp: new Date().toISOString(),
}));

/**
 * Readiness: can this instance actually serve traffic? Checks the database,
 * so a rolling deploy does not route to an instance that cannot reach it.
 */
server.get("/ready", async (request, reply) => {
  try {
    await query("SELECT 1");
    return { status: "ready", timestamp: new Date().toISOString() };
  } catch (err) {
    request.log.error({ err }, "Readiness check failed");
    return reply.status(503).send({
      status: "not_ready",
      error: "Database unavailable",
      correlation_id: request.correlationId,
    });
  }
});

// ─── Routes ───────────────────────────────────────────────────────────────────

server.register(webhookRoutes, { prefix: "/webhooks" });
server.register(cardRoutes, { prefix: "/api/v1/card" });
server.register(actionsRoutes, { prefix: "/api/v1/actions" });
server.register(approvalRoutes, { prefix: "/api/v1/approvals" });
server.register(opsRoutes, { prefix: "/ops" });
server.register(metricsRoutes, { prefix: "/metrics" });

// ─── Lifecycle ────────────────────────────────────────────────────────────────

const portRaw = process.env.API_PORT ?? process.env.PORT ?? "3001";
const host = process.env.API_HOST ?? "127.0.0.1";
const PORT = parseInt(portRaw, 10);

if (Number.isNaN(PORT)) {
  throw new Error(`Invalid API port: '${portRaw}'. Set API_PORT (or PORT) to a number.`);
}

/**
 * Stop accepting connections, let in-flight requests finish, then close the
 * pool. Without this a deploy can cut a request off mid-transaction.
 */
async function shutdown(signal: string): Promise<void> {
  server.log.info(`${signal} received — draining`);
  try {
    await server.close();
    await getDriver().end();
    process.exit(0);
  } catch (err) {
    server.log.error({ err }, "Error during shutdown");
    process.exit(1);
  }
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

if (require.main === module) {
  server.listen({ port: PORT, host }, (err) => {
    if (err) {
      server.log.error(err);
      process.exit(1);
    }
    server.log.info(`API listening on ${host}:${PORT}`);
  });
}

export { server };
