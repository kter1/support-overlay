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

import React, { useState, useRef, useEffect } from "react";
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
  /** What the customer is asking for, shown above the message. */
  primaryAsk?: string | null;
}

/**
 * Kinds that point at a record, and so are worth underlining.
 *
 * A request ("refund") points at nothing to look up — hovering it could only
 * repeat the sentence it came from. Underlining it spends the reader's
 * attention for no answer, and five underlines in three sentences is the
 * difference between an annotated paragraph and a struck-through one. Intent
 * goes in the header instead.
 */
const RESOLVABLE_KINDS = new Set([
  "money",
  "date",
  "order_reference",
  "payment_reference",
  "merchant",
]);

export default function AnnotatedThread({
  thread,
  flaggedReferences = [],
  primaryAsk = null,
}: Props) {
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
      {primaryAsk && (
        <div style={styles.intent}>
          <span style={styles.intentLabel}>Asking for</span>
          <span style={styles.intentValue}>{formatAsk(primaryAsk)}</span>
        </div>
      )}

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

  const marks = message.annotations.filter((a) => RESOLVABLE_KINDS.has(a.kind));

  return toSegments(body, marks).map((segment, index) => {
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
        pinned={openSpan === id}
        onTogglePin={() => onToggleSpan(openSpan === id ? null : id)}
      />
    );
  });
}

/** Long enough that crossing a mark on the way elsewhere does not open it. */
const HOVER_DELAY_MS = 120;

function Mark({
  id,
  span,
  text,
  flagged,
  pinned,
  onTogglePin,
}: {
  id: string;
  span: Span;
  text: string;
  flagged: boolean;
  pinned: boolean;
  onTogglePin: () => void;
}) {
  const [hovered, setHovered] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const open = pinned || hovered;
  const fromAgent = span.authorRole !== "customer";
  const palette = kindPalette(span.kind);
  const uncertain = span.confidence < 0.7;

  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  const openSoon = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setHovered(true), HOVER_DELAY_MS);
  };

  const closeNow = () => {
    if (timer.current) clearTimeout(timer.current);
    setHovered(false);
  };

  return (
    <span
      style={styles.markWrap}
      onMouseEnter={openSoon}
      onMouseLeave={closeNow}
    >
      <button
        type="button"
        aria-expanded={open}
        aria-label={`${formatKind(span.kind)}: ${span.display}`}
        onClick={onTogglePin}
        // Keyboard users get the same reveal: hover alone would make every
        // annotation unreachable without a mouse.
        onFocus={() => setHovered(true)}
        onBlur={() => setHovered(false)}
        style={{
          ...styles.mark,
          color: "inherit",
          // An underline rather than a filled chip. The message has to keep
          // reading as the customer's writing; a row of coloured tags does not.
          textDecorationLine: "underline",
          textDecorationColor: palette.color,
          textDecorationThickness: 2,
          textUnderlineOffset: 3,
          // A guess is drawn as a guess.
          textDecorationStyle: uncertain ? "dotted" : "solid",
          // Agent text is record, not claim — dimmer, so a number staff typed
          // never reads as something the customer said.
          opacity: fromAgent ? 0.75 : 1,
          ...(flagged ? styles.markFlagged : {}),
          ...(open ? { background: palette.background } : {}),
        }}
      >
        {text}
      </button>
      {open && <AnnotationPopover span={span} flagged={flagged} id={id} />}
    </span>
  );
}

// ─── Formatting ──────────────────────────────────────────────────────────────

function formatAsk(ask: string): string {
  const labels: Record<string, string> = {
    refund_request: "a refund",
    cancellation_request: "a cancellation",
    return_request: "a return",
    status_check: "a status update",
    reship_request: "a replacement shipment",
    escalation_request: "to speak to a manager",
  };
  return labels[ask] ?? ask.replace(/_/g, " ");
}

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
  intent: {
    display: "flex",
    alignItems: "baseline",
    gap: 6,
    paddingBottom: 4,
  },
  intentLabel: { fontSize: 11, color: "#68737d" },
  intentValue: { fontSize: 13, fontWeight: 600, color: "#2f3941" },
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
    background: "transparent",
    borderRadius: 2,
    padding: 0,
    margin: 0,
    // Identical to the surrounding prose. Only the underline distinguishes it.
    font: "inherit",
    color: "inherit",
    cursor: "help",
    lineHeight: "inherit",
  },
  markFlagged: {
    textDecorationColor: "#cc3340",
    background: "#fff0ee",
  },
};
