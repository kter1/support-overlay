/**
 * @support-overlay/api — Fastify server entry point
 *
 * Run: npm run dev (from apps/api)
 *
 * Every route group except /health is behind a bearer credential that carries
 * its own tenant; see middleware/auth.ts.
 */
import Fastify from "fastify";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";

import { webhookRoutes } from "./routes/webhooks";
import { cardRoutes } from "./routes/card";
import { actionsRoutes } from "./routes/actions";
import { approvalRoutes } from "./routes/approvals";
import { opsRoutes } from "./routes/ops";
import { metricsRoutes } from "./routes/metrics";
import { correlationIdMiddleware } from "./middleware/correlationId";

const server = Fastify({
  logger: {
    level: process.env.LOG_LEVEL ?? "info",
  },
});

// ─── Plugins ──────────────────────────────────────────────────────────────────

server.register(cors, {
  origin: process.env.SIDEBAR_ORIGIN ?? "http://localhost:5173",
  credentials: true,
});

server.register(helmet, { contentSecurityPolicy: false });

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

// ─── Health check ─────────────────────────────────────────────────────────────

server.get("/health", async () => ({
  status: "ok",
  version: "1.1.3",
  timestamp: new Date().toISOString(),
}));

// ─── Routes ───────────────────────────────────────────────────────────────────

server.register(webhookRoutes, { prefix: "/webhooks" });
server.register(cardRoutes, { prefix: "/api/v1/card" });
server.register(actionsRoutes, { prefix: "/api/v1/actions" });
server.register(approvalRoutes, { prefix: "/api/v1/approvals" });
server.register(opsRoutes, { prefix: "/ops" });
server.register(metricsRoutes, { prefix: "/metrics" });

// ─── Start ────────────────────────────────────────────────────────────────────

const portRaw = process.env.API_PORT ?? process.env.PORT ?? "3001";
const host = process.env.API_HOST ?? "127.0.0.1";
const PORT = parseInt(portRaw, 10);

if (Number.isNaN(PORT)) {
  throw new Error(`Invalid API port: '${portRaw}'. Set API_PORT (or PORT) to a number.`);
}

server.listen({ port: PORT, host }, (err) => {
  if (err) {
    server.log.error(err);
    process.exit(1);
  }
  server.log.info(`IISL API server listening on port ${PORT}`);
});

export { server };
