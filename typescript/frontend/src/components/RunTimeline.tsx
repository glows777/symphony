import { useEffect, useMemo, useState } from "react";
import type { AgentOutputEvent, AgentOutputMessage } from "../lib/api";

type RunTimelineProps = {
  events: AgentOutputEvent[];
  messages: AgentOutputMessage[];
  loading: boolean;
  error: string | null;
};

export function RunTimeline({ events, messages, loading, error }: RunTimelineProps) {
  const [expanded, setExpanded] = useState<string | null>(null);
  const [fresh, setFresh] = useState<Set<string>>(new Set());
  const messageItems = useMemo(() => sortMessages(messages), [messages]);
  const eventItems = useMemo(() => sortEvents(events), [events]);
  const latestKey = latestItemKey(eventItems, messageItems);
  const streaming = messages.some((message) => activityStatus(message) === "streaming");

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
          <span className="transcript-count numeric">{messages.length} activities</span>
          <span className="transcript-mode">{streaming ? "Streaming" : "Complete"}</span>
        </div>
      </div>
      {error ? <div className="inline-warning">{error}</div> : null}
      {loading && messageItems.length === 0 && eventItems.length === 0 ? (
        <div className="transcript-empty transcript-pending">
          <span className="pending-line" />
          <span>Reading the latest agent output…</span>
        </div>
      ) : messageItems.length === 0 ? (
        <>
          <div className="transcript-empty">
            <span className="empty-glyph">⌁</span>
            <p>No conversation yet</p>
            <span>Raw events are available below.</span>
          </div>
          <RunEventsDetails
            events={eventItems}
            expanded={expanded}
            fresh={fresh}
            onToggle={(key) => setExpanded(expanded === key ? null : key)}
          />
        </>
      ) : (
        <>
          <div className="transcript-list">
            {messageItems.map((message) => (
              <ActivityRow
                message={message}
                key={messageKey(message)}
                fresh={fresh.has(messageKey(message))}
              />
            ))}
          </div>
          <RunEventsDetails
            events={eventItems}
            expanded={expanded}
            fresh={fresh}
            onToggle={(key) => setExpanded(expanded === key ? null : key)}
          />
        </>
      )}
    </section>
  );
}

function RunEventsDetails({
  events,
  expanded,
  fresh,
  onToggle,
}: {
  events: AgentOutputEvent[];
  expanded: string | null;
  fresh: Set<string>;
  onToggle: (key: string) => void;
}) {
  if (events.length === 0) {
    return null;
  }
  return (
    <details className="run-events-details">
      <summary>
        <span>Run events</span>
        <span className="run-events-count numeric">{events.length}</span>
      </summary>
      <div className="run-events-list">
        {events.map((event) => {
          const key = eventKey(event);
          return (
            <EventRow
              event={event}
              key={key}
              expanded={expanded === key}
              fresh={fresh.has(key)}
              onToggle={() => onToggle(key)}
            />
          );
        })}
      </div>
    </details>
  );
}

function ActivityRow({ message, fresh }: { message: AgentOutputMessage; fresh: boolean }) {
  switch (activityType(message)) {
    case "thinking":
      return <ThinkingRow message={message} fresh={fresh} />;
    case "tool_call":
      return <ToolCallRow message={message} fresh={fresh} />;
    default:
      return <ChatMessageRow message={message} fresh={fresh} />;
  }
}

function ChatMessageRow({
  message,
  fresh,
}: {
  message: AgentOutputMessage;
  fresh: boolean;
}) {
  const streaming = activityStatus(message) === "streaming";
  return (
    <article
      className={`chat-message${fresh ? " chat-message-fresh" : ""}`}
      aria-label={`${streaming ? "Streaming" : "Completed"} assistant message`}
    >
      <div className="chat-message-header">
        <span className="chat-message-author">{backendLabel(message.backend)}</span>
        <span className="chat-message-time numeric">{formatTime(message.updated_at)}</span>
        <span className="chat-message-state">{statusLabel(message)}</span>
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

function ThinkingRow({
  message,
  fresh,
}: {
  message: AgentOutputMessage;
  fresh: boolean;
}) {
  const streaming = activityStatus(message) === "streaming";
  return (
    <details
      className={`activity-row thinking-row${fresh ? " activity-row-fresh" : ""}`}
      aria-label={`${statusLabel(message)} reasoning summary`}
    >
      <summary>
        <span className="activity-label">Thinking</span>
        <span className="activity-time numeric">{formatTime(message.updated_at)}</span>
        <span className="activity-status">{statusLabel(message)}</span>
      </summary>
      {message.content !== "" ? (
        <div
          className="activity-body"
          style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}
          aria-live={streaming ? "polite" : undefined}
        >
          {message.content}
          {streaming ? (
            <span className="chat-caret" aria-hidden="true">
              ▋
            </span>
          ) : null}
        </div>
      ) : null}
    </details>
  );
}

function ToolCallRow({
  message,
  fresh,
}: {
  message: AgentOutputMessage;
  fresh: boolean;
}) {
  const name = message.tool_name ?? (message.tool_command ? "Command" : "Tool call");
  const streaming = activityStatus(message) === "streaming";
  return (
    <article
      className={`activity-row tool-row tool-row-${activityStatus(message)}${fresh ? " activity-row-fresh" : ""}`}
      aria-label={`${statusLabel(message)} tool call`}
    >
      <div className="activity-header">
        <span className="activity-label">{name}</span>
        <span className="activity-time numeric">{formatTime(message.updated_at)}</span>
        <span className="activity-status">{statusLabel(message)}</span>
      </div>
      {message.tool_command ? <code className="tool-command">{message.tool_command}</code> : null}
      {message.tool_error ? <p className="tool-error">{message.tool_error}</p> : null}
      {message.tool_output ? (
        <pre className="tool-output" aria-live={streaming ? "polite" : undefined}>
          {message.tool_output}
          {streaming ? "▋" : ""}
        </pre>
      ) : null}
      {message.tool_input !== undefined ? (
        <details className="tool-input-details">
          <summary>Input</summary>
          <pre>{formatPayload(message.tool_input)}</pre>
        </details>
      ) : null}
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

function messageKey(message: AgentOutputMessage): string {
  return `message:${message.run_id}:${message.activity_id ?? message.message_id}`;
}

function eventKey(event: AgentOutputEvent): string {
  return `event:${event.run_id}:${event.seq}`;
}

function latestItemKey(events: AgentOutputEvent[], messages: AgentOutputMessage[]): string | null {
  const latestEvent = events.at(-1);
  const latestMessage = messages.at(-1);
  if (latestEvent === undefined) {
    return latestMessage === undefined ? null : messageKey(latestMessage);
  }
  if (latestMessage === undefined || latestEvent.seq >= latestMessage.seq_end) {
    return eventKey(latestEvent);
  }
  return messageKey(latestMessage);
}

function sortMessages(messages: AgentOutputMessage[]): AgentOutputMessage[] {
  return [...messages].sort((left, right) => left.seq_start - right.seq_start);
}

function sortEvents(events: AgentOutputEvent[]): AgentOutputEvent[] {
  return [...events].sort((left, right) => {
    if (left.run_id === right.run_id) {
      return left.seq - right.seq;
    }
    return left.at.localeCompare(right.at);
  });
}

function activityType(
  message: AgentOutputMessage,
): NonNullable<AgentOutputMessage["activity_type"]> {
  return message.activity_type ?? "assistant_message";
}

function activityStatus(message: AgentOutputMessage): AgentOutputMessage["status"] {
  return message.activity_status ?? message.status;
}

function statusLabel(message: AgentOutputMessage): string {
  const status = activityStatus(message);
  return status === "failed" ? "Failed" : status === "completed" ? "Completed" : "Streaming";
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
