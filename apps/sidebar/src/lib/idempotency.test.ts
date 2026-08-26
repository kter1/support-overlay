/**
 * Idempotency key retention.
 *
 * The defect this guards against: the key was
 * `${issueId}-${actionType}-${Date.now()}`, so a retry after a network failure
 * minted a *new* key. The server saw a new intent, created a second execution,
 * derived a second effect key, and handed Stripe a second idempotency key — a
 * duplicate refund, produced by an agent doing exactly what the error message
 * told them to do.
 *
 * Every guard downstream of this file was already correct. The client was the
 * only place the chain broke, and it was the only layer with no tests.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { createIdempotencyKeyStore } from "./idempotency";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("idempotency key store", () => {
  it("returns the same key while the outcome is unknown", () => {
    // The scenario that caused duplicate refunds: click, network dies, click
    // again. The second attempt must collide with the first server-side.
    const store = createIdempotencyKeyStore("issue-1");

    const first = store.keyFor("issue_refund");
    const retry = store.keyFor("issue_refund");

    expect(retry).toBe(first);
  });

  it("mints a new key once the server has answered", () => {
    // A deliberate second action after a completed one is a new intent, and
    // must not be swallowed as a replay of the first.
    const store = createIdempotencyKeyStore("issue-1");

    const first = store.keyFor("issue_refund");
    store.release("issue_refund");
    const second = store.keyFor("issue_refund");

    expect(second).not.toBe(first);
  });

  it("keeps a separate key per action type", () => {
    // Refunding and commenting are different intents; a shared key would make
    // the second one silently replay the first.
    const store = createIdempotencyKeyStore("issue-1");

    expect(store.keyFor("issue_refund")).not.toBe(store.keyFor("post_comment"));
  });

  it("does not leak a key across issues", () => {
    // The same action on another ticket is a different intent. A key leaking
    // across issues would suppress a refund that ought to happen.
    const a = createIdempotencyKeyStore("issue-1");
    const b = createIdempotencyKeyStore("issue-2");

    expect(a.keyFor("issue_refund")).not.toBe(b.keyFor("issue_refund"));
  });

  it("scopes the key to its issue and action, for readability in the audit log", () => {
    const store = createIdempotencyKeyStore("issue-1");
    expect(store.keyFor("issue_refund")).toMatch(/^issue-1:issue_refund:/);
  });

  it("reports whether an action is mid-retry", () => {
    const store = createIdempotencyKeyStore("issue-1");
    expect(store.isRetrying("issue_refund")).toBe(false);

    store.keyFor("issue_refund");
    expect(store.isRetrying("issue_refund")).toBe(true);

    store.release("issue_refund");
    expect(store.isRetrying("issue_refund")).toBe(false);
  });

  it("releasing an action that was never started is harmless", () => {
    const store = createIdempotencyKeyStore("issue-1");
    expect(() => store.release("never_clicked")).not.toThrow();
  });

  it("still mints keys without crypto.randomUUID", () => {
    // A sidebar served over plain HTTP on a LAN address has no secure context.
    // Uniqueness matters here; unguessability does not.
    vi.stubGlobal("crypto", {});
    const store = createIdempotencyKeyStore("issue-1");

    const first = store.keyFor("a");
    store.release("a");

    expect(first).toBeTruthy();
    expect(store.keyFor("a")).not.toBe(first);
  });
});
