import { ArrowDown, ChevronDown, LoaderCircle, Mic, Plus, Settings2, Zap } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { RunHeader } from "./components/RunHeader";
import { RunSidebar } from "./components/RunSidebar";
import { RunTimeline } from "./components/RunTimeline";
import {
  type AgentActivityStatus,
  type AgentOutputEvent,
  type AgentOutputMessage,
  type IssueDetail,
  type OutputPayload,
  type RunItem,
  type StatePayload,
  getIssue,
  getOutputForRun,
  getState,
  rerunBlockedIssue,
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
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [detail, setDetail] = useState<IssueDetail | null>(null);
  const [output, setOutput] = useState<TranscriptOutput | null>(null);
  const [events, setEvents] = useState<AgentOutputEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [timelineLoading, setTimelineLoading] = useState(false);
  const [loadingLater, setLoadingLater] = useState(false);
  const [laterError, setLaterError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [rerunning, setRerunning] = useState(false);
  const [streamState, setStreamState] = useState<"connected" | "waiting">("waiting");
  const laterControllerRef = useRef<AbortController | null>(null);
  const selectionKey = `${selected ?? ""}:${selectedRunId ?? ""}`;
  const selectionKeyRef = useRef(selectionKey);

  const runs = useMemo(() => allRuns(state), [state]);
  const selectedRun =
    detail?.logs?.agent_runs?.find((run) => run.run_id === selectedRunId) ??
    runs.find((run) => run.issue_identifier === selected) ??
    null;
  const hasLater = output?.has_more ?? false;
  const laterCursor = output?.next_cursor ?? null;

  const loadLater = useCallback(async (): Promise<void> => {
    if (selected === null || !hasLater || laterCursor === null || loadingLater) {
      return;
    }
    const requestKey = selectionKey;
    const controller = new AbortController();
    laterControllerRef.current?.abort();
    laterControllerRef.current = controller;
    setLoadingLater(true);
    setLaterError(null);
    try {
      const rawOutput = await getOutputForRun(selected, selectedRunId, controller.signal, {
        after: laterCursor,
      });
      if (controller.signal.aborted || selectionKeyRef.current !== requestKey) {
        return;
      }
      const nextOutput = withTranscript(rawOutput);
      setOutput((current) => mergeOutput(current, nextOutput));
      setEvents((current) => mergeEvents(current, nextOutput.events));
    } catch (loadError) {
      if (!controller.signal.aborted && selectionKeyRef.current === requestKey) {
        setLaterError(loadError instanceof Error ? loadError.message : "Later output unavailable");
      }
    } finally {
      if (laterControllerRef.current === controller) {
        laterControllerRef.current = null;
        setLoadingLater(false);
      }
    }
  }, [hasLater, laterCursor, loadingLater, selected, selectedRunId, selectionKey]);

  const handleRerunBlocked = useCallback(
    async (identifier: string): Promise<void> => {
      setRerunning(true);
      setError(null);
      try {
        await rerunBlockedIssue(identifier);
        const [nextState, nextDetail] = await Promise.all([
          getState().catch(() => null),
          selected === identifier ? getIssue(identifier).catch(() => null) : Promise.resolve(null),
        ]);
        if (nextState !== null) {
          setState(nextState);
        }
        if (selected === identifier) {
          setDetail(nextDetail);
        }
      } catch (rerunError) {
        setError(rerunError instanceof Error ? rerunError.message : "Rerun unavailable");
      } finally {
        setRerunning(false);
      }
    },
    [selected],
  );

  useEffect(() => {
    selectionKeyRef.current = selectionKey;
    laterControllerRef.current?.abort();
    laterControllerRef.current = null;
    setLoadingLater(false);
    setLaterError(null);
    return () => laterControllerRef.current?.abort();
  }, [selectionKey]);

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
      setLoadingLater(false);
      setLaterError(null);
      setSelectedRunId(null);
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
          getOutputForRun(selected, selectedRunId, controller.signal, { after: 0 }),
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
      selectedRunId,
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
  }, [selected, selectedRunId]);

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
        selectedRunId={selectedRunId ?? output?.run_id ?? null}
        onSelect={(identifier, runId = null) => {
          setSelectedRunId(runId);
          setSelected(identifier);
        }}
      />
      <main className="workspace" id="main-content">
        <RunHeader
          identifier={selected}
          detail={detail}
          run={output?.run ?? selectedRun}
          onRerunBlocked={(identifier) => void handleRerunBlocked(identifier)}
          rerunning={rerunning}
          loading={loading || timelineLoading}
        />
        <RunTimeline
          events={events}
          messages={output?.messages ?? []}
          title={detail?.title ?? output?.run?.title ?? selectedRun?.title ?? null}
          loading={timelineLoading}
          error={output?.error?.message ?? laterError ?? (selected ? null : error)}
          hasLater={hasLater}
          loadingLater={loadingLater}
          onLoadLater={() => void loadLater()}
        />
        <footer className="composer-shell" aria-label="Output composer">
          <div className="composer" aria-label="Read-only output composer">
            <div className="composer-placeholder">Do anything</div>
            <div className="composer-toolbar">
              <Plus className="composer-plus" size={22} strokeWidth={1.7} aria-hidden="true" />
              <span className="composer-context">
                <Settings2
                  className="composer-context-icon"
                  size={18}
                  strokeWidth={1.7}
                  aria-hidden="true"
                />
                symphony_git
              </span>
              <span className="composer-grow" />
              <span className={`composer-live composer-live-${streamState}`}>
                <LoaderCircle
                  className="composer-live-dot"
                  size={15}
                  strokeWidth={1.8}
                  aria-hidden="true"
                />
              </span>
              <span className="composer-model">
                <Zap
                  className="composer-spark"
                  size={17}
                  strokeWidth={1.8}
                  fill="currentColor"
                  aria-hidden="true"
                />
                5.6 Luna Max
              </span>
              <ChevronDown
                className="composer-chevron"
                size={17}
                strokeWidth={1.7}
                aria-hidden="true"
              />
              <Mic className="composer-mic" size={20} strokeWidth={1.7} aria-hidden="true" />
              <span className="composer-send" aria-hidden="true">
                <ArrowDown size={22} strokeWidth={1.7} />
              </span>
            </div>
          </div>
          <div className="composer-note">
            {streamState === "connected" ? "Live output" : "Waiting for output"}
            <span>Read-only observability view · polls every 5s</span>
          </div>
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

export function withTranscript(output: OutputPayload): TranscriptOutput {
  const messages = (output as OutputPayload & { messages?: unknown }).messages;
  return {
    ...output,
    messages: Array.isArray(messages) ? (messages as AgentOutputMessage[]) : [],
  };
}

export function mergeOutput(
  current: TranscriptOutput | null,
  next: TranscriptOutput,
): TranscriptOutput {
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
    next_cursor: Math.max(current.next_cursor ?? 0, next.next_cursor ?? 0) || null,
    has_more: next.has_more,
    before_cursor: next.before_cursor,
    has_before: next.has_before,
    messages: mergeMessageSnapshots(current.messages, next.messages),
    run,
  };
}

export function mergeLiveOutput(
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
      before_cursor: null,
      has_before: false,
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
    messages: mergeLiveActivities(base.messages, event),
    before_cursor: base.before_cursor,
    has_before: base.has_before,
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
      (message.seq_end === previous.seq_end && isTerminalStatus(message.status))
    ) {
      merged.set(key, message);
    }
  }
  return sortMessages([...merged.values()]);
}

type LiveActivity = {
  type: NonNullable<AgentOutputMessage["activity_type"]>;
  id: string;
  phase: ChatPhase | "failed";
  status: AgentActivityStatus;
  contentDelta?: string;
  toolName?: string;
  toolInput?: unknown;
  toolCommand?: string;
  toolOutputDelta?: string;
  toolError?: string;
};

function mergeLiveActivities(
  messages: AgentOutputMessage[],
  event: AgentOutputEvent,
): AgentOutputMessage[] {
  const activity = liveActivityFromEvent(event);
  if (activity === null) {
    return isTerminalEvent(event) ? closeLiveActivities(messages, event) : messages;
  }

  const index = messages.findIndex((message) => messageMatchesActivity(message, event, activity));
  const previous = index === -1 ? undefined : messages[index];

  if (activity.phase === "start") {
    if (previous !== undefined && event.seq <= previous.seq_end) {
      return messages;
    }
    if (previous !== undefined) {
      const next = [...messages];
      next[index] = applyLiveActivity(previous, event, activity);
      return sortMessages(next);
    }
    return sortMessages([...messages, liveMessageFromEvent(event, activity)]);
  }

  if (previous === undefined) {
    return sortMessages([...messages, liveMessageFromEvent(event, activity)]);
  }

  if (event.seq <= previous.seq_end) {
    return messages;
  }
  const next = [...messages];
  next[index] = applyLiveActivity(previous, event, activity);
  return sortMessages(next);
}

function liveMessageFromEvent(event: AgentOutputEvent, activity: LiveActivity): AgentOutputMessage {
  const message: AgentOutputMessage = {
    message_id: activity.id,
    activity_id: activity.id,
    activity_type: activity.type,
    activity_status: activity.status,
    issue_identifier: event.issue_identifier,
    backend: event.backend,
    run_id: event.run_id,
    ...(event.session_id !== undefined ? { session_id: event.session_id } : {}),
    ...(event.turn !== undefined ? { turn: event.turn } : {}),
    ...(typeof event.parent_message_id === "string"
      ? { parent_message_id: event.parent_message_id }
      : {}),
    ...(activity.type === "assistant_message" ? { role: "assistant" as const } : {}),
    content: "",
    status: activity.status,
    seq_start: event.seq,
    seq_end: event.seq,
    at: event.at,
    updated_at: event.at,
  };
  return applyLiveActivity(message, event, activity);
}

function applyLiveActivity(
  previous: AgentOutputMessage,
  event: AgentOutputEvent,
  activity: LiveActivity,
): AgentOutputMessage {
  const next: AgentOutputMessage = {
    ...previous,
    activity_id: previous.activity_id ?? activity.id,
    activity_type: activity.type,
    activity_status: activity.status,
    status: activity.status,
    seq_end: Math.max(previous.seq_end, event.seq),
    updated_at: event.at,
  };
  if (typeof event.parent_message_id === "string") {
    next.parent_message_id = event.parent_message_id;
  }
  if (activity.type === "assistant_message" || activity.type === "thinking") {
    next.content = previous.content + (activity.contentDelta ?? "");
  }
  if (activity.type === "tool_call") {
    if (activity.toolName !== undefined) {
      next.tool_name = activity.toolName;
    }
    if (activity.toolInput !== undefined) {
      next.tool_input = activity.toolInput;
    }
    if (activity.toolCommand !== undefined) {
      next.tool_command = activity.toolCommand;
    }
    if (activity.toolOutputDelta !== undefined) {
      next.tool_output = `${previous.tool_output ?? ""}${activity.toolOutputDelta}`;
    }
    if (activity.toolError !== undefined) {
      next.tool_error = activity.toolError;
    }
  }
  return next;
}

function liveActivityFromEvent(event: AgentOutputEvent): LiveActivity | null {
  if (event.activity_type === "assistant_message") {
    const id = typeof event.activity_id === "string" ? event.activity_id : event.chat_id;
    if (typeof id !== "string") {
      return null;
    }
    const status = activityStatus(event.activity_status, chatPhaseFor(event));
    return {
      type: "assistant_message",
      id,
      phase: chatPhaseFor(event) ?? phaseForStatus(status),
      status,
      ...(typeof event.chat_delta === "string" ? { contentDelta: event.chat_delta } : {}),
    };
  }
  if (event.activity_type === "thinking") {
    if (typeof event.activity_id !== "string") {
      return null;
    }
    const status = activityStatus(event.activity_status, null);
    return {
      type: "thinking",
      id: event.activity_id,
      phase: phaseForStatus(status),
      status,
      ...(typeof event.thinking_summary_delta === "string"
        ? { contentDelta: event.thinking_summary_delta }
        : {}),
    };
  }
  if (event.activity_type === "tool_call") {
    if (typeof event.activity_id !== "string") {
      return null;
    }
    const status = activityStatus(event.activity_status, null);
    return {
      type: "tool_call",
      id: event.activity_id,
      phase: phaseForStatus(status),
      status,
      ...(typeof event.tool_name === "string" ? { toolName: event.tool_name } : {}),
      ...(event.tool_input !== undefined ? { toolInput: event.tool_input } : {}),
      ...(typeof event.tool_command === "string" ? { toolCommand: event.tool_command } : {}),
      ...(typeof event.tool_output_delta === "string"
        ? { toolOutputDelta: event.tool_output_delta }
        : {}),
      ...(typeof event.tool_error === "string" ? { toolError: event.tool_error } : {}),
    };
  }

  const phase = chatPhaseFor(event);
  const chatId = typeof event.chat_id === "string" ? event.chat_id : null;
  if (phase === null || chatId === null) {
    return null;
  }
  return {
    type: "assistant_message",
    id: chatId,
    phase,
    status: phase === "complete" ? "completed" : "streaming",
    ...(typeof event.chat_delta === "string" ? { contentDelta: event.chat_delta } : {}),
  };
}

function closeLiveActivities(
  messages: AgentOutputMessage[],
  event: AgentOutputEvent,
): AgentOutputMessage[] {
  const status = terminalStatus(event);
  return messages.map((message) => {
    if (
      message.run_id !== event.run_id ||
      (event.turn !== undefined && message.turn !== undefined && message.turn !== event.turn) ||
      isTerminalStatus(message.status)
    ) {
      return message;
    }
    return {
      ...message,
      status,
      activity_status: status,
      seq_end: Math.max(message.seq_end, event.seq),
      updated_at: event.at,
    };
  });
}

function messageMatchesActivity(
  message: AgentOutputMessage,
  event: AgentOutputEvent,
  activity: LiveActivity,
): boolean {
  return (
    message.run_id === event.run_id &&
    (message.activity_id ?? message.message_id) === activity.id &&
    message.turn === event.turn
  );
}

function chatPhaseFor(event: AgentOutputEvent): ChatPhase | null {
  return event.chat_phase === "start" ||
    event.chat_phase === "delta" ||
    event.chat_phase === "complete"
    ? event.chat_phase
    : null;
}

function activityStatus(
  value: AgentOutputEvent["activity_status"],
  phase: ChatPhase | null,
): AgentActivityStatus {
  if (value === "streaming" || value === "completed" || value === "failed") {
    return value;
  }
  return phase === "complete" ? "completed" : "streaming";
}

function phaseForStatus(status: AgentActivityStatus): LiveActivity["phase"] {
  if (status === "failed") {
    return "failed";
  }
  return status === "completed" ? "complete" : "delta";
}

function isTerminalEvent(event: AgentOutputEvent): boolean {
  return (
    event.event === "turn_completed" ||
    event.event === "turn_failed" ||
    event.event === "turn_cancelled" ||
    event.event === "turn_timeout" ||
    event.event === "turn_input_required" ||
    event.event === "port_exit" ||
    event.event === "run_completed" ||
    event.event === "run_failed" ||
    event.event === "run_cancelled"
  );
}

function terminalStatus(event: AgentOutputEvent): AgentActivityStatus {
  return event.event === "run_failed" ||
    event.event === "turn_failed" ||
    event.event === "turn_timeout" ||
    event.event === "port_exit"
    ? "failed"
    : "completed";
}

function isTerminalStatus(status: AgentActivityStatus): boolean {
  return status === "completed" || status === "failed";
}

function messageKey(message: AgentOutputMessage): string {
  return `${message.run_id}:${message.turn ?? "unknown"}:${message.activity_id ?? message.message_id}`;
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
