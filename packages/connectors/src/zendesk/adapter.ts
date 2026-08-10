/**
 * @support-overlay/connectors — Zendesk adapter
 *
 * Real API credentials are optional. When ZENDESK_API_TOKEN is not set the
 * adapter uses the fixture simulator, so the local demo runs without Zendesk
 * access.
 *
 * Failures are classified, not flattened into generic Errors:
 *   TimeoutError    → request sent, no response. The effect may have happened;
 *                     the worker treats this as SENT_UNCERTAIN.
 *   PermanentError  → 4xx. Retrying will never succeed.
 *   Error           → anything else; retriable.
 *
 * Retry class notes for callers:
 * - update_ticket_status: RECONCILIATION_FIRST
 * - post_comment: AUTO_RETRY_WITH_DEDUPE
 */
import { TimeoutError, PermanentError } from "@iisl/shared";

/**
 * fetch() surfaces an aborted request as a TimeoutError/AbortError DOMException
 * depending on runtime. Either way the request left the process, so the effect
 * is uncertain rather than known-failed.
 */
function isAbort(err: unknown): boolean {
  const name = (err as { name?: string } | null)?.name;
  return name === "AbortError" || name === "TimeoutError";
}

interface ZendeskComment {
  id: number;
  body: string;
  created_at: string;
  author_id?: number;
  public?: boolean;
}

/** One message in a ticket thread, with enough context to attribute it. */
export interface ConversationMessage {
  id: string;
  body: string;
  createdAt: string;
  /** Customer text is a claim; agent text is record. The distinction matters. */
  authorRole: "customer" | "agent";
  isPublic: boolean;
}

export interface TicketConversation {
  ticketId: string;
  subject: string;
  description: string;
  createdAt: string;
  requesterId: string | null;
  messages: ConversationMessage[];
}

interface ZendeskTicket {
  id: string;
  status: string;
  subject: string;
  updated_at: string;
}

export class ZendeskAdapter {
  private readonly isSimulator: boolean;
  private readonly subdomain: string;
  private readonly apiToken: string;

  constructor() {
    this.subdomain = process.env.ZENDESK_SUBDOMAIN ?? "";
    this.apiToken = process.env.ZENDESK_API_TOKEN ?? "";
    this.isSimulator = !this.apiToken;

    if (this.isSimulator) {
      console.log("[ZendeskAdapter] No credentials found — using simulator");
    }
  }

  async updateTicketStatus(
    ticketId: string,
    targetStatus: string
  ): Promise<void> {
    if (this.isSimulator) {
      return simulatorStore.updateTicketStatus(ticketId, targetStatus);
    }

    const response = await this.apiRequest(
      "PUT",
      `/api/v2/tickets/${ticketId}.json`,
      { ticket: { status: targetStatus } }
    );

    this.assertOk(response, `update ticket ${ticketId}`);
  }

  async getTicketStatus(ticketId: string): Promise<string> {
    if (this.isSimulator) {
      return simulatorStore.getTicketStatus(ticketId);
    }

    const response = await this.apiRequest(
      "GET",
      `/api/v2/tickets/${ticketId}.json`
    );

    if (!response.ok) {
      throw new Error(`Failed to fetch ticket ${ticketId}: ${response.status}`);
    }

    const data = (await response.json()) as { ticket: ZendeskTicket };
    return data.ticket.status;
  }

  async postComment(
    ticketId: string,
    body: string,
    idempotencyKey: string
  ): Promise<string> {
    if (this.isSimulator) {
      return simulatorStore.postComment(ticketId, body, idempotencyKey);
    }

    const response = await this.apiRequest(
      "POST",
      `/api/v2/tickets/${ticketId}/comments.json`,
      { comment: { body, public: true } },
      { "Idempotency-Key": idempotencyKey }
    );

    this.assertOk(response, `post comment on ticket ${ticketId}`);

    const data = (await response.json()) as { comment: { id: number } };
    return String(data.comment.id);
  }

  /**
   * Fetch a ticket with its full comment thread.
   *
   * The extraction layer needs author role and timestamps, not just text: a
   * refund amount stated by the customer is a claim to verify, the same number
   * written by an agent is a restatement, and relative dates ("last Tuesday")
   * only resolve against the message that contains them.
   */
  async getConversation(ticketId: string): Promise<TicketConversation | null> {
    if (this.isSimulator) {
      return simulatorStore.getConversation(ticketId);
    }

    const ticketResponse = await this.apiRequest(
      "GET",
      `/api/v2/tickets/${ticketId}.json`
    );

    if (ticketResponse.status === 404) return null;
    this.assertOk(ticketResponse, `fetch ticket ${ticketId}`);

    const ticketData = (await ticketResponse.json()) as {
      ticket: ZendeskTicket & {
        description?: string;
        requester_id?: number;
        created_at?: string;
      };
    };

    const commentsResponse = await this.apiRequest(
      "GET",
      `/api/v2/tickets/${ticketId}/comments.json?sort_order=asc&per_page=100`
    );
    this.assertOk(commentsResponse, `fetch comments for ticket ${ticketId}`);

    const commentsData = (await commentsResponse.json()) as {
      comments: ZendeskComment[];
    };

    const requesterId = ticketData.ticket.requester_id ?? null;

    return {
      ticketId,
      subject: ticketData.ticket.subject ?? "",
      description: ticketData.ticket.description ?? "",
      createdAt: ticketData.ticket.created_at ?? new Date().toISOString(),
      requesterId: requesterId === null ? null : String(requesterId),
      messages: commentsData.comments.map((comment) => ({
        id: String(comment.id),
        body: comment.body,
        createdAt: comment.created_at,
        // The requester is the customer; everyone else on the thread is staff.
        authorRole:
          requesterId !== null && comment.author_id === requesterId
            ? "customer"
            : "agent",
        isPublic: comment.public !== false,
      })),
    };
  }

  async getRecentComments(ticketId: string): Promise<string[]> {
    if (this.isSimulator) {
      return simulatorStore.getRecentComments(ticketId);
    }

    const response = await this.apiRequest(
      "GET",
      `/api/v2/tickets/${ticketId}/comments.json?sort_order=desc&per_page=10`
    );

    if (!response.ok) {
      throw new Error(`Failed to fetch comments: ${response.status}`);
    }

    const data = (await response.json()) as { comments: ZendeskComment[] };
    return data.comments.map((c) => c.body);
  }

  async getTicket(ticketId: string): Promise<ZendeskTicket | null> {
    if (this.isSimulator) {
      return simulatorStore.getTicket(ticketId);
    }

    const response = await this.apiRequest(
      "GET",
      `/api/v2/tickets/${ticketId}.json`
    );

    if (response.status === 404) return null;
    if (!response.ok) {
      throw new Error(`Failed to fetch ticket: ${response.status}`);
    }

    const data = (await response.json()) as { ticket: ZendeskTicket };
    return data.ticket;
  }

  /** Turn a non-2xx response into the right error class for the retry policy. */
  private assertOk(response: Response, what: string): void {
    if (response.ok) return;

    if (response.status === 408 || response.status === 504) {
      throw new TimeoutError(
        `Zendesk timed out on ${what} (HTTP ${response.status})`
      );
    }
    if (response.status === 429) {
      throw new Error(`Zendesk rate limited ${what} (HTTP 429)`);
    }
    if (response.status >= 400 && response.status < 500) {
      throw new PermanentError(
        `Zendesk rejected ${what} (HTTP ${response.status})`
      );
    }
    throw new Error(`Zendesk failed ${what} (HTTP ${response.status})`);
  }

  private async apiRequest(
    method: string,
    path: string,
    body?: unknown,
    extraHeaders?: Record<string, string>
  ): Promise<Response> {
    const url = `https://${this.subdomain}.zendesk.com${path}`;
    const credentials = Buffer.from(`email@example.com/token:${this.apiToken}`).toString("base64");

    try {
      return await fetch(url, {
        method,
        headers: {
          Authorization: `Basic ${credentials}`,
          "Content-Type": "application/json",
          ...extraHeaders,
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(10000),
      });
    } catch (err) {
      // The request was already on the wire when it was aborted, so the write
      // may have landed. Surfacing this as SENT_UNCERTAIN is what stops the
      // worker from blindly retrying a side effect that may have occurred.
      if (isAbort(err)) {
        throw new TimeoutError(`Zendesk request timed out: ${method} ${path}`);
      }
      throw err;
    }
  }
}

// ─── Simulator Store (in-memory for local demo) ───────────────────────────────

class ZendeskSimulatorStore {
  private tickets = new Map<string, { status: string; subject: string }>();
  private conversations = new Map<string, TicketConversation>();
  private comments = new Map<string, Array<{ body: string; idempotencyKey: string }>>();

  seed(ticketId: string, status: string, subject: string): void {
    this.tickets.set(ticketId, { status, subject });
    this.comments.set(ticketId, []);
  }

  updateTicketStatus(ticketId: string, targetStatus: string): void {
    const ticket = this.tickets.get(ticketId);
    if (ticket) {
      ticket.status = targetStatus;
    } else {
      this.tickets.set(ticketId, { status: targetStatus, subject: "Simulated ticket" });
    }
  }

  getTicketStatus(ticketId: string): string {
    return this.tickets.get(ticketId)?.status ?? "open";
  }

  postComment(ticketId: string, body: string, idempotencyKey: string): string {
    const existing = this.comments.get(ticketId) ?? [];
    // Dedupe by idempotency key
    const dupe = existing.find((c) => c.idempotencyKey === idempotencyKey);
    if (dupe) {
      return `sim_comment_${idempotencyKey.slice(-8)}`;
    }
    existing.push({ body, idempotencyKey });
    this.comments.set(ticketId, existing);
    return `sim_comment_${idempotencyKey.slice(-8)}`;
  }

  getRecentComments(ticketId: string): string[] {
    return (this.comments.get(ticketId) ?? []).map((c) => c.body);
  }

  /** Seed a thread so the demo and tests have something to extract from. */
  seedConversation(ticketId: string, conversation: TicketConversation): void {
    this.conversations.set(ticketId, conversation);
  }

  getConversation(ticketId: string): TicketConversation | null {
    return this.conversations.get(ticketId) ?? null;
  }

  getTicket(ticketId: string): ZendeskTicket | null {
    const ticket = this.tickets.get(ticketId);
    if (!ticket) return null;
    return {
      id: ticketId,
      status: ticket.status,
      subject: ticket.subject,
      updated_at: new Date().toISOString(),
    };
  }
}

// Singleton simulator — shared across adapter instances in tests/demo
export const simulatorStore = new ZendeskSimulatorStore();
