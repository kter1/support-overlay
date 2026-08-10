#!/usr/bin/env ts-node
/**
 * @file scripts/package-zendesk-app.ts
 * @description Build an installable Zendesk app package.
 *
 * Produces the layout ZAF expects:
 *
 *   manifest.json
 *   assets/index.html        ← the sidebar bundle entry
 *   assets/*.js, *.css       ← hashed build output
 *   assets/logo.png          ← app icon
 *   translations/en.json
 *
 * The result is dist/zendesk-app.zip, uploadable via Admin Center → Apps →
 * Upload private app, or installable with `zcli apps:create` from the unzipped
 * directory.
 *
 * Usage: npm run app:package
 */
import { execFileSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { validateManifest } from "./lib/manifest-validator";
import { renderLogo } from "./lib/logo";

const ROOT = path.join(__dirname, "..");
const SIDEBAR = path.join(ROOT, "apps/sidebar");
const OUT_DIR = path.join(ROOT, "dist/zendesk-app");
const ZIP_PATH = path.join(ROOT, "dist/zendesk-app.zip");

function log(message: string): void {
  console.log(`  ${message}`);
}

function copyDir(from: string, to: string): void {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const src = path.join(from, entry.name);
    const dest = path.join(to, entry.name);
    if (entry.isDirectory()) {
      copyDir(src, dest);
    } else {
      fs.copyFileSync(src, dest);
    }
  }
}

function main(): void {
  console.log("Packaging Zendesk app\n");

  // ── 1. Validate the manifest before building anything ──────────────────
  const manifestPath = path.join(SIDEBAR, "manifest.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
  const errors = validateManifest(manifest);

  if (errors.length > 0) {
    console.error("✗ manifest.json is not valid:\n");
    for (const error of errors) console.error(`  - ${error}`);
    process.exit(1);
  }
  log("✓ manifest.json valid");

  // ── 2. Build the sidebar bundle ────────────────────────────────────────
  execFileSync("npm", ["run", "build", "--workspace=apps/sidebar"], {
    cwd: ROOT,
    stdio: "inherit",
  });

  const bundleDir = path.join(SIDEBAR, "dist");
  if (!fs.existsSync(path.join(bundleDir, "index.html"))) {
    console.error("✗ Build produced no index.html");
    process.exit(1);
  }
  log("✓ sidebar built");

  // ── 3. Assemble the package ────────────────────────────────────────────
  fs.rmSync(OUT_DIR, { recursive: true, force: true });
  fs.mkdirSync(path.join(OUT_DIR, "assets"), { recursive: true });
  fs.mkdirSync(path.join(OUT_DIR, "translations"), { recursive: true });

  copyDir(bundleDir, path.join(OUT_DIR, "assets"));
  fs.copyFileSync(manifestPath, path.join(OUT_DIR, "manifest.json"));

  const logoSource = path.join(SIDEBAR, "assets/logo.png");
  const logoTarget = path.join(OUT_DIR, "assets/logo.png");
  if (fs.existsSync(logoSource)) {
    fs.copyFileSync(logoSource, logoTarget);
    log("✓ logo.png included");
  } else {
    fs.writeFileSync(logoTarget, renderLogo(320));
    log("! logo.png generated — replace with brand artwork before publishing");
  }

  // Settings labels shown in the app installation screen.
  fs.writeFileSync(
    path.join(OUT_DIR, "translations/en.json"),
    JSON.stringify(
      {
        app: {
          name: manifest.name,
          short_description: "Evidence-backed resolution card for refund tickets.",
          long_description:
            "Shows the payment and order evidence behind a refund ticket, with " +
            "an explained confidence band, and executes resolution actions " +
            "exactly once — a refund whose outcome is unknown is never retried " +
            "automatically.",
          installation_instructions:
            "Enter the base URL of your resolution service and the agent token " +
            "issued for this Zendesk account. The token is stored as a secure " +
            "setting and is never exposed to the browser.",
          parameters: {
            backend_url: {
              label: "Resolution service URL",
              helpText: "Base URL, for example https://overlay.example.com",
            },
            backend_token: {
              label: "Agent token",
              helpText:
                "Issued per Zendesk account. Determines which tenant this app reads.",
            },
          },
        },
      },
      null,
      2
    ) + "\n"
  );
  log("✓ translations/en.json written");

  // ── 4. Zip it ──────────────────────────────────────────────────────────
  fs.rmSync(ZIP_PATH, { force: true });
  execFileSync("zip", ["-rq", ZIP_PATH, "."], { cwd: OUT_DIR });

  const sizeKb = Math.round(fs.statSync(ZIP_PATH).size / 1024);
  console.log(`\n✓ ${path.relative(ROOT, ZIP_PATH)} (${sizeKb} KB)`);
  console.log("\nInstall: Zendesk Admin Center → Apps and integrations →");
  console.log("         Zendesk Support apps → Upload private app");
}

main();
