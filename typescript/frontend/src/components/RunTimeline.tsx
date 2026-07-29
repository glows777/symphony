import { useEffect, useMemo, useRef, useState } from "react";
import type { AgentOutputEvent, AgentOutputMessage } from "../lib/api";

type RunTimelineProps = {
  events: AgentOutputEvent[];
  messages: AgentOutputMessage[];
  loading: boolean;
  error: string | null;
  hasLater: boolean;
  loadingLater: boolean;
  onLoadLater: () => void;
};

export function RunTimeline({
  events,
  messages,
  loading,
  error,
  hasLater,
  loadingLater,
  onLoadLater,
}: RunTimelineProps) {
  const [fresh, setFresh] = useState<Set<string>>(new Set());
  const laterSentinelRef = useRef<HTMLDivElement | null>(null);
  const messageItems = useMemo(() => sortMessages(messages), [messages]);
  const visibleMessageItems = useMemo(() => messageItems.filter(isVisibleActivity), [messageItems]);
  const eventItems = useMemo(() => sortEvents(events), [events]);
  const latestKey = latestItemKey(eventItems, visibleMessageItems);
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

  useEffect(() => {
    const sentinel = laterSentinelRef.current;
    if (
      sentinel === null ||
      !hasLater ||
      loadingLater ||
      typeof IntersectionObserver === "undefined"
    ) {
      return;
    }
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (!entry?.isIntersecting) {
          return;
        }
        onLoadLater();
      },
      { rootMargin: "0px 0px 160px 0px" },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [hasLater, loadingLater, onLoadLater]);

  return (
    <section className="transcript-panel" aria-labelledby="transcript-heading">
      <div className="transcript-heading-row">
        <div>
          <p className="section-kicker">Agent output</p>
          <h2 id="transcript-heading">Conversation</h2>
        </div>
        <div className="transcript-heading-meta">
          <span className="transcript-count numeric">{visibleMessageItems.length} activities</span>
          <span className="transcript-mode">{streaming ? "Streaming" : "Complete"}</span>
        </div>
      </div>
      {error ? <div className="inline-warning">{error}</div> : null}
      {loading && visibleMessageItems.length === 0 ? (
        <div className="transcript-empty transcript-pending">
          <span className="pending-line" />
          <span>Reading the latest agent output…</span>
        </div>
      ) : visibleMessageItems.length === 0 ? (
        <div className="transcript-empty">
          <span className="empty-glyph">⌁</span>
          <p>No conversation yet</p>
        </div>
      ) : (
        <div className="transcript-list">
          {visibleMessageItems.map((message) => (
            <ActivityRow
              events={eventItems}
              message={message}
              key={messageKey(message)}
              fresh={fresh.has(messageKey(message))}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function ActivityRow({
  events,
  message,
  fresh,
}: {
  events: AgentOutputEvent[];
  message: AgentOutputMessage;
  fresh: boolean;
}) {
  switch (activityType(message)) {
    case "thinking":
      return <ThinkingRow message={message} fresh={fresh} />;
    case "tool_call":
      return <ToolCallRow events={events} message={message} fresh={fresh} />;
    default:
      return <ChatMessageRow message={message} fresh={fresh} />;
  }
}

function ChatMessageRow({ message, fresh }: { message: AgentOutputMessage; fresh: boolean }) {
  const streaming = activityStatus(message) === "streaming";
  return (
    <article
      className={`chat-message${fresh ? " chat-message-fresh" : ""}`}
      aria-label={`${streaming ? "Streaming" : "Completed"} assistant message`}
    >
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
        <span className="activity-icon activity-icon-thinking" aria-hidden="true" />
        <span className="activity-label">Thinking</span>
      </summary>
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
    </details>
  );
}

function ToolCallRow({
  events,
  message,
  fresh,
}: {
  events: AgentOutputEvent[];
  message: AgentOutputMessage;
  fresh: boolean;
}) {
  const label = toolActivityLabel(message, events);
  const streaming = activityStatus(message) === "streaming";
  const hasDetails =
    message.tool_error !== undefined ||
    message.tool_output !== undefined ||
    message.tool_input !== undefined;
  return (
    <article
      className={`activity-row tool-row tool-row-${activityStatus(message)}${fresh ? " activity-row-fresh" : ""}`}
      aria-label={`${statusLabel(message)} tool call: ${label}`}
    >
      <div className="activity-header">
        <span className="activity-icon activity-icon-tool" aria-hidden="true" />
        <span className="activity-label">{label}</span>
      </div>
      {hasDetails ? (
        <details className="tool-details">
          <summary>Details</summary>
          {message.tool_error ? <p className="tool-error">{message.tool_error}</p> : null}
          {message.tool_output ? (
            <pre className="tool-output" aria-live={streaming ? "polite" : undefined}>
              {message.tool_output}
              {streaming ? "▋" : ""}
            </pre>
          ) : null}
          {message.tool_input !== undefined ? (
            <pre className="tool-input" aria-label="Tool input">
              {formatPayload(message.tool_input)}
            </pre>
          ) : null}
        </details>
      ) : null}
    </article>
  );
}

function messageKey(message: AgentOutputMessage): string {
  return `message:${message.run_id}:${message.turn ?? "unknown"}:${message.activity_id ?? message.message_id}`;
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

export function isVisibleActivity(message: AgentOutputMessage): boolean {
  return activityType(message) !== "thinking" || hasThinkingSummary(message.content);
}

export function hasThinkingSummary(content: string): boolean {
  return content.trim() !== "";
}

function activityStatus(message: AgentOutputMessage): AgentOutputMessage["status"] {
  return message.activity_status ?? message.status;
}

function statusLabel(message: AgentOutputMessage): string {
  const status = activityStatus(message);
  return status === "failed" ? "Failed" : status === "completed" ? "Completed" : "Streaming";
}

export function toolActivityLabel(message: AgentOutputMessage, events: AgentOutputEvent[]): string {
  const relatedEvents = events.filter(
    (event) =>
      (message.activity_id !== undefined && event.activity_id === message.activity_id) ||
      (event.seq >= message.seq_start && event.seq <= message.seq_end),
  );
  const name = firstText([
    message.tool_name,
    textAtPaths(message.tool_input, toolNamePaths),
    ...relatedEvents.map((event) => event.tool_name),
    ...relatedEvents.map((event) => textAtPaths(event.payload, toolNamePaths)),
    ...relatedEvents.map((event) => textAtPaths(parseRawPayload(event.raw), toolNamePaths)),
  ]);
  const command = firstText([
    message.tool_command,
    textAtPaths(message.tool_input, toolCommandPaths),
    ...relatedEvents.map((event) => event.tool_command),
    ...relatedEvents.map((event) => textAtPaths(event.payload, toolCommandPaths)),
    ...relatedEvents.map((event) => textAtPaths(parseRawPayload(event.raw), toolCommandPaths)),
  ]);
  if (command !== undefined && command !== "") {
    return toolCommandLabel(command, name);
  }
  if (name !== undefined) {
    return name;
  }
  const summary = firstText(relatedEvents.map((event) => event.message));
  return toolSummaryLabel(summary) ?? "Used a tool";
}

function toolCommandLabel(command: string, name: string | undefined): string {
  const shellCommand = unwrapShellCommand(command);
  if (shellCommand !== null) {
    const summary = summarizeShellCommand(shellCommand);
    return isGenericToolName(name) ? summary : `${name} ${summary}`;
  }
  return name === undefined ? `Ran ${command}` : `${name} ${command}`;
}

function unwrapShellCommand(command: string): { shell: string; body: string } | null {
  const match = command.match(/^(?:\/bin\/)?(bash|zsh|sh)\s+-lc\s+([\s\S]+)$/i);
  if (match === null) {
    return null;
  }
  const body = match[2].trim();
  if (
    (body.startsWith('"') && body.endsWith('"')) ||
    (body.startsWith("'") && body.endsWith("'"))
  ) {
    return { shell: match[1].toLowerCase(), body: body.slice(1, -1) };
  }
  return { shell: match[1].toLowerCase(), body };
}

function summarizeShellCommand(command: { shell: string; body: string }): string {
  const body = command.body.replace(/\s+/g, " ").trim();
  if (/\b(?:sed|cat|head|tail|less|more)\b/i.test(body)) {
    return "Read files";
  }
  if (/\b(?:rg|grep)\b/i.test(body)) {
    return "Searched the codebase";
  }
  if (/\bgit\s+status\b/i.test(body)) {
    return "Checked git status";
  }
  if (/\bgit\s+diff\b/i.test(body)) {
    return "Reviewed changes";
  }
  return `Ran ${body}`;
}

function isGenericToolName(name: string | undefined): boolean {
  return (
    name === undefined ||
    /^(?:bash|command|exec_command|run|shell|sh|tool|tool_call|zsh)$/i.test(name)
  );
}

function toolSummaryLabel(summary: string | undefined): string | undefined {
  if (summary === undefined) {
    return undefined;
  }
  const match = summary.match(/\b(?:dynamic|mcp) tool call[^()]*\(([^()]+)\)\s*$/i);
  return match?.[1]?.trim() || summary;
}

const toolNamePaths = [
  ["tool_name"],
  ["toolName"],
  ["name"],
  ["tool"],
  ["params", "name"],
  ["params", "tool"],
  ["params", "toolName"],
  ["params", "item", "name"],
  ["params", "item", "toolName"],
  ["params", "msg", "name"],
  ["params", "msg", "toolName"],
];

const toolCommandPaths = [
  ["command"],
  ["cmd"],
  ["params", "command"],
  ["params", "cmd"],
  ["params", "item", "command"],
  ["params", "item", "cmd"],
  ["params", "msg", "command"],
  ["params", "msg", "cmd"],
];

function firstText(values: Array<string | null | undefined>): string | undefined {
  return values.find((value) => typeof value === "string" && value.trim() !== "")?.trim();
}

function textAtPaths(value: unknown, paths: string[][]): string | undefined {
  for (const path of paths) {
    let current = value;
    for (const key of path) {
      if (typeof current !== "object" || current === null || Array.isArray(current)) {
        current = undefined;
        break;
      }
      current = (current as Record<string, unknown>)[key];
    }
    if (typeof current === "string" && current.trim() !== "") {
      return current.trim();
    }
  }
  return undefined;
}

function parseRawPayload(raw: string | undefined): unknown {
  if (raw === undefined || raw.trim() === "") {
    return undefined;
  }
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
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
