/**
 * @support-overlay/api — Authentication and tenancy
 *
 * Tenancy is derived from the presented bearer token, never from a request
 * header. Previously every route but /ops read `x-tenant-id` straight off the
 * request, so any caller who knew a tenant UUID could read that tenant's cards
 * and execute actions against their Stripe and Zendesk accounts.
 *
 * Tokens are stored as SHA-256 hashes in api_credentials. A token maps to
 * exactly one tenant and one role:
 *
 *   agent    → sidebar endpoints: card, actions, approvals, metrics
 *   operator → /ops repair endpoints
 *   webhook  → webhook ingestion
 *
 * The authenticated principal_id is what gets written to audit_log.actor_id, so
 * the audit trail reflects who actually called rather than who claimed to.
 */
import { FastifyRequest, FastifyReply } from "fastify";
import { createHash, timingSafeEqual } from "crypto";
import { query } from "../db/pool";

export type AuthRole = "agent" | "operator" | "webhook";

export interface AuthContext {
  tenantId: string;
  role: AuthRole;
  principalId: string;
  credentialId: string;
}

declare module "fastify" {
  interface FastifyRequest {
    auth: AuthContext;
  }
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/**
 * Compare two hex digests without leaking timing information. Both are
 * fixed-length SHA-256 hex, so a length mismatch means no match.
 */
function digestsEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, "hex");
  const right = Buffer.from(b, "hex");
  if (left.length !== right.length || left.length === 0) return false;
  return timingSafeEqual(left, right);
}

function extractBearer(request: FastifyRequest): string | null {
  const header = request.headers["authorization"];
  if (typeof header !== "string") return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? match[1].trim() : null;
}

interface CredentialRow {
  id: string;
  tenant_id: string;
  role: AuthRole;
  principal_id: string;
  token_sha256: string;
}

/**
 * Resolve a bearer token to its credential. Returns null when the token is
 * unknown, inactive, or revoked.
 */
export async function resolveToken(
  token: string
): Promise<AuthContext | null> {
  const digest = hashToken(token);

  const result = await query<CredentialRow>(
    `SELECT id, tenant_id, role, principal_id, token_sha256
       FROM api_credentials
      WHERE token_sha256 = $1
        AND is_active = true
        AND revoked_at IS NULL
      LIMIT 1`,
    [digest]
  );

  const row = result.rows[0];
  // The lookup is already exact-match on an indexed hash; the constant-time
  // compare guards against a future change to a non-exact lookup.
  if (!row || !digestsEqual(row.token_sha256, digest)) return null;

  return {
    tenantId: row.tenant_id,
    role: row.role,
    principalId: row.principal_id,
    credentialId: row.id,
  };
}

/**
 * Build an onRequest hook that requires one of the given roles.
 *
 * Register per route group:
 *   app.addHook("onRequest", requireAuth("agent"));
 */
export function requireAuth(...allowedRoles: AuthRole[]) {
  return async function authHook(
    request: FastifyRequest,
    reply: FastifyReply
  ): Promise<void> {
    const token = extractBearer(request);

    if (!token) {
      await reply.status(401).send({
        error: "Authentication required",
        hint: "Send an Authorization: Bearer <token> header.",
      });
      return;
    }

    const auth = await resolveToken(token);

    if (!auth) {
      await reply.status(401).send({ error: "Invalid or revoked token" });
      return;
    }

    if (allowedRoles.length > 0 && !allowedRoles.includes(auth.role)) {
      // The token is valid but not for this surface. Say so without echoing
      // which role it does hold.
      await reply.status(403).send({
        error: "This credential is not permitted to call this endpoint",
      });
      return;
    }

    request.auth = auth;

    // Best-effort; a failed timestamp update must not fail the request.
    void query(
      `UPDATE api_credentials SET last_used_at = now() WHERE id = $1`,
      [auth.credentialId]
    ).catch(() => undefined);
  };
}

/**
 * Confirm the authenticated principal is allowed to approve for this tenant.
 * Approval endpoints call this instead of trusting a manager_id from the body.
 */
export async function isManager(
  tenantId: string,
  principalId: string
): Promise<boolean> {
  const result = await query<{ id: string }>(
    `SELECT id FROM manager_grants
      WHERE tenant_id = $1 AND principal_id = $2 AND is_active = true
      LIMIT 1`,
    [tenantId, principalId]
  );
  return result.rows.length > 0;
}
