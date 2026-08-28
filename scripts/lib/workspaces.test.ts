/**
 * Workspace link detection.
 *
 * The failure this exists for: a tree installed on one branch, then a checkout
 * that adds a workspace package. `node_modules` is present, every binary is
 * present, and `tsc` compiles the new package without complaint because it
 * resolves through TypeScript path mapping — so the startup check saw a
 * healthy install and skipped `npm install`. The only symptom appeared at
 * runtime, as a module-not-found naming a package sitting in the repository.
 *
 * These use a fixture tree rather than the real repo, so the broken state is
 * reachable in a test.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { missingWorkspaceLinks, missingWorkspaceBuilds, declaredWorkspacePackages } = require("./workspaces");

let root: string;

function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value));
}

/** A repo with two workspace packages declared. */
function buildFixture(workspaces: unknown = ["apps/*", "packages/*"]): void {
  writeJson(path.join(root, "package.json"), { name: "fixture", workspaces });
  writeJson(path.join(root, "packages", "alpha", "package.json"), { name: "@fx/alpha" });
  writeJson(path.join(root, "packages", "beta", "package.json"), { name: "@fx/beta" });
  writeJson(path.join(root, "apps", "web", "package.json"), { name: "@fx/web" });
}

/** Pretend npm linked these into node_modules. */
function link(...names: string[]): void {
  for (const name of names) {
    fs.mkdirSync(path.join(root, "node_modules", name), { recursive: true });
  }
}

describe("workspace link detection", () => {
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "ws-test-"));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("finds every declared package", () => {
    buildFixture();
    expect(declaredWorkspacePackages(root).sort()).toEqual([
      "@fx/alpha",
      "@fx/beta",
      "@fx/web",
    ]);
  });

  it("reports nothing when all packages are linked", () => {
    buildFixture();
    link("@fx/alpha", "@fx/beta", "@fx/web");
    expect(missingWorkspaceLinks(root)).toEqual([]);
  });

  it("catches a package added after the last install", () => {
    // Exactly the reported failure: node_modules is present and populated,
    // but the package added by the checkout was never linked.
    buildFixture();
    link("@fx/alpha", "@fx/web");
    expect(missingWorkspaceLinks(root)).toEqual(["@fx/beta"]);
  });

  it("treats a tree with no node_modules as entirely missing", () => {
    buildFixture();
    expect(missingWorkspaceLinks(root).sort()).toEqual([
      "@fx/alpha",
      "@fx/beta",
      "@fx/web",
    ]);
  });

  it("supports the object form of the workspaces field", () => {
    buildFixture({ packages: ["packages/*"] });
    link("@fx/alpha");
    expect(missingWorkspaceLinks(root)).toEqual(["@fx/beta"]);
  });

  it("ignores a directory that is not a package", () => {
    buildFixture();
    fs.mkdirSync(path.join(root, "packages", "not-a-package"), { recursive: true });
    link("@fx/alpha", "@fx/beta", "@fx/web");
    expect(missingWorkspaceLinks(root)).toEqual([]);
  });

  it("returns nothing rather than throwing on an unreadable root", () => {
    // A missing package.json must not take down startup before it can report.
    expect(declaredWorkspacePackages(path.join(root, "nope"))).toEqual([]);
  });
});

describe("workspace build detection", () => {
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "ws-build-"));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  /** A library that publishes a compiled entry point, as ours all do. */
  function library(name: string, dir: string): void {
    writeJson(path.join(root, dir, "package.json"), {
      name,
      main: "dist/index.js",
      scripts: { build: "tsc" },
    });
  }

  function compiled(dir: string): void {
    const file = path.join(root, dir, "dist", "index.js");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "");
  }

  it("reports a library whose entry point has never been compiled", () => {
    // The fresh-clone case: npm links the workspace but does not build it, so
    // the link resolves and the file behind it does not.
    writeJson(path.join(root, "package.json"), { name: "fixture", workspaces: ["packages/*"] });
    library("@fx/alpha", "packages/alpha");

    expect(missingWorkspaceBuilds(root)).toEqual(["@fx/alpha"]);
  });

  it("reports nothing once the entry point exists", () => {
    writeJson(path.join(root, "package.json"), { name: "fixture", workspaces: ["packages/*"] });
    library("@fx/alpha", "packages/alpha");
    compiled("packages/alpha");

    expect(missingWorkspaceBuilds(root)).toEqual([]);
  });

  it("names only the libraries that are actually missing", () => {
    writeJson(path.join(root, "package.json"), { name: "fixture", workspaces: ["packages/*"] });
    library("@fx/alpha", "packages/alpha");
    library("@fx/beta", "packages/beta");
    compiled("packages/beta");

    expect(missingWorkspaceBuilds(root)).toEqual(["@fx/alpha"]);
  });

  it("ignores apps, which declare no entry point and run from source", () => {
    // Our two apps have a build script but no `main`. Flagging them would make
    // every start rebuild the sidebar for nothing.
    writeJson(path.join(root, "package.json"), {
      name: "fixture",
      workspaces: ["apps/*", "packages/*"],
    });
    writeJson(path.join(root, "apps", "web", "package.json"), {
      name: "@fx/web",
      scripts: { build: "vite build" },
    });

    expect(missingWorkspaceBuilds(root)).toEqual([]);
  });

  it("ignores a package that declares an entry point but builds nothing", () => {
    // Hand-written JS with no build step: there is nothing to run to produce
    // the file, so reporting it would send startup into a build that cannot fix it.
    writeJson(path.join(root, "package.json"), { name: "fixture", workspaces: ["packages/*"] });
    writeJson(path.join(root, "packages", "alpha", "package.json"), {
      name: "@fx/alpha",
      main: "index.js",
    });

    expect(missingWorkspaceBuilds(root)).toEqual([]);
  });
});
