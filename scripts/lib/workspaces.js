/**
 * @file scripts/lib/workspaces.js
 * @description Detect workspace packages that are declared but not linked.
 *
 * npm links each workspace into `node_modules/<name>` at install time. Nothing
 * re-checks that afterwards, so a checkout that *adds* a package leaves the
 * tree in a state where the package exists on disk and compiles happily —
 * `tsc` resolves it through the TypeScript path mapping — while every
 * `require("@scope/thing")` at runtime fails.
 *
 * The startup check this replaces only asked whether `node_modules` existed at
 * all, which is true in exactly the case that breaks: an install performed on
 * an earlier branch. The symptom is a module-not-found error naming a package
 * that is plainly sitting in the repository, which reads like a broken build
 * rather than a missing `npm install`.
 *
 * Plain CommonJS with no dependencies: this runs before install.
 */

const fs = require("fs");
const path = require("path");

const DEFAULT_ROOT = path.resolve(__dirname, "..", "..");

/**
 * Expand the workspace patterns npm actually supports here: a literal path, or
 * a single trailing `*`. Anything more exotic is reported as no match, which
 * fails toward running an install rather than skipping one.
 */
function expandPattern(pattern, ROOT) {
  if (!pattern.endsWith("/*")) {
    const dir = path.join(ROOT, pattern);
    return fs.existsSync(dir) ? [dir] : [];
  }

  const parent = path.join(ROOT, pattern.slice(0, -2));
  if (!fs.existsSync(parent)) return [];

  return fs
    .readdirSync(parent, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(parent, entry.name));
}

/** Every workspace package name declared in the root package.json. */
function declaredWorkspacePackages(ROOT = DEFAULT_ROOT) {
  let root;
  try {
    root = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
  } catch {
    return [];
  }

  const patterns = Array.isArray(root.workspaces)
    ? root.workspaces
    : root.workspaces?.packages ?? [];

  const names = [];
  for (const pattern of patterns) {
    for (const dir of expandPattern(pattern, ROOT)) {
      try {
        const pkg = JSON.parse(
          fs.readFileSync(path.join(dir, "package.json"), "utf8")
        );
        if (pkg.name) names.push(pkg.name);
      } catch {
        // A directory without a readable package.json is not a workspace.
      }
    }
  }

  return names;
}

/**
 * Workspace packages that are declared but have no link under node_modules.
 * A non-empty result means an install is required, whatever else is present.
 */
function missingWorkspaceLinks(ROOT = DEFAULT_ROOT) {
  const nodeModules = path.join(ROOT, "node_modules");
  if (!fs.existsSync(nodeModules)) return declaredWorkspacePackages(ROOT);

  return declaredWorkspacePackages(ROOT).filter(
    (name) => !fs.existsSync(path.join(nodeModules, name))
  );
}

module.exports = { declaredWorkspacePackages, missingWorkspaceLinks };
