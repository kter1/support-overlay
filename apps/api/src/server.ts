/**
 * @iisl/api — Fastify Server Entry Point
 * VALIDATION: [COMPILE-PENDING]
 *
 * Starts the IISL API server with all routes registered.
 * Run: npm run dev (from apps/api)
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
const host = process.env.API_HOST ?? "0.0.0.0";
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
