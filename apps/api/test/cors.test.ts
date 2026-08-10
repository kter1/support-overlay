/**
 * Browser origin policy.
 *
 * A blocked cross-origin request never reaches the server, so it leaves no
 * trace in any log: the only symptom is the browser's generic "Failed to
 * fetch". That makes this the hardest kind of misconfiguration to diagnose
 * from the outside, and the reason the local rule accepts loopback on any port
 * rather than the one port the sidebar was expected to use.
 *
 * The cases below are the three ways the port actually differs in practice —
 * a shifted sidebar, the localhost/127.0.0.1 split, and a stale tab left open
 * on a previous run's port — plus proof that widening to loopback did not
 * widen anything else.
 */
import { describe, it, expect } from "vitest";
import { corsOriginRule, originAllowed } from "../src/middleware/cors";

describe("CORS origin policy", () => {
  describe("local development (SIDEBAR_ORIGIN unset)", () => {
    const rule = corsOriginRule({} as NodeJS.ProcessEnv);

    it("accepts the sidebar wherever it ended up", () => {
      // demo:start moves the sidebar when something already holds 5173.
      for (const origin of [
        "http://localhost:5173",
        "http://localhost:5174",
        "http://localhost:5175",
        "http://localhost:5273",
      ]) {
        expect(originAllowed(rule, origin)).toBe(true);
      }
    });

    it("treats localhost and 127.0.0.1 alike", () => {
      // Different origins to a browser; identical to the person typing them.
      expect(originAllowed(rule, "http://127.0.0.1:5173")).toBe(true);
      expect(originAllowed(rule, "http://[::1]:5173")).toBe(true);
    });

    it("allows a request that carries no Origin at all", () => {
      // curl, a server-to-server client, or a same-origin call. The bearer
      // token is what protects these; CORS never did.
      expect(originAllowed(rule, undefined)).toBe(true);
    });

    it("still refuses a remote origin", () => {
      for (const origin of [
        "https://evil.example.com",
        "http://example.com",
        "https://zendesk.com",
      ]) {
        expect(originAllowed(rule, origin)).toBe(false);
      }
    });

    it("is not fooled by a hostname that merely contains localhost", () => {
      // The failure mode of a substring check rather than an anchored one.
      for (const origin of [
        "http://localhost.evil.com",
        "http://evil-localhost.com",
        "http://127.0.0.1.evil.com",
        "https://notlocalhost",
      ]) {
        expect(originAllowed(rule, origin)).toBe(false);
      }
    });
  });

  describe("configured deployment (SIDEBAR_ORIGIN set)", () => {
    const rule = corsOriginRule({
      SIDEBAR_ORIGIN: "https://app.example.com, https://admin.example.com",
    } as NodeJS.ProcessEnv);

    it("allows exactly the listed origins", () => {
      expect(originAllowed(rule, "https://app.example.com")).toBe(true);
      expect(originAllowed(rule, "https://admin.example.com")).toBe(true);
    });

    it("infers nothing beyond the list", () => {
      // Explicit configuration means explicit: loopback is no longer special.
      expect(originAllowed(rule, "http://localhost:5173")).toBe(false);
      expect(originAllowed(rule, "https://other.example.com")).toBe(false);
    });

    it("ignores an empty setting rather than locking everything out", () => {
      const blank = corsOriginRule({ SIDEBAR_ORIGIN: "   " } as NodeJS.ProcessEnv);
      expect(originAllowed(blank, "http://localhost:5173")).toBe(true);
    });
  });
});
