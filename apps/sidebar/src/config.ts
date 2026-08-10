/**
 * Sidebar runtime configuration.
 *
 * The agent token identifies both the caller and the tenant — the API derives
 * tenancy from it, so the sidebar no longer sends (or knows) a tenant id.
 *
 * This is a demo harness. A real Zendesk app would obtain a short-lived token
 * from a ZAF-signed handshake rather than reading it from build-time env; see
 * the installability work in the plan.
 */
export const API_BASE: string =
  import.meta.env.VITE_API_BASE_URL ?? "http://localhost:3001";

export const AGENT_TOKEN: string = import.meta.env.VITE_AGENT_TOKEN ?? "";

/** Auth headers for every API call. */
export function authHeaders(): Record<string, string> {
  return AGENT_TOKEN ? { Authorization: `Bearer ${AGENT_TOKEN}` } : {};
}
