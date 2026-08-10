/**
 * @support-overlay/api — browser origin policy
 *
 * Two modes, and the distinction is deliberate.
 *
 * `SIDEBAR_ORIGIN` set — a real deployment. Exactly the listed origins are
 * allowed, comma-separated, nothing inferred.
 *
 * Unset — local development, where any loopback origin is accepted regardless
 * of port. Pinning to one port looks tighter but is not: it grants nothing on a
 * machine an attacker would already have to control, while producing a failure
 * with no diagnosable symptom. The sidebar moves to 5174 when something else
 * holds 5173, `localhost` and `127.0.0.1` are different origins to a browser,
 * and a stale tab on the old port is indistinguishable from a working one. All
 * three surface identically as "Failed to fetch" with nothing in the API log,
 * because a blocked request is rejected by the browser before it is sent.
 *
 * Installed in Zendesk none of this applies: ZAF `secure: true` requests are
 * proxied server-side and carry no browser origin.
 */

/** Loopback only — a hostname merely *containing* localhost must not match. */
const LOOPBACK_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;

export type OriginCallback = (err: Error | null, allow: boolean) => void;
export type OriginRule =
  | string[]
  | ((origin: string | undefined, cb: OriginCallback) => void);

/** Build the CORS origin rule from the environment. */
export function corsOriginRule(env: NodeJS.ProcessEnv = process.env): OriginRule {
  const configured = env.SIDEBAR_ORIGIN;

  if (configured && configured.trim() !== "") {
    return configured
      .split(",")
      .map((o) => o.trim())
      .filter((o) => o.length > 0);
  }

  return (origin, cb) => {
    // No Origin header: a same-origin call, a server-to-server client, or curl.
    // CORS is not what protects those — the bearer token is.
    if (!origin) return cb(null, true);
    cb(null, LOOPBACK_ORIGIN.test(origin));
  };
}

/** Whether a rule would admit an origin. Exported for tests and diagnostics. */
export function originAllowed(rule: OriginRule, origin: string | undefined): boolean {
  if (Array.isArray(rule)) {
    return origin !== undefined && rule.includes(origin);
  }

  let allowed = false;
  rule(origin, (_err, ok) => {
    allowed = ok;
  });
  return allowed;
}
