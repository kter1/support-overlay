/**
 * Mode detection.
 *
 * The bug this guards against was invisible in any environment that could not
 * reach Zendesk's CDN. index.html loads the ZAF SDK from a public URL, so on a
 * normal machine `window.ZAFClient` is defined in an ordinary browser tab —
 * and keying "am I installed in Zendesk?" off that global sent the local demo
 * down the embedded path, where it asked a non-existent parent frame for a
 * ticket and told the user it could not read one.
 *
 * The distinguishing fact is framing, not the SDK: a Zendesk app is always an
 * iframe served by Zendesk, and framing does not depend on the network.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

/** Reset the module so its cached client does not leak between cases. */
async function freshZaf() {
  vi.resetModules();
  return import("./zaf");
}

interface FakeWindow {
  self: unknown;
  top: unknown;
  ZAFClient?: { init(): unknown };
}

function setWindow(win: FakeWindow | undefined): void {
  // The module reads the `window` global directly, as browser code does.
  (globalThis as { window?: unknown }).window = win;
}

const fakeClient = {
  get: async () => ({ "ticket.id": 42 }),
  context: async () => ({ account: { subdomain: "acme" } }),
  invoke: async () => undefined,
  request: async () => undefined,
  on: () => {},
  metadata: async () => ({}),
};

describe("ZAF mode detection", () => {
  beforeEach(() => {
    setWindow(undefined);
  });

  it("stays standalone in a top-level tab even when the SDK loaded", async () => {
    // Exactly the local demo on a machine that can reach the CDN.
    const win: FakeWindow = { self: {}, top: undefined, ZAFClient: { init: () => fakeClient } };
    win.top = win.self;
    setWindow(win);

    const { initZaf, isEmbedded } = await freshZaf();

    expect(initZaf()).toBe(false);
    expect(isEmbedded()).toBe(false);
  });

  it("reports embedded when framed with the SDK present", async () => {
    const win: FakeWindow = {
      self: { name: "app" },
      top: { name: "zendesk" },
      ZAFClient: { init: () => fakeClient },
    };
    setWindow(win);

    const { initZaf, isEmbedded } = await freshZaf();

    expect(initZaf()).toBe(true);
    expect(isEmbedded()).toBe(true);
  });

  it("stays standalone when framed but the SDK never loaded", async () => {
    // A blocked CDN inside a frame is not a Zendesk install either.
    setWindow({ self: { name: "app" }, top: { name: "other" } });

    const { initZaf } = await freshZaf();

    expect(initZaf()).toBe(false);
  });

  it("treats a cross-origin parent as framed rather than throwing", async () => {
    const win: FakeWindow = {
      self: { name: "app" },
      get top() {
        throw new Error("Blocked a frame with origin from accessing a cross-origin frame.");
      },
      ZAFClient: { init: () => fakeClient },
    };
    setWindow(win as FakeWindow);

    const { initZaf } = await freshZaf();

    expect(initZaf()).toBe(true);
  });

  it("degrades to standalone when the SDK throws on init", async () => {
    setWindow({
      self: { name: "app" },
      top: { name: "zendesk" },
      ZAFClient: {
        init: () => {
          throw new Error("malformed SDK");
        },
      },
    });

    const { initZaf, isEmbedded } = await freshZaf();

    expect(initZaf()).toBe(false);
    expect(isEmbedded()).toBe(false);
  });

  it("gives up rather than hanging when Zendesk never answers", async () => {
    vi.useFakeTimers();

    setWindow({
      self: { name: "app" },
      top: { name: "zendesk" },
      ZAFClient: {
        init: () => ({
          ...fakeClient,
          // Nothing is listening on the other side of postMessage.
          get: () => new Promise(() => {}),
          context: () => new Promise(() => {}),
        }),
      },
    });

    const { initZaf, getContext } = await freshZaf();
    expect(initZaf()).toBe(true);

    const pending = getContext();
    const assertion = expect(pending).rejects.toThrow(/did not respond/);
    await vi.advanceTimersByTimeAsync(6000);
    await assertion;

    vi.useRealTimers();
  });
});
