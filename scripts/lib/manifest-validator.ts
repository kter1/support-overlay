/**
 * @file scripts/lib/manifest-validator.ts
 * @description Validate a Zendesk app manifest before packaging.
 *
 * Catches the mistakes that otherwise surface as an opaque rejection at upload
 * time — or worse, as a working install that leaks a credential because a
 * parameter was not marked secure.
 */

export interface ManifestParameter {
  name?: unknown;
  type?: unknown;
  required?: unknown;
  secure?: unknown;
}

export interface Manifest {
  name?: unknown;
  author?: { name?: unknown; email?: unknown };
  defaultLocale?: unknown;
  location?: Record<string, Record<string, unknown>>;
  parameters?: ManifestParameter[];
  frameworkVersion?: unknown;
  private?: unknown;
}

/** Parameter names that must never be stored unencrypted. */
const SECRET_NAME_PATTERN = /token|secret|password|api[_-]?key|credential/i;

const VALID_PARAMETER_TYPES = [
  "text",
  "password",
  "checkbox",
  "url",
  "number",
  "multiline",
  "hidden",
  "oauth",
];

/**
 * Returns a list of problems. Empty means the manifest is publishable.
 */
export function validateManifest(manifest: Manifest): string[] {
  const errors: string[] = [];

  if (typeof manifest.name !== "string" || manifest.name.trim() === "") {
    errors.push("name is required");
  }

  if (manifest.frameworkVersion !== "2.0") {
    errors.push('frameworkVersion must be "2.0"');
  }

  if (typeof manifest.defaultLocale !== "string") {
    errors.push("defaultLocale is required (for example \"en\")");
  }

  const author = manifest.author;
  if (!author || typeof author.name !== "string" || typeof author.email !== "string") {
    errors.push("author.name and author.email are required");
  }

  // ── Location ────────────────────────────────────────────────────────────
  const support = manifest.location?.support;
  if (!support || typeof support !== "object") {
    errors.push("location.support is required");
  } else {
    const sidebar = support.ticket_sidebar as { url?: unknown } | undefined;
    if (!sidebar) {
      errors.push("location.support.ticket_sidebar is required for this app");
    } else if (typeof sidebar.url !== "string" || !sidebar.url.startsWith("assets/")) {
      errors.push(
        "location.support.ticket_sidebar.url must point into assets/ " +
          "(the packaged bundle), for example assets/index.html"
      );
    }
  }

  // ── Parameters ──────────────────────────────────────────────────────────
  const parameters = manifest.parameters ?? [];
  if (!Array.isArray(parameters)) {
    errors.push("parameters must be an array");
    return errors;
  }

  const seen = new Set<string>();

  for (const [index, parameter] of parameters.entries()) {
    const label = typeof parameter.name === "string" ? parameter.name : `#${index}`;

    if (typeof parameter.name !== "string" || parameter.name.trim() === "") {
      errors.push(`parameter ${label}: name is required`);
      continue;
    }

    if (seen.has(parameter.name)) {
      errors.push(`parameter ${label}: duplicate name`);
    }
    seen.add(parameter.name);

    if (typeof parameter.type !== "string" || !VALID_PARAMETER_TYPES.includes(parameter.type)) {
      errors.push(
        `parameter ${label}: type must be one of ${VALID_PARAMETER_TYPES.join(", ")}`
      );
    }

    // The check that matters. A credential stored without `secure: true` is
    // readable from the browser by anyone who can open the app, which defeats
    // routing requests through the ZAF proxy in the first place.
    if (SECRET_NAME_PATTERN.test(parameter.name) && parameter.secure !== true) {
      errors.push(
        `parameter ${label}: looks like a credential and must set "secure": true, ` +
          "otherwise its value is exposed to the browser"
      );
    }
  }

  return errors;
}
