/**
 * @file apps/sidebar/src/components/AnnotatedThread.tsx
 * @description The customer's conversation, with what the system found marked
 * in place.
 *
 * This is the product: the agent reads the message they were going to read
 * anyway, and the amounts, order numbers, dates and requests inside it are
 * marked, each backed by what it resolved to. The alternative — a list of
 * extracted fragments beside the message — makes the agent do the join between
 * "$49.99" and the sentence it came from, which is the work this is supposed
 * to remove.
 *
 * Two things are load-bearing.
 *
 * Message text is rendered as React text nodes, never as HTML. It is untrusted
 * customer input, and `dangerouslySetInnerHTML` here would be a stored XSS on
 * a page that carries an agent's session.
 *
 * Marks never alter the text. Segments are slices of the original body and
 * reassemble to it exactly — an overlay that silently rewrote what a customer
 * said would be worse than no overlay.
 */

import React, { useState } from "react";
import { toSegments, Span } from "../lib/spans";
import AnnotationPopover from "./AnnotationPopover";

export interface ThreadMessage {
  sourceId: string;
  kind: string;
  authorRole: string;
  body: string | null;
  redacted: boolean;
  redactionReason: string | null;
  createdAt: string;
  annotations: Span[];
}

/** Messages beyond this collapse; a Zendesk sidebar is not a mail client. */
const VISIBLE_WITHOUT_EXPANDING = 4;

interface Props {
  thread: ThreadMessage[];
  /** Identifiers the history layer flagged, so a span can carry the warning. */
  flaggedReferences?: string[];
}

export default function AnnotatedThread({ thread, flaggedReferences = [] }: Props) {
  const [expanded, setExpanded] = useState(false);
  const [openSpan, setOpenSpan] = useState<string | null>(null);

  if (thread.length === 0) {
    return (
      <div style={styles.empty}>
        The ticket thread could not be read, so there is nothing to annotate.
      </div>
    );
  }

  // When collapsing, keep the messages that carry annotations plus the latest.
  // Hiding the annotated ones would hide the entire point of the panel.
  const overflowing = thread.length > VISIBLE_WITHOUT_EXPANDING;
  const shown =
    expanded || !overflowing
      ? thread
      : thread.filter(
          (m, i) => m.annotations.length > 0 || i >= thread.length - 1
        );

  const hidden = thread.length - shown.length;

  return (
    <div style={styles.thread}>
      {hidden > 0 && (
        <button style={styles.expand} onClick={() => setExpanded(true)}>
          Show {hidden} more message{hidden === 1 ? "" : "s"}
        </button>
      )}

      {shown.map((message) => (
        <Message
          key={message.sourceId}
          message={message}
          flaggedReferences={flaggedReferences}
          openSpan={openSpan}
          onToggleSpan={setOpenSpan}
        />
      ))}
    </div>
  );
}

function Message({
  message,
  flaggedReferences,
  openSpan,
  onToggleSpan,
}: {
  message: ThreadMessage;
  flaggedReferences: string[];
  openSpan: string | null;
  onToggleSpan: (id: string | null) => void;
}) {
  const isCustomer = message.authorRole === "customer";

  return (
    <div style={styles.message}>
      <div style={styles.messageHead}>
        <span style={isCustomer ? styles.authorCustomer : styles.authorAgent}>
          {isCustomer ? "Customer" : "Agent"}
        </span>
        {message.kind === "ticket_subject" && (
          <span style={styles.kindTag}>subject</span>
        )}
        <span style={styles.timestamp}>{formatTime(message.createdAt)}</span>
      </div>

      <div style={isCustomer ? styles.bodyCustomer : styles.bodyAgent}>
        {message.redacted ? (
          <span style={styles.redacted}>
            {message.redactionReason ?? "This message has been removed."}
          </span>
        ) : (
          renderBody(message, flaggedReferences, openSpan, onToggleSpan)
        )}
      </div>
    </div>
  );
}

function renderBody(
  message: ThreadMessage,
  flaggedReferences: string[],
  openSpan: string | null,
  onToggleSpan: (id: string | null) => void
): React.ReactNode {
  const body = message.body ?? "";

  return toSegments(body, message.annotations).map((segment, index) => {
    if (!segment.marked) {
      // A plain string child — React escapes it. Never innerHTML.
      return <React.Fragment key={index}>{segment.text}</React.Fragment>;
    }

    const id = `${message.sourceId}:${segment.span.start}`;
    // Match on what the customer wrote. Requiring a resolved record would
    // silence the warning in exactly the case it matters most: a re-contact
    // whose own evidence lookup found nothing.
    const flagged =
      segment.span.reference !== null &&
      flaggedReferences.includes(segment.span.reference.replace(/^#/, ""));

    return (
      <Mark
        key={index}
        id={id}
        span={segment.span}
        text={segment.text}
        flagged={flagged}
        open={openSpan === id}
        onToggle={() => onToggleSpan(openSpan === id ? null : id)}
      />
    );
  });
}

function Mark({
  id,
  span,
  text,
  flagged,
  open,
  onToggle,
}: {
  id: string;
  span: Span;
  text: string;
  flagged: boolean;
  open: boolean;
  onToggle: () => void;
}) {
  const fromAgent = span.authorRole !== "customer";
  const palette = kindPalette(span.kind);

  return (
    <span style={styles.markWrap}>
      <button
        type="button"
        aria-expanded={open}
        aria-label={`${formatKind(span.kind)}: ${span.display}`}
        onClick={onToggle}
        style={{
          ...styles.mark,
          // Agent text is record, not claim. Outlined rather than filled, so a
          // number staff typed never reads as something the customer said.
          ...(fromAgent
            ? { background: "transparent", boxShadow: `inset 0 0 0 1px ${palette.color}` }
            : { background: palette.background }),
          color: palette.color,
          ...(flagged ? styles.markFlagged : {}),
        }}
      >
        {text}
      </button>
      {open && <AnnotationPopover span={span} flagged={flagged} id={id} />}
    </span>
  );
}

// ─── Formatting ──────────────────────────────────────────────────────────────

export function formatKind(kind: string): string {
  const labels: Record<string, string> = {
    money: "Amount",
    date: "Date",
    order_reference: "Order",
    payment_reference: "Payment",
    ask: "Request",
  };
  return labels[kind] ?? kind.replace(/_/g, " ");
}

export function kindPalette(kind: string): { background: string; color: string } {
  const palette: Record<string, { background: string; color: string }> = {
    payment_reference: { background: "#dbeafe", color: "#1e40af" },
    order_reference: { background: "#dbeafe", color: "#1e40af" },
    money: { background: "#dcfce7", color: "#166534" },
    date: { background: "#ede9fe", color: "#5b21b6" },
    ask: { background: "#ffedd5", color: "#9a3412" },
  };
  return palette[kind] ?? { background: "#f1f5f9", color: "#475569" };
}

function formatTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

// ─── Styles ──────────────────────────────────────────────────────────────────

const styles: Record<string, React.CSSProperties> = {
  thread: {
    padding: "12px 16px",
    display: "flex",
    flexDirection: "column",
    gap: 12,
  },
  empty: {
    padding: "16px",
    fontSize: 12,
    color: "#68737d",
    lineHeight: 1.5,
  },
  expand: {
    background: "none",
    border: "none",
    color: "#1f73b7",
    fontSize: 11,
    cursor: "pointer",
    padding: 0,
    textAlign: "left",
  },
  message: {
    display: "flex",
    flexDirection: "column",
    gap: 4,
  },
  messageHead: {
    display: "flex",
    alignItems: "baseline",
    gap: 6,
  },
  authorCustomer: {
    fontSize: 10,
    fontWeight: 700,
    textTransform: "uppercase",
    letterSpacing: 0.5,
    color: "#2f3941",
  },
  authorAgent: {
    fontSize: 10,
    fontWeight: 700,
    textTransform: "uppercase",
    letterSpacing: 0.5,
    color: "#9ca3af",
  },
  kindTag: {
    fontSize: 9,
    color: "#9ca3af",
    textTransform: "uppercase",
    letterSpacing: 0.4,
  },
  timestamp: {
    fontSize: 10,
    color: "#c2c8cc",
    marginLeft: "auto",
  },
  bodyCustomer: {
    fontSize: 13,
    lineHeight: 1.6,
    color: "#2f3941",
    whiteSpace: "pre-wrap",
    wordBreak: "break-word",
  },
  bodyAgent: {
    fontSize: 13,
    lineHeight: 1.6,
    color: "#68737d",
    whiteSpace: "pre-wrap",
    wordBreak: "break-word",
    borderLeft: "2px solid #e9ebed",
    paddingLeft: 10,
  },
  redacted: {
    fontStyle: "italic",
    color: "#9ca3af",
    fontSize: 12,
  },
  markWrap: {
    position: "relative",
    display: "inline",
  },
  mark: {
    border: "none",
    borderRadius: 3,
    padding: "1px 3px",
    margin: 0,
    font: "inherit",
    fontWeight: 600,
    cursor: "pointer",
    lineHeight: "inherit",
  },
  markFlagged: {
    boxShadow: "inset 0 0 0 1.5px #cc3340",
  },
};
