import { useEffect, useMemo, useState } from "react";
import type { AgentOutputEvent } from "../lib/api";

type RunTimelineProps = {
  events: AgentOutputEvent[];
  loading: boolean;
  error: string | null;
};

export function RunTimeline({ events, loading, error }: RunTimelineProps) {
  const [expanded, setExpanded] = useState<number | null>(null);
  const [fresh, setFresh] = useState<Set<number>>(new Set());
  const latestSeq = useMemo(() => events.at(-1)?.seq ?? null, [events]);

  useEffect(() => {
    if (latestSeq === null) {
      return;
    }
    setFresh((current) => new Set(current).add(latestSeq));
    const timer = window.setTimeout(() => {
      setFresh((current) => {
        const next = new Set(current);
        next.delete(latestSeq);
        return next;
      });
    }, 520);
    return () => window.clearTimeout(timer);
  }, [latestSeq]);

  return (
    <section className="timeline-panel" aria-labelledby="timeline-heading">
      <div className="timeline-heading-row">
        <div>
          <p className="section-kicker">Agent output</p>
          <h2 id="timeline-heading">Run timeline</h2>
        </div>
        <div className="timeline-heading-meta">
          <span className="timeline-count numeric">{events.length} events</span>
          <span className="timeline-mode">JSONL backed</span>
        </div>
      </div>
      {error ? <div className="inline-warning">{error}</div> : null}
      {loading && events.length === 0 ? (
        <div className="timeline-empty timeline-pending">
          <span className="pending-line" />
          <span>Reading the latest agent output…</span>
        </div>
      ) : events.length === 0 ? (
        <div className="timeline-empty">
          <span className="empty-glyph">⌁</span>
          <p>No agent events yet</p>
          <span>Waiting for a session to leave its first trace.</span>
        </div>
      ) : (
        <div className="timeline-list">
          {events.map((event) => (
            <EventRow
              event={event}
              key={`${event.run_id}-${event.seq}`}
              expanded={expanded === event.seq}
              fresh={fresh.has(event.seq)}
              onToggle={() => setExpanded(expanded === event.seq ? null : event.seq)}
            />
          ))}
        </div>
      )}
    </section>
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
      className={`event-row event-row-${toneFor(event.event)}${fresh ? " event-row-fresh" : ""}`}
    >
      <div className="event-rail" aria-hidden="true">
        <span className="event-dot" />
      </div>
      <div className="event-content">
        <div className="event-meta-row">
          <span className="event-label">{eventLabel(event.event)}</span>
          <span className="event-time numeric">{formatTime(event.at)}</span>
          <span className="event-sequence numeric">#{event.seq}</span>
        </div>
        <p className="event-message">{event.message ?? command ?? "Agent event"}</p>
        <div className="event-submeta">
          <span className="event-backend">{backendLabel(event.backend)}</span>
          <span>{event.stream ?? "agent"}</span>
          {event.turn ? <span>turn {event.turn}</span> : null}
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
      </div>
    </article>
  );
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
