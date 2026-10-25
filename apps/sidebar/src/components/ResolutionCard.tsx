/** One polling controller, two presentations. Keyed by ticket to isolate action state. */
import React, { useState, useEffect, useCallback, useRef } from "react";
import EvidencePanel from "./EvidencePanel";
import ActionPanel from "./ActionPanel";
import StatusBadge from "./StatusBadge";
import DegradedBanner from "./DegradedBanner";
import AnnotatedThread from "./AnnotatedThread";
import HistoryPanel, { HistoryNotices } from "./HistoryPanel";
import Icon from "./Icon";
import { useCardData, type CardData } from "../hooks/useCardData";

interface ResolutionCardProps {
  zendeskTicketId: string;
  agentId: string;
  onLayoutChange?: () => void;
  layout?: "compact" | "workspace";
}

export default function ResolutionCard(props: ResolutionCardProps) {
  return <CardController key={props.zendeskTicketId} {...props} />;
}

function CardController({
  zendeskTicketId,
  agentId,
  onLayoutChange,
  layout = "compact",
}: ResolutionCardProps) {
  const { card, loading, error, refetch } = useCardData(zendeskTicketId);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [lastActionResult, setLastActionResult] = useState<string | null>(null);
  const refreshTimer = useRef<ReturnType<typeof setTimeout>>();
  useEffect(() => {
    onLayoutChange?.();
  }, [card, loading, error, detailsOpen, lastActionResult, onLayoutChange]);
  useEffect(() => {
    const interval = setInterval(refetch, 3000);
    return () => {
      clearInterval(interval);
      clearTimeout(refreshTimer.current);
    };
  }, [refetch]);
  const handleActionComplete = useCallback(
    (message: string) => {
      setLastActionResult(message);
      refreshTimer.current = setTimeout(refetch, 500);
    },
    [refetch],
  );

  if (error)
    return (
      <div className="card-state" role="alert">
        <Icon name="alert" size={26} />
        <h2>Unable to load this ticket</h2>
        <p>{error}</p>
        <button className="button-primary" onClick={refetch}>
          Retry
        </button>
      </div>
    );
  if (loading && !card)
    return (
      <div className="card-state" role="status">
        <span className="spinner" />
        <h2>Loading conversation &amp; evidence</h2>
        <p>Retrieving the ticket’s resolution record.</p>
      </div>
    );
  if (!card) return null;

  const flaggedReferences = card.customerHistory.priorInteractions
    .filter((i) => i.sameSubject && i.refundStatus === "succeeded")
    .flatMap((i) => (i.orderReference ? [i.orderReference] : []));
  const conversation = (
    <AnnotatedThread
      thread={card.context?.thread ?? []}
      flaggedReferences={flaggedReferences}
      primaryAsk={card.context?.primaryAsk}
    />
  );
  const warnings = (
    <>
      {(card.isSourceUnavailable || card.freshnessStatus === "STALE") && (
        <DegradedBanner
          isSourceUnavailable={card.isSourceUnavailable}
          sourceUnavailableReason={card.sourceUnavailableReason}
          freshnessStatus={card.freshnessStatus}
          evidenceFetchedAt={card.evidenceFetchedAt}
        />
      )}
      {card.freshnessStatus === "MISSING" && (
        <div className="notice notice-warning">
          <Icon name="alert" />
          <span>No evidence has been fetched for this ticket.</span>
        </div>
      )}
      {card.softWarnings.length > 0 && (
        <div className="soft-warnings">
          {card.softWarnings.map((warning, i) => (
            <p key={i}>{warning}</p>
          ))}
        </div>
      )}
    </>
  );
  const evidence = <EvidenceRecords card={card} />;
  const actions = (
    <>
      <HistoryNotices history={card.customerHistory} />
      <div className="section-label action-heading">Available actions</div>
      <ActionPanel
        card={card}
        agentId={agentId}
        onActionComplete={handleActionComplete}
        onRefetch={refetch}
      />
      {lastActionResult && (
        <div className="notice notice-success" role="status">
          <Icon name="check" />
          <span>{lastActionResult}</span>
        </div>
      )}
      {card.pendingApprovalRequestId && (
        <div className="notice">
          <Icon name="clock" />
          <div>
            <strong>Awaiting manager approval</strong>
            <p>Ref: {card.pendingApprovalRequestId.slice(0, 8)}</p>
          </div>
        </div>
      )}
      {card.pendingActionExecutionId && !card.pendingApprovalRequestId && (
        <div className="notice">
          <Icon name="clock" />
          <div>
            <strong>
              {card.issueState === "ACTION_IN_PROGRESS"
                ? "Action in progress — check back shortly"
                : "Processing"}
            </strong>
            {card.lastActionType && (
              <p>
                {card.lastActionType.replace(/_/g, " ")} · Ref:{" "}
                {card.pendingActionExecutionId.slice(0, 8)}
              </p>
            )}
          </div>
        </div>
      )}
      <HistoryPanel history={card.customerHistory} />
    </>
  );
  const footer = (
    <footer className="card-footer">
      <span>
        Updated{" "}
        {card.lastRebuiltAt
          ? new Date(card.lastRebuiltAt).toLocaleTimeString([], {
              hour: "2-digit",
              minute: "2-digit",
            })
          : "—"}
      </span>
      <button onClick={refetch}>Refresh</button>
    </footer>
  );
  const summary = (
    <div className="match-summary">
      <div className="section-label">Resolution overview</div>
      <div className="match-summary-row">
        <h2>{formatIssueState(card.issueState)}</h2>
        {card.matchBand ? (
          <StatusBadge
            matchBand={card.matchBand}
            confidence={card.confidenceScore}
          />
        ) : (
          <span className="neutral-badge">Not yet matched</span>
        )}
      </div>
      <p>Review the evidence before choosing an action.</p>
    </div>
  );

  if (layout === "workspace")
    return (
      <div className="case-workspace" data-layout="workspace">
        <section
          className="conversation-panel"
          aria-label="Customer conversation"
        >
          <header className="panel-heading">
            <span className="panel-icon">
              <Icon name="inbox" />
            </span>
            <div>
              <h2>Conversation</h2>
              <p>Customer messages, with records in context</p>
            </div>
            <span className="count-badge">
              {card.context?.messageCount ?? 0}
            </span>
          </header>
          {conversation}
          <div className="conversation-hint">
            <Icon name="link" size={16} />
            <span>
              Underlined details connect to merchant records. Hover or focus to
              inspect.
            </span>
          </div>
        </section>
        <aside className="resolution-panel" aria-label="Resolution panel">
          {summary}
          {evidence}
          {warnings}
          {actions}
          {footer}
        </aside>
      </div>
    );
  return (
    <div className="compact-card" data-layout="compact">
      {conversation}
      {summary}
      {warnings}
      {actions}
      <button
        className="disclosure"
        aria-expanded={detailsOpen}
        onClick={() => setDetailsOpen(!detailsOpen)}
      >
        Transaction &amp; evidence <span>{detailsOpen ? "−" : "+"}</span>
      </button>
      {detailsOpen && evidence}
      {footer}
    </div>
  );
}

function EvidenceRecords({ card }: { card: CardData }) {
  // Candidate records are already part of the annotated conversation response.
  // Keep every distinct provider record, including ambiguous matches.
  const candidates = [
    ...new Map(
      (card.context?.thread ?? [])
        .flatMap((message) =>
          message.annotations.flatMap((span) => span.candidates),
        )
        .map((record) => [
          `${record.provider}:${record.recordType}:${record.reference}`,
          record,
        ]),
    ).values(),
  ];
  return (
    <section className="evidence-section" aria-label="Merchant evidence">
      <div className="section-heading">
        <h3>Merchant evidence</h3>
        <span>{candidates.length ? `${candidates.length} records` : ""}</span>
      </div>
      {candidates.map((record) => (
        <div
          className="merchant-record"
          key={`${record.provider}:${record.recordType}:${record.reference}`}
        >
          <div className="record-topline">
            <span
              className={`provider-badge provider-${record.provider.toLowerCase()}`}
            >
              {record.provider}
            </span>
            {record.status && (
              <span className="record-status">
                {record.status.replace(/_/g, " ")}
              </span>
            )}
          </div>
          <div className="record-value">
            <strong>{record.reference}</strong>
            {record.amountCents !== null && (
              <strong>
                {formatAmount(record.amountCents, record.currency)}
              </strong>
            )}
          </div>
          {record.description && <p>{record.description}</p>}
          {record.occurredAt && (
            <time>
              {new Date(record.occurredAt).toLocaleDateString(undefined, {
                month: "short",
                day: "numeric",
                year: "numeric",
              })}
            </time>
          )}
        </div>
      ))}
      {!candidates.length && card.evidenceSummary && (
        <EvidencePanel
          evidenceSummary={card.evidenceSummary}
          matchBand={card.matchBand}
          confidenceScore={card.confidenceScore}
          isSourceUnavailable={card.isSourceUnavailable}
        />
      )}
      {!candidates.length && !card.evidenceSummary && (
        <p className="empty-evidence">No merchant records are available yet.</p>
      )}
    </section>
  );
}

function formatIssueState(state: string) {
  return state
    .toLowerCase()
    .replace(/_/g, " ")
    .replace(/^./, (c) => c.toUpperCase());
}
function formatAmount(amount: number, currency: string | null) {
  try {
    const formatter = new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: (currency ?? "USD").toUpperCase(),
    });
    return formatter.format(
      amount / 10 ** (formatter.resolvedOptions().maximumFractionDigits ?? 2),
    );
  } catch {
    return `${amount} ${currency ?? "minor units"}`;
  }
}
