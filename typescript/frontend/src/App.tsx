import { useEffect, useMemo, useState } from "react";
import { RunHeader } from "./components/RunHeader";
import { RunSidebar } from "./components/RunSidebar";
import { type AgentOutputMessage, RunTimeline } from "./components/RunTimeline";
import {
  type AgentOutputEvent,
  type IssueDetail,
  type OutputPayload,
  type RunItem,
  type StatePayload,
  getIssue,
  getOutput,
  getState,
  subscribeToOutput,
} from "./lib/api";

const REFRESH_INTERVAL_MS = 5_000;

type TranscriptOutput = OutputPayload & {
  messages: AgentOutputMessage[];
};

type ChatPhase = "start" | "delta" | "complete";

export function App() {
  const [state, setState] = useState<StatePayload | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<IssueDetail | null>(null);
  const [output, setOutput] = useState<TranscriptOutput | null>(null);
  const [events, setEvents] = useState<AgentOutputEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [timelineLoading, setTimelineLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [streamState, setStreamState] = useState<"connected" | "waiting">("waiting");

  const runs = useMemo(() => allRuns(state), [state]);
  const selectedRun = runs.find((run) => run.issue_identifier === selected) ?? null;

  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    const loadState = async (): Promise<void> => {
      try {
        const next = await getState(controller.signal);
        if (!active) {
          return;
        }
        setState(next);
        setError(next.error?.message ?? null);
        setSelected((current) => {
          const available = allRuns(next);
          if (current !== null && available.some((run) => run.issue_identifier === current)) {
            return current;
          }
          return available[0]?.issue_identifier ?? null;
        });
        setLoading(false);
      } catch (loadError) {
        if (active && !controller.signal.aborted) {
          setError(loadError instanceof Error ? loadError.message : "State unavailable");
          setLoading(false);
        }
      }
    };
    void loadState();
    const timer = window.setInterval(() => void loadState(), REFRESH_INTERVAL_MS);
    return () => {
      active = false;
      controller.abort();
      window.clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    if (selected === null) {
      setDetail(null);
      setOutput(null);
      setEvents([]);
      setStreamState("waiting");
      return;
    }
    const controller = new AbortController();
    let active = true;
    setTimelineLoading(true);
    setStreamState("waiting");
    setDetail(null);
    setOutput(null);
    setEvents([]);

    const loadRun = async (): Promise<void> => {
      try {
        const [nextDetail, rawOutput] = await Promise.all([
          getIssue(selected, controller.signal).catch(() => null),
          getOutput(selected, controller.signal),
        ]);
        if (!active) {
          return;
        }
        const nextOutput = withTranscript(rawOutput);
        setDetail(nextDetail);
        setOutput((current) => mergeOutput(current, nextOutput));
        setEvents((current) => mergeEvents(current, nextOutput.events));
        setTimelineLoading(false);
      } catch (loadError) {
        if (active && !controller.signal.aborted) {
          setError(loadError instanceof Error ? loadError.message : "Output unavailable");
          setTimelineLoading(false);
        }
      }
    };
    void loadRun();

    let unsubscribe = (): void => {};
    unsubscribe = subscribeToOutput(
      selected,
      (event) => {
        if (!active) {
          return;
        }
        setStreamState("connected");
        setEvents((current) => sortEvents(upsertEvent(current, event)));
        setOutput((current) => mergeLiveOutput(current, event));
      },
      () => {
        if (active) {
          setStreamState("waiting");
        }
      },
    );
    return () => {
      active = false;
      controller.abort();
      unsubscribe();
    };
  }, [selected]);

  return (
    <div className="observability-app">
      <a className="skip-link" href="#main-content">
        Skip to conversation
      </a>
      <RunSidebar
        running={state?.running ?? []}
        retrying={state?.retrying ?? []}
        blocked={state?.blocked ?? []}
        completed={state?.completed ?? []}
        selected={selected}
        onSelect={setSelected}
      />
      <main className="workspace" id="main-content">
        <RunHeader
          identifier={selected}
          detail={detail}
          run={output?.run ?? selectedRun}
          loading={loading || timelineLoading}
        />
        <RunTimeline
          events={events}
          messages={output?.messages ?? []}
          loading={timelineLoading}
          error={output?.error?.message ?? (selected ? null : error)}
        />
        <footer className="runtime-bar">
          <span className={`runtime-status runtime-status-${streamState}`}>
            <span className="runtime-status-dot" />
            {streamState === "connected" ? "Live output" : "Waiting for output"}
          </span>
          <span className="runtime-separator" />
          <span>Read only</span>
          <span className="runtime-grow" />
          <span className="runtime-updated">Polls every 5s · SSE when available</span>
        </footer>
      </main>
    </div>
  );
}

function allRuns(state: StatePayload | null): RunItem[] {
  if (state === null) {
    return [];
  }
  return [
    ...(state.running ?? []),
    ...(state.retrying ?? []).map((item) => ({
      ...item,
      title: item.title ?? "Retry scheduled",
      status: "retrying",
    })),
    ...(state.blocked ?? []),
    ...(state.completed ?? []),
  ];
}

function upsertEvent(events: AgentOutputEvent[], next: AgentOutputEvent): AgentOutputEvent[] {
  const index = events.findIndex((event) => event.run_id === next.run_id && event.seq === next.seq);
  if (index === -1) {
    return [...events, next];
  }
  return events.map((event, currentIndex) => (currentIndex === index ? next : event));
}

function mergeEvents(current: AgentOutputEvent[], next: AgentOutputEvent[]): AgentOutputEvent[] {
  return sortEvents(next.reduce(upsertEvent, current));
}

function withTranscript(output: OutputPayload): TranscriptOutput {
  const messages = (output as OutputPayload & { messages?: unknown }).messages;
  return {
    ...output,
    messages: Array.isArray(messages) ? (messages as AgentOutputMessage[]) : [],
  };
}

function mergeOutput(current: TranscriptOutput | null, next: TranscriptOutput): TranscriptOutput {
  if (current === null) {
    return next;
  }
  const events = mergeEvents(current.events, next.events);
  const run =
    next.run === null
      ? null
      : {
          ...next.run,
          last_seq: Math.max(
            next.run.last_seq,
            ...events
              .filter((event) => event.run_id === next.run?.run_id)
              .map((event) => event.seq),
          ),
        };
  return {
    ...next,
    events,
    messages: mergeMessageSnapshots(current.messages, next.messages),
    run,
  };
}

function mergeLiveOutput(
  current: TranscriptOutput | null,
  event: AgentOutputEvent,
): TranscriptOutput {
  const base =
    current ??
    ({
      events: [],
      messages: [],
      next_cursor: null,
      has_more: false,
      run: null,
      backend: event.backend,
      run_id: event.run_id,
      session_id: event.session_id ?? null,
    } satisfies TranscriptOutput);
  const run =
    base.run?.run_id === event.run_id
      ? { ...base.run, last_seq: Math.max(base.run.last_seq, event.seq) }
      : base.run;
  return {
    ...base,
    events: sortEvents(upsertEvent(base.events, event)),
    messages: mergeLiveChatMessages(base.messages, event),
    next_cursor: Math.max(base.next_cursor ?? 0, event.seq),
    run,
  };
}

function mergeMessageSnapshots(
  current: AgentOutputMessage[],
  next: AgentOutputMessage[],
): AgentOutputMessage[] {
  const merged = new Map(current.map((message) => [messageKey(message), message]));
  for (const message of next) {
    const key = messageKey(message);
    const previous = merged.get(key);
    if (
      previous === undefined ||
      message.seq_end > previous.seq_end ||
      (message.seq_end === previous.seq_end && message.status === "completed")
    ) {
      merged.set(key, message);
    }
  }
  return [...merged.values()].sort((left, right) => left.seq_start - right.seq_start);
}

function mergeLiveChatMessages(
  messages: AgentOutputMessage[],
  event: AgentOutputEvent,
): AgentOutputMessage[] {
  const phase = chatPhaseFor(event);
  if (phase === null) {
    if (event.event !== "turn_completed" && event.event !== "run_completed") {
      return messages;
    }
    return messages.map((message) => {
      if (
        message.run_id !== event.run_id ||
        (event.turn !== undefined && message.turn !== undefined && message.turn !== event.turn)
      ) {
        return message;
      }
      return {
        ...message,
        status: "completed",
        seq_end: Math.max(message.seq_end, event.seq),
        updated_at: event.at,
      };
    });
  }

  const chatId = typeof event.chat_id === "string" ? event.chat_id : null;
  if (chatId === null) {
    return messages;
  }
  const index = messages.findIndex(
    (message) =>
      message.run_id === event.run_id &&
      message.message_id === chatId &&
      message.turn === event.turn,
  );
  const previous = index === -1 ? undefined : messages[index];

  if (phase === "start") {
    if (previous !== undefined && event.seq <= previous.seq_end) {
      return messages;
    }
    if (previous !== undefined) {
      const next = [...messages];
      next[index] = { ...previous, seq_end: event.seq, updated_at: event.at };
      return next;
    }
    return [...messages, liveMessageFromEvent(event, chatId, "")];
  }

  if (previous === undefined) {
    return [
      ...messages,
      liveMessageFromEvent(
        event,
        chatId,
        typeof event.chat_delta === "string" ? event.chat_delta : "",
        phase === "complete" ? "completed" : "streaming",
      ),
    ];
  }

  if (phase === "delta") {
    if (event.seq <= previous.seq_end) {
      return messages;
    }
    const next = [...messages];
    next[index] = {
      ...previous,
      content: previous.content + (typeof event.chat_delta === "string" ? event.chat_delta : ""),
      status: "streaming",
      seq_end: event.seq,
      updated_at: event.at,
    };
    return next;
  }

  if (previous.status === "completed" && event.seq <= previous.seq_end) {
    return messages;
  }
  const next = [...messages];
  next[index] = {
    ...previous,
    status: "completed",
    seq_end: Math.max(previous.seq_end, event.seq),
    updated_at: event.at,
  };
  return next;
}

function liveMessageFromEvent(
  event: AgentOutputEvent,
  messageId: string,
  content: string,
  status: AgentOutputMessage["status"] = "streaming",
): AgentOutputMessage {
  return {
    message_id: messageId,
    issue_identifier: event.issue_identifier,
    backend: event.backend,
    run_id: event.run_id,
    ...(event.session_id !== undefined ? { session_id: event.session_id } : {}),
    ...(event.turn !== undefined ? { turn: event.turn } : {}),
    role: "assistant",
    content,
    status,
    seq_start: event.seq,
    seq_end: event.seq,
    at: event.at,
    updated_at: event.at,
  };
}

function chatPhaseFor(event: AgentOutputEvent): ChatPhase | null {
  return event.chat_phase === "start" ||
    event.chat_phase === "delta" ||
    event.chat_phase === "complete"
    ? event.chat_phase
    : null;
}

function messageKey(message: AgentOutputMessage): string {
  return `${message.run_id}:${message.turn ?? "unknown"}:${message.message_id}`;
}

function sortEvents(events: AgentOutputEvent[]): AgentOutputEvent[] {
  return [...events].sort((left, right) => {
    if (left.run_id === right.run_id) {
      return left.seq - right.seq;
    }
    return left.at.localeCompare(right.at);
  });
}
