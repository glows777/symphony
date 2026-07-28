import { useEffect, useMemo, useState } from "react";
import { RunHeader } from "./components/RunHeader";
import { RunSidebar } from "./components/RunSidebar";
import { RunTimeline } from "./components/RunTimeline";
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

export function App() {
  const [state, setState] = useState<StatePayload | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<IssueDetail | null>(null);
  const [output, setOutput] = useState<OutputPayload | null>(null);
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
    setEvents([]);

    const loadRun = async (): Promise<void> => {
      try {
        const [nextDetail, nextOutput] = await Promise.all([
          getIssue(selected, controller.signal).catch(() => null),
          getOutput(selected, controller.signal),
        ]);
        if (!active) {
          return;
        }
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
        Skip to timeline
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

function mergeOutput(current: OutputPayload | null, next: OutputPayload): OutputPayload {
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
    run,
  };
}

function mergeLiveOutput(current: OutputPayload | null, event: AgentOutputEvent): OutputPayload {
  const base =
    current ??
    ({
      events: [],
      next_cursor: null,
      has_more: false,
      run: null,
      backend: event.backend,
      run_id: event.run_id,
      session_id: event.session_id ?? null,
    } satisfies OutputPayload);
  const run =
    base.run?.run_id === event.run_id
      ? { ...base.run, last_seq: Math.max(base.run.last_seq, event.seq) }
      : base.run;
  return {
    ...base,
    events: sortEvents(upsertEvent(base.events, event)),
    next_cursor: Math.max(base.next_cursor ?? 0, event.seq),
    run,
  };
}

function sortEvents(events: AgentOutputEvent[]): AgentOutputEvent[] {
  return [...events].sort((left, right) => {
    if (left.run_id === right.run_id) {
      return left.seq - right.seq;
    }
    return left.at.localeCompare(right.at);
  });
}
