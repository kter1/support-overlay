/**
 * Idempotency keys for agent-triggered actions.
 *
 * This file is the point where the system's central guarantee is either real or
 * theatre. The backend is careful: one execution per `(tenant_id,
 * idempotency_key)`, a deterministic `effect_key` derived from the execution
 * id, and that key handed to Stripe as its own `Idempotency-Key`. Every link
 * holds — provided the client sends the same key when it retries.
 *
 * It previously sent `${issueId}-${actionType}-${Date.now()}`. A network
 * failure after Stripe had already processed the refund would surface as
 * "please try again", re-enable the button, and leave the CTA on screen. The
 * agent clicks again, `Date.now()` has moved, and every downstream guard sees a
 * genuinely new intent: new execution, new effect key, new Stripe idempotency
 * key, second refund. The entire chain defeated at the one point a human
 * touches it.
 *
 * The rule here is the same one the backend already applies to provider calls:
 *
 *   **Keep the key exactly as long as the outcome is unknown.**
 *
 * A transport failure means we do not know whether the server acted, so the key
 * is retained and the retry collides — the API returns the original execution
 * with `idempotent_replay: true`. Any *answer* from the server, including a
 * denial, means we know where we stand, so the key is released and the next
 * click is a new intent. That distinction is `SENT_UNCERTAIN` versus
 * `FAILED_TERMINAL`, applied on the client.
 */

/** Keys held for actions whose outcome we do not yet know. */
export interface IdempotencyKeyStore {
  /** The key for this action, minting one only if none is being retried. */
  keyFor(actionType: string): string;
  /** Called once the server has answered: this intent is settled. */
  release(actionType: string): void;
  /** Whether a key is currently being retried. Exposed for tests and copy. */
  isRetrying(actionType: string): boolean;
}

/**
 * `crypto.randomUUID` needs a secure context, which localhost satisfies but a
 * plain-HTTP LAN address does not. The fallback is not for cryptographic use —
 * a key only has to be unique per intent, not unguessable — so `Math.random`
 * is adequate here and failing to mint a key at all would not be.
 */
function uniqueSuffix(): string {
  const cryptoObj = globalThis.crypto;
  if (cryptoObj && typeof cryptoObj.randomUUID === "function") {
    return cryptoObj.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

/**
 * Create a store scoped to one issue.
 *
 * Scoped per issue rather than globally because the same action type on a
 * different ticket is a different intent, and a key leaking across tickets
 * would suppress a refund that should happen.
 */
export function createIdempotencyKeyStore(issueId: string): IdempotencyKeyStore {
  const inFlight = new Map<string, string>();

  return {
    keyFor(actionType: string): string {
      const retained = inFlight.get(actionType);
      if (retained) return retained;

      const minted = `${issueId}:${actionType}:${uniqueSuffix()}`;
      inFlight.set(actionType, minted);
      return minted;
    },

    release(actionType: string): void {
      inFlight.delete(actionType);
    },

    isRetrying(actionType: string): boolean {
      return inFlight.has(actionType);
    },
  };
}
