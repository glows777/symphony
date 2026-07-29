import { useEffect, useMemo, useState } from "react";
import type { AgentOutputEvent } from "../lib/api";

export type AgentOutputMessage = {
  message_id: string;
  issue_identifier: string;
  backend: string;
  run_id: string;
  session_id?: string;
  turn?: number;
  role: "assistant";
  content: string;
  status: "streaming" | "completed";
  seq_start: number;
  seq_end: number;
  at: string;
  updated_at: string;
};

type RunTimelineProps = {
  events: AgentOutputEvent[];
  messages: AgentOutputMessage[];
  loading: boolean;
  error: string | null;
};

type TranscriptItem =
  | { kind: "event"; key: string; seq: number; event: AgentOutputEvent }
  | { kind: "message"; key: string; seq: number; message: AgentOutputMessage };

export function RunTimeline({ events, messages, loading, error }: RunTimelineProps) {
  const [expanded, setExpanded] = useState<string | null>(null);
  const [fresh, setFresh] = useState<Set<string>>(new Set());
  const transcriptItems = useMemo(() => buildTranscriptItems(events, messages), [events, messages]);
  const messageItems = transcriptItems.filter((item) => item.kind === "message");
  const eventItems = transcriptItems.filter((item) => item.kind === "event");
  const latestKey = transcriptItems.at(-1)?.key ?? null;
  const streaming = messages.some((message) => message.status === "streaming");

  useEffect(() => {
    if (latestKey === null) {
      return;
    }
    setFresh((current) => new Set(current).add(latestKey));
    const timer = window.setTimeout(() => {
      setFresh((current) => {
        const next = new Set(current);
        next.delete(latestKey);
        return next;
      });
    }, 520);
    return () => window.clearTimeout(timer);
  }, [latestKey]);

  return (
    <section className="transcript-panel" aria-labelledby="transcript-heading">
      <div className="transcript-heading-row">
        <div>
          <p className="section-kicker">Agent output</p>
          <h2 id="transcript-heading">Conversation</h2>
        </div>
        <div className="transcript-heading-meta">
          <span className="transcript-count numeric">{messages.length} messages</span>
          <span className="transcript-mode">{streaming ? "Streaming" : "Complete"}</span>
        </div>
      </div>
      {error ? <div className="inline-warning">{error}</div> : null}
      {loading && transcriptItems.length === 0 ? (
        <div className="transcript-empty transcript-pending">
          <span className="pending-line" />
          <span>Reading the latest agent output…</span>
        </div>
      ) : transcriptItems.length === 0 ? (
        <div className="transcript-empty">
          <span className="empty-glyph">⌁</span>
          <p>No messages yet</p>
          <span>Waiting for a session to leave its first response.</span>
        </div>
      ) : (
        <>
          <div className="transcript-list">
            {messageItems.map((item) => (
              <ChatMessageRow message={item.message} key={item.key} fresh={fresh.has(item.key)} />
            ))}
          </div>
          {eventItems.length > 0 ? (
            <details className="run-events-details">
              <summary>
                <span>Run events</span>
                <span className="run-events-count numeric">{eventItems.length}</span>
              </summary>
              <div className="run-events-list">
                {eventItems.map((item) => (
                  <EventRow
                    event={item.event}
                    key={item.key}
                    expanded={expanded === item.key}
                    fresh={fresh.has(item.key)}
                    onToggle={() => setExpanded(expanded === item.key ? null : item.key)}
                  />
                ))}
              </div>
            </details>
          ) : null}
        </>
      )}
    </section>
  );
}

function ChatMessageRow({
  message,
  fresh,
}: {
  message: AgentOutputMessage;
  fresh: boolean;
}) {
  const streaming = message.status === "streaming";
  return (
    <article
      className={`chat-message${fresh ? " chat-message-fresh" : ""}`}
      aria-label={`${streaming ? "Streaming" : "Completed"} assistant message`}
    >
      <div className="chat-message-header">
        <span className="chat-message-author">{backendLabel(message.backend)}</span>
        <span className="chat-message-time numeric">{formatTime(message.updated_at)}</span>
        {streaming ? <span className="chat-message-state">Streaming</span> : null}
      </div>
      <div
        className="chat-message-body"
        style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}
        aria-live={streaming ? "polite" : undefined}
      >
        {message.content || "\u00a0"}
        {streaming ? (
          <span className="chat-caret" aria-hidden="true">
            ▋
          </span>
        ) : null}
      </div>
    </article>
  );
}

function EventRow({
  event,
  expanded,
  fresh,
  onToggle,
}: {
  event: AgentOutputEvent;
  expanded: boolean;
  fresh: boolean;
  onToggle: () => void;
}) {
  const hasPayload = event.payload !== undefined || event.raw !== undefined;
  const command = commandFromPayload(event.payload);

  return (
    <article
      className={`run-event-row run-event-row-${toneFor(event.event)}${fresh ? " run-event-row-fresh" : ""}`}
    >
      <div className="run-event-header">
        <span className="run-event-label">{eventLabel(event.event)}</span>
        <span className="run-event-time numeric">{formatTime(event.at)}</span>
        <span className="run-event-sequence numeric">#{event.seq}</span>
      </div>
      <p className="run-event-message">{event.message ?? command ?? "Agent event"}</p>
      <div className="run-event-meta">
        <span>{backendLabel(event.backend)}</span>
        <span>{event.stream ?? "agent"}</span>
        {event.turn !== undefined ? <span>turn {event.turn}</span> : null}
        {event.session_id ? (
          <span className="event-session mono">{compactId(event.session_id)}</span>
        ) : null}
      </div>
      {hasPayload ? (
        <details
          className="payload-details"
          open={expanded}
          onToggle={(e) => {
            if (e.currentTarget.open !== expanded) {
              onToggle();
            }
          }}
        >
          <summary>Raw payload</summary>
          <pre>{formatPayload(event.payload ?? event.raw)}</pre>
        </details>
      ) : null}
    </article>
  );
}

function buildTranscriptItems(
  events: AgentOutputEvent[],
  messages: AgentOutputMessage[],
): TranscriptItem[] {
  const items: TranscriptItem[] = messages.map((message) => ({
    kind: "message",
    key: messageKey(message),
    seq: message.seq_start,
    message,
  }));
  const legacyMessages = messages.filter((message) => message.message_id.startsWith("legacy:"));

  for (const event of events) {
    if (
      event.chat_phase !== undefined ||
      typeof event.chat_id === "string" ||
      legacyMessages.some(
        (message) => event.seq >= message.seq_start && event.seq <= message.seq_end,
      )
    ) {
      continue;
    }
    items.push({
      kind: "event",
      key: eventKey(event),
      seq: event.seq,
      event,
    });
  }

  return items.sort((left, right) => {
    if (left.seq !== right.seq) {
      return left.seq - right.seq;
    }
    return left.kind === "message" ? -1 : 1;
  });
}

function messageKey(message: AgentOutputMessage): string {
  return `message:${message.run_id}:${message.message_id}`;
}

function eventKey(event: AgentOutputEvent): string {
  return `event:${event.run_id}:${event.seq}`;
}

function eventLabel(event: string): string {
  return event.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function toneFor(event: string): string {
  if (
    event.includes("fail") ||
    event.includes("timeout") ||
    event === "port_exit" ||
    event.includes("blocked")
  ) {
    return "danger";
  }
  if (event.includes("approval") || event.includes("required") || event === "log_truncated") {
    return "attention";
  }
  if (event.includes("completed") || event.includes("started")) {
    return "success";
  }
  return "neutral";
}

function backendLabel(backend: string): string {
  return backend === "claude_code" ? "Claude Code" : backend === "codex" ? "Codex" : backend;
}

function formatTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function compactId(value: string): string {
  return value.length > 26 ? `${value.slice(0, 11)}…${value.slice(-8)}` : value;
}

function commandFromPayload(payload: unknown): string | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return null;
  }
  const record = payload as Record<string, unknown>;
  for (const key of ["command", "cmd", "tool", "name", "method"]) {
    if (typeof record[key] === "string" && record[key] !== "") {
      return record[key] as string;
    }
  }
  return null;
}

function formatPayload(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}
