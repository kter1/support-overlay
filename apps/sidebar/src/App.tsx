/**
 * @file apps/sidebar/src/App.tsx
 * @description Root component for the ticket sidebar.
 *
 * Installed in Zendesk this renders one card for the ticket the agent is
 * looking at, sized to fit the panel. Run standalone it shows a scenario picker
 * for the local demo, clearly labelled so a demo is never mistaken for an
 * install.
 */

import React, { useState, useEffect, useRef, useCallback } from "react";
import ResolutionCard from "./components/ResolutionCard";
import Icon from "./components/Icon";
import {
  initZaf,
  isEmbedded,
  getContext,
  autoResize,
  onTicketSwitch,
  ZafContext,
} from "./zaf";

const DEMO_TICKETS = [
  {
    id: "10006",
    label: "Plain email — no order number",
    subject: "Refund request",
    detail: "Match from the customer's words",
  },
  {
    id: "10001",
    label: "Happy path — refund confirmed",
    subject: "Refund confirmed",
    detail: "Matched order and payment",
  },
  {
    id: "10002",
    label: "Degraded — source unavailable",
    subject: "Order record unavailable",
    detail: "Preserved evidence",
  },
  {
    id: "10003",
    label: "Awaiting operator reconciliation",
    subject: "Cancel order #3003",
    detail: "Operator reconciliation scenario",
  },
  {
    id: "10005",
    label: "Already refunded — duplicate risk",
    subject: "Still waiting on my refund",
    detail: "Prior refund on another ticket",
  },
];

type LoadState =
  | { status: "loading" }
  | { status: "embedded"; context: ZafContext }
  | { status: "standalone" }
  | { status: "error"; message: string };

/**
 * Standalone only: `?ticket=12345` opens a specific ticket instead of one of
 * the canned scenarios, so a real ingested ticket can be inspected without
 * being added to the picker. Ignored when embedded — there, the ticket always
 * comes from ZAF, and letting a URL override it would show an agent a card for
 * a ticket they are not looking at.
 */
function ticketFromUrl(): string | null {
  if (typeof window === "undefined") return null;
  const requested = new URLSearchParams(window.location.search).get("ticket");
  return requested && /^[A-Za-z0-9_-]{1,64}$/.test(requested)
    ? requested
    : null;
}

export default function App() {
  const [state, setState] = useState<LoadState>({ status: "loading" });
  const [selectedTicket, setSelectedTicket] = useState(
    () => ticketFromUrl() ?? "10006",
  );

  useEffect(() => {
    let cancelled = false;

    async function load(): Promise<void> {
      if (!initZaf()) {
        if (!cancelled) setState({ status: "standalone" });
        return;
      }

      try {
        const context = await getContext();
        if (cancelled) return;

        if (!context) {
          setState({
            status: "error",
            message: "This app could not read the current ticket.",
          });
          return;
        }

        setState({ status: "embedded", context });
      } catch {
        if (!cancelled) {
          setState({
            status: "error",
            message: "This app could not connect to Zendesk.",
          });
        }
      }
    }

    void load();
    // Switching tickets keeps the app mounted, so re-read context on activation.
    onTicketSwitch(() => void load());

    return () => {
      cancelled = true;
    };
  }, []);

  if (state.status === "loading") {
    return (
      <Panel>
        <Muted>Loading resolution card…</Muted>
      </Panel>
    );
  }

  if (state.status === "error") {
    return (
      <Panel>
        <div style={styles.error}>{state.message}</div>
      </Panel>
    );
  }

  if (state.status === "embedded") {
    return (
      <EmbeddedCard
        ticketId={state.context.ticketId}
        agentId={state.context.agentId}
      />
    );
  }

  return (
    <StandaloneDemo
      selectedTicket={selectedTicket}
      onSelect={setSelectedTicket}
    />
  );
}

/**
 * The installed experience: just the card, resized to whatever it needs.
 * Zendesk gives the iframe a fixed default height, so content is clipped
 * without an explicit resize.
 */
function EmbeddedCard({
  ticketId,
  agentId,
}: {
  ticketId: string;
  agentId: string;
}) {
  const containerRef = useRef<HTMLDivElement>(null);

  const syncHeight = useCallback(() => {
    const height = containerRef.current?.scrollHeight;
    if (height) void autoResize(height + 8);
  }, []);

  useEffect(() => {
    syncHeight();
    if (!containerRef.current || typeof ResizeObserver === "undefined") return;

    const observer = new ResizeObserver(syncHeight);
    observer.observe(containerRef.current);
    return () => observer.disconnect();
  }, [syncHeight]);

  return (
    <div ref={containerRef} style={styles.embedded}>
      <ResolutionCard
        zendeskTicketId={ticketId}
        agentId={agentId}
        onLayoutChange={syncHeight}
      />
    </div>
  );
}

function StandaloneDemo({
  selectedTicket,
  onSelect,
}: {
  selectedTicket: string;
  onSelect: (id: string) => void;
}) {
  const ticket = DEMO_TICKETS.find((t) => t.id === selectedTicket);
  return (
    <div className="workspace">
      <header className="workspace-topbar">
        <div className="brand">
          <span className="brand-mark">
            <Icon name="link" size={20} />
          </span>
          Support Overlay
        </div>
        <span className="topbar-context">Support workspace</span>
        <span className="fixture-label">
          <span />
          Fixture data · Local demo
        </span>
      </header>
      <aside className="ticket-rail" aria-label="Demo tickets">
        <div className="rail-title">
          <Icon /> Inbox <span>{DEMO_TICKETS.length}</span>
        </div>
        <p className="rail-subtitle">Refunds &amp; order support</p>
        <nav className="ticket-list" aria-label="Tickets">
          {DEMO_TICKETS.map((t) => (
            <button
              key={t.id}
              aria-label={`Ticket ${t.id}: ${t.label}`}
              aria-current={selectedTicket === t.id ? "page" : undefined}
              className={`ticket-item ${selectedTicket === t.id ? "is-selected" : ""}`}
              onClick={() => onSelect(t.id)}
            >
              <span className="ticket-number">
                #{t.id}
                <Icon name="arrow" size={14} />
              </span>
              <strong>{t.subject}</strong>
              <span className="ticket-description">{t.detail}</span>
            </button>
          ))}
        </nav>
        <div className="rail-footnote">
          <Icon name="shield" size={16} />
          <p>
            Recorded scenarios.
            <br />
            No live provider connections.
          </p>
        </div>
      </aside>
      <main className="workspace-main">
        <div className="mobile-ticket-picker">
          <label htmlFor="ticket-picker">Demo ticket</label>
          <select
            id="ticket-picker"
            value={selectedTicket}
            onChange={(e) => onSelect(e.target.value)}
          >
            {!ticket && (
              <option value={selectedTicket}>Ticket #{selectedTicket}</option>
            )}
            {DEMO_TICKETS.map((t) => (
              <option key={t.id} value={t.id}>
                #{t.id} — {t.subject}
              </option>
            ))}
          </select>
        </div>
        <div className="workspace-heading">
          <div>
            <div className="eyebrow">
              Inbox <span>/</span> Ticket #{selectedTicket}
            </div>
            <h1>{ticket?.subject ?? `Ticket #${selectedTicket}`}</h1>
          </div>
          <span className="workspace-heading-note">
            <Icon name="link" size={15} /> Conversation &amp; evidence
          </span>
        </div>
        <ResolutionCard
          zendeskTicketId={selectedTicket}
          agentId="agent-demo-001"
          layout="workspace"
        />
      </main>
    </div>
  );
}

function Panel({ children }: { children: React.ReactNode }) {
  return <div style={styles.embedded}>{children}</div>;
}

function Muted({ children }: { children: React.ReactNode }) {
  return <div style={styles.muted}>{children}</div>;
}

const styles: Record<string, React.CSSProperties> = {
  embedded: { background: "var(--canvas)", minHeight: 40 },
  muted: { padding: 16, fontSize: 13, color: "var(--muted)" },
  error: {
    padding: 16,
    color: "var(--danger)",
    background: "var(--danger-soft)",
    borderRadius: 8,
    margin: 12,
  },
};

export { isEmbedded };
