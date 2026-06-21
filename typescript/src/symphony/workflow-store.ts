// Literal port of `symphony_elixir/workflow_store.ex`.
//
// Elixir uses a GenServer that caches the last known good workflow and reloads
// when WORKFLOW.md changes. Its handlers are pure synchronous file ops, so the
// TS port runs them synchronously (single-threaded JS preserves the GenServer's
// serialized-execution guarantee without an async mailbox) with a polling
// timer. See MIGRATION.md.

import fs from "node:fs";
import { type Result, err, ok } from "./result.ts";
import { type LoadedWorkflow, load, workflowFilePath } from "./workflow.ts";

const POLL_INTERVAL_MS = 1_000;

type Stamp = string;

export type State = {
  path: string;
  stamp: Stamp | null;
  workflow: LoadedWorkflow;
};

let runningStore: WorkflowStore | null = null;

export function getRunningStore(): WorkflowStore | null {
  return runningStore;
}

type ReloadResult = { ok: true; value: State } | { ok: false; error: unknown; state: State };

export class WorkflowStore {
  private state: State;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;

  private constructor(state: State) {
    this.state = state;
  }

  // `init/1`: returns the initial state or a stop reason.
  static init(): Result<State, unknown> {
    return loadState(workflowFilePath());
  }

  // `start_link/1`: starts and registers the singleton, scheduling the poll.
  static startLink(): Result<WorkflowStore, unknown> {
    const initial = WorkflowStore.init();
    if (!initial.ok) {
      return err(initial.error);
    }
    const store = new WorkflowStore(initial.value);
    store.schedulePoll();
    runningStore = store;
    return ok(store);
  }

  // `current/0`: consults the running store, else loads directly.
  static current(): Result<LoadedWorkflow, unknown> {
    return runningStore ? runningStore.handleCurrent() : load();
  }

  // `force_reload/0`.
  static forceReload(): Result<undefined, unknown> {
    if (runningStore) {
      return runningStore.handleForceReload();
    }
    const result = load();
    return result.ok ? ok(undefined) : err(result.error);
  }

  // Instance dispatch used by Workflow.current() when this store is running.
  current(): Result<LoadedWorkflow, unknown> {
    return this.handleCurrent();
  }

  forceReload(): Result<undefined, unknown> {
    return this.handleForceReload();
  }

  // `handle_call(:current, ...)` — always replies with a workflow.
  private handleCurrent(): Result<LoadedWorkflow, unknown> {
    const result = reloadState(this.state);
    this.state = result.ok ? result.value : result.state;
    return ok(this.state.workflow);
  }

  // `handle_call(:force_reload, ...)`.
  private handleForceReload(): Result<undefined, unknown> {
    const result = reloadState(this.state);
    if (result.ok) {
      this.state = result.value;
      return ok(undefined);
    }
    this.state = result.state;
    return err(result.error);
  }

  // `handle_info(:poll, ...)`: reschedules then reloads, keeping last good.
  handlePoll(state: State): State {
    this.schedulePoll();
    const result = reloadState(state);
    return result.ok ? result.value : result.state;
  }

  // Triggered like `send(WorkflowStore, :poll)`.
  poll(): void {
    this.state = this.handlePoll(this.state);
  }

  getState(): State {
    return this.state;
  }

  stop(): void {
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
    if (runningStore === this) {
      runningStore = null;
    }
  }

  private schedulePoll(): void {
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
    }
    this.pollTimer = setTimeout(() => this.poll(), POLL_INTERVAL_MS);
    this.pollTimer.unref?.();
  }
}

function reloadState(state: State): ReloadResult {
  const path = workflowFilePath();
  return path !== state.path ? reloadPath(path, state) : reloadCurrentPath(path, state);
}

function reloadPath(path: string, state: State): ReloadResult {
  const result = loadState(path);
  if (result.ok) {
    return { ok: true, value: result.value };
  }
  return { ok: false, error: result.error, state };
}

function reloadCurrentPath(path: string, state: State): ReloadResult {
  const stamp = currentStamp(path);
  if (!stamp.ok) {
    return { ok: false, error: stamp.error, state };
  }
  if (stamp.value === state.stamp) {
    return { ok: true, value: state };
  }
  return reloadPath(path, state);
}

function loadState(path: string): Result<State, unknown> {
  const workflow = load(path);
  if (!workflow.ok) {
    return err(workflow.error);
  }
  const stamp = currentStamp(path);
  if (!stamp.ok) {
    return err(stamp.error);
  }
  return ok({ path, stamp: stamp.value, workflow: workflow.value });
}

function currentStamp(path: string): Result<Stamp, unknown> {
  let stat: fs.Stats;
  let content: string;
  try {
    stat = fs.statSync(path);
    content = fs.readFileSync(path, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return err(code ? code.toLowerCase() : "unknown");
  }
  const mtime = Math.floor(stat.mtimeMs / 1000);
  const hash = Bun.hash(content).toString();
  return ok(`${mtime}:${stat.size}:${hash}`);
}
