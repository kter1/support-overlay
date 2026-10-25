import { describe, expect, it } from "vitest";
import { Writable } from "stream";
import Fastify from "fastify";
import { safeErrorInfo, safeRequestInfo } from "../src/middleware/logging";
import { registerErrorHandling } from "../src/middleware/errors";
import { correlationIdMiddleware } from "../src/middleware/correlationId";
import { parseDatabaseUrl, validateEnv } from "../../../scripts/lib/env-validator";

describe("privacy boundaries", () => {
  it("keeps credentials, query values, request bodies and database details out of error logs", async () => {
    let logs = "";
    const stream = new Writable({ write(chunk, _encoding, done) { logs += chunk.toString(); done(); } });
    const app = Fastify({ logger: { stream, serializers: { req: safeRequestInfo, err: safeErrorInfo } } });
    app.addHook("onRequest", correlationIdMiddleware);
    registerErrorHandling(app);
    app.post("/failure", async () => {
      throw Object.assign(new Error("SQL failed for private@example.invalid with secret-password"), { code: "23505", detail: "customer-body" });
    });
    try {
      const response = await app.inject({ method: "POST", url: "/failure?email=private@example.invalid", headers: { authorization: "Bearer credential-canary", cookie: "session=cookie-canary", "x-correlation-id": "private@example.invalid" }, payload: { message: "customer-body" } });
      expect(response.statusCode).toBe(500);
      expect(response.headers["x-correlation-id"]).not.toBe("private@example.invalid");
      for (const value of ["private@example.invalid", "secret-password", "credential-canary", "cookie-canary", "customer-body", "SQL failed"]) {
        expect(logs).not.toContain(value);
        expect(response.body).not.toContain(value);
      }
      expect(logs).toContain("23505");
      expect(logs).toContain("/failure");
      expect(logs).toContain(response.json().correlation_id);
    } finally { await app.close(); }
  });

  it("does not echo malformed database connection credentials", () => {
    const raw = "postgresql://private-user:secret-password@host:not-a-port/private-db";
    expect(() => parseDatabaseUrl(raw)).toThrow("Cannot parse DATABASE_URL");
    const messages = validateEnv({ DATABASE_URL: raw }).join(" ");
    for (const value of ["private-user", "secret-password", "private-db"]) expect(messages).not.toContain(value);
  });
});
