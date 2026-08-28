#!/usr/bin/env node
/**
 * @file scripts/demo-start-bootstrap.js
 * @description Bootstrap wrapper for `npm run demo:start`.
 *
 * Goal: make startup one command, even on first run.
 * If local dependencies are missing, install them first, then run the
 * TypeScript startup sequence (`demo:start:internal`).
 */

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const { ENV_PATH, ensureEnvFile, loadEnvFile } = require("./lib/local-env");
const { missingWorkspaceLinks, missingWorkspaceBuilds } = require("./lib/workspaces");

const ROOT = path.resolve(__dirname, "..");
const BIN_DIR = path.join(ROOT, "node_modules", ".bin");

function binPath(name) {
  if (process.platform === "win32") return path.join(BIN_DIR, `${name}.cmd`);
  return path.join(BIN_DIR, name);
}

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: ROOT,
    stdio: "inherit",
    env: process.env,
  });

  if (result.error) {
    console.error(`Failed to run '${command} ${args.join(" ")}':`, result.error.message);
    process.exit(1);
  }

  if (typeof result.status === "number" && result.status !== 0) {
    process.exit(result.status);
  }
}

function needsInstall() {
  const nodeModulesDir = path.join(ROOT, "node_modules");
  if (!fs.existsSync(nodeModulesDir)) return true;
  if (!fs.existsSync(binPath("ts-node"))) return true;
  if (!fs.existsSync(binPath("concurrently"))) return true;
  // A checkout can add a workspace package to a tree that was installed on an
  // earlier branch. Everything looks present and everything compiles; only the
  // runtime require fails.
  if (missingWorkspaceLinks().length > 0) return true;
  return false;
}

function ensureDependencies() {
  const missing = missingWorkspaceLinks();

  if (!needsInstall()) return;

  if (missing.length > 0 && fs.existsSync(path.join(ROOT, "node_modules"))) {
    console.log(
      `\nThese workspace packages are not linked yet: ${missing.join(", ")}.\n` +
        "This happens after a checkout that adds a package. Installing...\n"
    );
  } else {
    console.log("\nDependencies not found. Installing project dependencies...\n");
  }

  run("npm", ["install"]);
}

/**
 * Compile the workspace libraries if their entry points are missing.
 *
 * `npm install` links a workspace but never builds it, and these packages
 * publish `main: dist/index.js`. So on a fresh clone — the exact path the
 * README's one command promises — the seed step failed on `Cannot find module
 * '@iisl/extraction'`, naming a package sitting right there in the repository.
 *
 * Checked rather than always run, because a rebuild on every start would add
 * time to the common case where nothing changed.
 */
function ensureWorkspaceBuilds() {
  const missing = missingWorkspaceBuilds();
  if (missing.length === 0) return;

  console.log(`\nBuilding workspace libraries: ${missing.join(", ")}\n`);
  run("npm", ["run", "build:workspace-libs"]);
}

/**
 * Configuration comes before dependencies: if the first run is going to write
 * a `.env`, say so before several quiet minutes of `npm install`.
 */
function ensureConfiguration() {
  if (ensureEnvFile()) {
    console.log(`\nFirst run — wrote local configuration to ${path.relative(ROOT, ENV_PATH)}`);
    console.log("Generated random tokens and a database password. Edit or delete it freely.\n");
  }

  loadEnvFile();
}

function main() {
  ensureConfiguration();
  ensureDependencies();
  // After install, so a freshly linked package is built rather than reported
  // missing on the next line.
  ensureWorkspaceBuilds();
  // The child process inherits process.env, so the loaded values reach every
  // step of the startup sequence.
  run("npm", ["run", "demo:start:internal"]);
}

main();
