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
import {
  initZaf,
  isEmbedded,
  getContext,
  autoResize,
  onTicketSwitch,
  ZafContext,
} from "./zaf";

const DEMO_TICKETS = [
  { id: "10001", label: "Happy path — refund confirmed", emoji: "✅" },
  { id: "10002", label: "Degraded — source unavailable", emoji: "⚠️" },
  { id: "10003", label: "Awaiting operator reconciliation", emoji: "🔄" },
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
  return requested && /^[A-Za-z0-9_-]{1,64}$/.test(requested) ? requested : null;
}

export default function App() {
  const [state, setState] = useState<LoadState>({ status: "loading" });
  const [selectedTicket, setSelectedTicket] = useState(
    () => ticketFromUrl() ?? "10001"
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
    return <Panel><Muted>Loading resolution card…</Muted></Panel>;
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
  return (
    <div style={styles.demoLayout}>
      <div style={styles.demoSidebar}>
        <div style={styles.demoBadge}>DEMO MODE</div>
        <div style={styles.demoNote}>
          Not running inside Zendesk. Installed as a Zendesk app, the ticket and
          agent come from ZAF and the backend token stays server-side. See
          docs/ZENDESK_APP.md.
        </div>

        {DEMO_TICKETS.map((ticket) => {
          const active = selectedTicket === ticket.id;
          return (
            <button
              key={ticket.id}
              onClick={() => onSelect(ticket.id)}
              style={{
                ...styles.demoButton,
                background: active ? "rgba(255,255,255,0.2)" : "transparent",
                borderColor: active ? "rgba(255,255,255,0.5)" : "transparent",
              }}
            >
              <div style={{ fontSize: 18, marginBottom: 4 }}>{ticket.emoji}</div>
              <div>#{ticket.id}</div>
              <div style={{ opacity: 0.8, fontSize: 11, marginTop: 2 }}>
                {ticket.label}
              </div>
            </button>
          );
        })}
      </div>

      <div style={styles.demoPanel}>
        <div style={styles.demoHeader}>
          <div style={styles.demoLogo}>R</div>
          <span style={{ fontSize: 13, fontWeight: 600, color: "#2f3941" }}>
            Resolution Card
          </span>
          <span style={{ fontSize: 11, color: "#68737d", marginLeft: "auto" }}>
            Ticket #{selectedTicket}
          </span>
        </div>

        <ResolutionCard
          zendeskTicketId={selectedTicket}
          agentId="agent-demo-001"
        />
      </div>
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
  embedded: {
    background: "#f8f9fa",
    minHeight: 40,
  },
  muted: {
    padding: 16,
    fontSize: 13,
    color: "#68737d",
  },
  error: {
    padding: 16,
    fontSize: 13,
    color: "#8c2f2f",
    background: "#fdf0f0",
    borderRadius: 4,
    margin: 12,
  },
  demoLayout: {
    display: "flex",
    minHeight: "100vh",
  },
  demoSidebar: {
    width: 280,
    background: "#1f73b7",
    color: "white",
    padding: "20px 16px",
    flexShrink: 0,
  },
  demoBadge: {
    fontSize: 12,
    fontWeight: 700,
    opacity: 0.75,
    letterSpacing: 1,
    marginBottom: 12,
  },
  demoNote: {
    fontSize: 11,
    opacity: 0.7,
    marginBottom: 20,
    lineHeight: 1.5,
  },
  demoButton: {
    display: "block",
    width: "100%",
    border: "1px solid transparent",
    borderRadius: 6,
    color: "white",
    padding: "10px 12px",
    textAlign: "left",
    cursor: "pointer",
    marginBottom: 8,
    fontSize: 13,
    lineHeight: 1.4,
  },
  demoPanel: {
    flex: 1,
    maxWidth: 400,
    background: "#f8f9fa",
  },
  demoHeader: {
    background: "white",
    borderBottom: "1px solid #e0e0e0",
    padding: "10px 16px",
    display: "flex",
    alignItems: "center",
    gap: 8,
  },
  demoLogo: {
    width: 24,
    height: 24,
    borderRadius: 4,
    background: "#1f73b7",
    color: "white",
    fontSize: 12,
    fontWeight: 700,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
  },
};

// isEmbedded is re-exported for components that need to vary copy by mode.
export { isEmbedded };
