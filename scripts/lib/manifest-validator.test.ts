/**
 * Manifest validation.
 *
 * The security-relevant case is the secure-parameter check: a token stored
 * without `secure: true` is readable from the browser, which would undo the
 * entire reason the app routes requests through ZAF's server-side proxy.
 */
import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { validateManifest, Manifest } from "./manifest-validator";

const REAL_MANIFEST = path.join(__dirname, "../../apps/sidebar/manifest.json");

function valid(): Manifest {
  return {
    name: "Resolution Card",
    author: { name: "support-overlay", email: "support@example.com" },
    defaultLocale: "en",
    location: { support: { ticket_sidebar: { url: "assets/index.html" } } },
    parameters: [
      { name: "backend_url", type: "text", required: true, secure: false },
      { name: "backend_token", type: "text", required: true, secure: true },
    ],
    frameworkVersion: "2.0",
  };
}

describe("validateManifest", () => {
  it("accepts the manifest this repo ships", () => {
    const manifest = JSON.parse(fs.readFileSync(REAL_MANIFEST, "utf-8"));
    expect(validateManifest(manifest)).toEqual([]);
  });

  it("accepts a well-formed manifest", () => {
    expect(validateManifest(valid())).toEqual([]);
  });

  it("rejects a credential parameter that is not secure", () => {
    const manifest = valid();
    manifest.parameters![1].secure = false;

    const errors = validateManifest(manifest);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("secure");
    expect(errors[0]).toContain("exposed to the browser");
  });

  it("catches credential-shaped names generally, not just one spelling", () => {
    for (const name of ["api_key", "apiKey", "client_secret", "password", "credentials"]) {
      const manifest = valid();
      manifest.parameters!.push({ name, type: "text", required: false, secure: false });

      expect(validateManifest(manifest).join(" "), name).toContain(name);
    }
  });

  it("requires a ticket_sidebar location", () => {
    const manifest = valid();
    manifest.location = { support: {} };

    expect(validateManifest(manifest).join(" ")).toContain("ticket_sidebar");
  });

  it("requires the sidebar url to point into the packaged bundle", () => {
    const manifest = valid();
    manifest.location!.support.ticket_sidebar = { url: "https://example.com/app" };

    // A remote URL would load outside the package and skip the ZAF proxy.
    expect(validateManifest(manifest).join(" ")).toContain("assets/");
  });

  it("requires framework version 2.0", () => {
    const manifest = valid();
    manifest.frameworkVersion = "1.0";

    expect(validateManifest(manifest).join(" ")).toContain("frameworkVersion");
  });

  it("requires author details", () => {
    const manifest = valid();
    delete manifest.author;

    expect(validateManifest(manifest).join(" ")).toContain("author");
  });

  it("rejects duplicate parameter names", () => {
    const manifest = valid();
    manifest.parameters!.push({
      name: "backend_url",
      type: "text",
      required: false,
      secure: false,
    });

    expect(validateManifest(manifest).join(" ")).toContain("duplicate");
  });

  it("rejects an unknown parameter type", () => {
    const manifest = valid();
    manifest.parameters!.push({
      name: "colour",
      type: "rainbow",
      required: false,
      secure: false,
    });

    expect(validateManifest(manifest).join(" ")).toContain("type must be one of");
  });
});
