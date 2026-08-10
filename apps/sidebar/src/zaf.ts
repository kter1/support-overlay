/**
 * Zendesk Apps Framework integration.
 *
 * The app runs in two modes and this module is the only place that knows which:
 *
 *   Installed in Zendesk — ticket id, agent identity, and the account subdomain
 *     come from ZAF context. Backend calls go through ZAF's server-side proxy
 *     with `secure: true`, so `{{setting.backend_token}}` is substituted by
 *     Zendesk and the token never reaches the browser. That is the whole reason
 *     to route through the proxy: a token embedded in a bundle served to agents
 *     is a published credential.
 *
 *   Standalone — the local demo. Reads a ticket from the URL or a picker and
 *     calls the API directly with a token from build-time env. Acceptable for a
 *     demo on localhost; never for a real install, which is why this mode is
 *     labelled in the UI.
 *
 * Detecting which mode we are in is not "is the SDK loaded?". index.html pulls
 * the SDK from Zendesk's *public* CDN, so the global is defined in any browser
 * with network access — including a plain localhost tab. Keying off it alone
 * sends the local demo down the embedded path, where it asks a parent frame
 * that does not exist for a ticket and reports that it cannot read one.
 *
 * A Zendesk app is always an iframe served by Zendesk, so being a top-level
 * window is proof we are not installed. That check costs nothing and does not
 * depend on the network, which the SDK's presence does.
 */

export interface ZafContext {
  ticketId: string;
  subdomain: string;
  agentId: string;
  agentName: string;
}

export interface ApiResponse<T> {
  ok: boolean;
  status: number;
  body: T | null;
  error?: string;
}

interface ZafClient {
  get(path: string | string[]): Promise<Record<string, unknown>>;
  context(): Promise<Record<string, unknown>>;
  invoke(name: string, ...args: unknown[]): Promise<unknown>;
  request(options: Record<string, unknown>): Promise<unknown>;
  on(event: string, handler: () => void): void;
  metadata(): Promise<Record<string, unknown>>;
}

declare global {
  interface Window {
    ZAFClient?: { init(): ZafClient };
  }
}

let client: ZafClient | null = null;

/** True when running inside Zendesk. */
export function isEmbedded(): boolean {
  return client !== null;
}

/**
 * Whether this document is running inside a frame.
 *
 * Cross-origin access to `window.top` throws in some browsers, and a throw
 * means there *is* a foreign parent — so treat it as framed rather than
 * letting the exception escape.
 */
function isFramed(): boolean {
  try {
    return window.self !== window.top;
  } catch {
    return true;
  }
}

/**
 * Initialise ZAF if we are actually installed in Zendesk. Safe to call in
 * standalone mode, where it simply reports that we are not embedded.
 */
export function initZaf(): boolean {
  if (client) return true;
  if (typeof window === "undefined" || !window.ZAFClient) return false;

  // The SDK loads from a public CDN, so its presence proves nothing about
  // where we are running. Only a framed document can be a Zendesk app.
  if (!isFramed()) return false;

  try {
    client = window.ZAFClient.init();
    return true;
  } catch {
    // A malformed SDK load should degrade to standalone rather than break the
    // whole panel.
    client = null;
    return false;
  }
}

/**
 * Resize the iframe to fit its content. Zendesk gives apps a fixed default
 * height, so without this the card is clipped.
 */
export async function autoResize(heightPx: number): Promise<void> {
  if (!client) return;
  try {
    await client.invoke("resize", { width: "100%", height: `${Math.ceil(heightPx)}px` });
  } catch {
    // Resizing is cosmetic; never let it surface as an error to the agent.
  }
}

/** Re-render when the agent switches tickets without a reload. */
export function onTicketSwitch(handler: () => void): void {
  if (!client) return;
  try {
    client.on("app.activated", handler);
  } catch {
    // Older ZAF versions may not emit this; the initial load still works.
  }
}

/**
 * How long to wait for ZAF to answer before giving up.
 *
 * ZAF calls resolve over postMessage. If nothing is listening the promise
 * never settles — and an unsettled promise renders as a permanently blank
 * panel with no error, which is the least diagnosable failure the app has.
 * A bounded wait turns that into a message someone can act on.
 */
const ZAF_TIMEOUT_MS = 5000;

function withTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(
        () => reject(new Error(`Zendesk did not respond to ${label} in time`)),
        ZAF_TIMEOUT_MS
      )
    ),
  ]);
}

/** Read ticket, agent, and account identity from ZAF. */
export async function getContext(): Promise<ZafContext | null> {
  if (!client) return null;

  const [data, context] = await Promise.all([
    withTimeout(
      client.get(["ticket.id", "currentUser.id", "currentUser.name"]),
      "a ticket lookup"
    ),
    withTimeout(client.context(), "a context request"),
  ]);

  const ticketId = data["ticket.id"];
  if (ticketId === undefined || ticketId === null) return null;

  return {
    ticketId: String(ticketId),
    subdomain: String(context.account ? (context.account as Record<string, unknown>).subdomain ?? "" : ""),
    agentId: String(data["currentUser.id"] ?? "unknown"),
    agentName: String(data["currentUser.name"] ?? "Agent"),
  };
}

/**
 * Call the backend.
 *
 * Embedded: routed through ZAF's proxy. `secure: true` makes Zendesk substitute
 * the stored secure setting server-side, so the Authorization header is
 * assembled outside the browser.
 *
 * Standalone: a direct fetch with the build-time token.
 */
export async function apiRequest<T>(
  path: string,
  init: { method?: string; body?: unknown } = {}
): Promise<ApiResponse<T>> {
  const method = init.method ?? "GET";

  if (client) {
    try {
      const response = (await client.request({
        url: `{{setting.backend_url}}${path}`,
        type: method,
        contentType: "application/json",
        data: init.body ? JSON.stringify(init.body) : undefined,
        headers: { Authorization: "Bearer {{setting.backend_token}}" },
        secure: true,
        httpCompleteResponse: true,
      })) as { status?: number; responseJSON?: T };

      return {
        ok: true,
        status: response.status ?? 200,
        body: (response.responseJSON ?? null) as T | null,
      };
    } catch (err) {
      const failure = err as { status?: number; responseJSON?: { error?: string } };
      return {
        ok: false,
        status: failure.status ?? 0,
        body: null,
        error: failure.responseJSON?.error ?? describeError(failure.status),
      };
    }
  }

  // Standalone
  const { API_BASE, authHeaders } = await import("./config");

  try {
    const response = await fetch(`${API_BASE}${path}`, {
      method,
      headers: {
        "Content-Type": "application/json",
        ...authHeaders(),
      },
      body: init.body ? JSON.stringify(init.body) : undefined,
    });

    const body = (await response.json().catch(() => null)) as T | null;

    return {
      ok: response.ok,
      status: response.status,
      body,
      error: response.ok
        ? undefined
        : (body as { error?: string } | null)?.error ?? describeError(response.status),
    };
  } catch {
    // `fetch` rejects with a bare "Failed to fetch" for every network-layer
    // failure, and the browser deliberately withholds which one — a refused
    // connection and a blocked cross-origin request are indistinguishable to
    // the page. Since the message is useless on its own, replace it with the
    // two things the reader can actually check.
    return {
      ok: false,
      status: 0,
      body: null,
      error:
        `Could not reach the API at ${API_BASE}. ` +
        "Check that it is running (its /health should answer), and that the " +
        "address above matches the port it started on.",
    };
  }
}

/**
 * Agent-facing failure copy. Says what to do next rather than echoing an HTTP
 * status, and never implies the agent did something wrong.
 */
function describeError(status?: number): string {
  switch (status) {
    case 401:
      return "This app's credentials were not accepted. Ask an admin to check the app settings.";
    case 403:
      return "This app is not permitted to perform that action.";
    case 404:
      return "No resolution record exists for this ticket yet.";
    case 429:
      return "Too many requests just now — this will retry shortly.";
    case 0:
      return "Could not reach the resolution service.";
    default:
      return "The resolution service is temporarily unavailable.";
  }
}
