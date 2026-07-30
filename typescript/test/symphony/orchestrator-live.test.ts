import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { putEnv } from "../../src/symphony/app-env.ts";
import {
  Orchestrator,
  type RunningEntry,
  type RunningTask,
  type State,
  nowMs,
} from "../../src/symphony/orchestrator.ts";
import type {
  AgentBackendPlugin,
  AgentSession,
  TurnContext,
} from "../../src/symphony/plugins/agents/types.ts";
import type { TrackerPlugin } from "../../src/symphony/plugins/trackers/types.ts";
import { err, ok } from "../../src/symphony/result.ts";
import { newIssue } from "../../src/symphony/work-item.ts";
import { workflowFilePath } from "../../src/symphony/workflow.ts";
import { setupWorkflow, teardownWorkflow, writeWorkflowFile } from "../support/test-support.ts";

// Translated from the live orchestrator cases in core_test.exs that exercise the
// running GenServer: agent {:DOWN} handling, retry scheduling, missing-issue
// reconciliation, the stale-retry guard, and the manual-refresh coalescing path.

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function stoppableTask(): RunningTask & { stopped: boolean } {
  const task = {
    stopped: false,
    stop() {
      task.stopped = true;
    },
  };
  return task;
}

function expectDueInRange(dueAtMs: number, minRemaining: number, maxRemaining: number): void {
  const remaining = dueAtMs - nowMs();
  expect(remaining).toBeGreaterThanOrEqual(minRemaining);
  expect(remaining).toBeLessThanOrEqual(maxRemaining);
}

function blockingBackend(): {
  plugin: AgentBackendPlugin;
  turns: TurnContext[];
  resume(): void;
} {
  let resumeTurn: (() => void) | null = null;
  const gate = new Promise<void>((resolve) => {
    resumeTurn = resolve;
  });
  const turns: TurnContext[] = [];
  const plugin: AgentBackendPlugin = {
    id: "codex",
    displayName: "Blocking test backend",
    capabilities: { multiTurnSessions: true, remoteWorkers: true },
    sessions: {
      startSession: (workspace, opts = {}) =>
        Promise.resolve(
          ok({
            backendId: "codex",
            workspace,
            workerHost: opts.workerHost ?? null,
            runId: "blocking-run",
            handle: {},
          }),
        ),
      runTurn: async (_session: AgentSession, _prompt: string, context: TurnContext) => {
        turns.push(context);
        await gate;
        return ok({ sessionId: `turn-${context.turnNumber}` });
      },
      stopSession: () => {
        resumeTurn?.();
      },
    },
  };
  return {
    plugin,
    turns,
    resume() {
      resumeTurn?.();
    },
  };
}

describe("Orchestrator live (core_test)", () => {
  let root: string;
  let orchestrators: Orchestrator[];

  beforeEach(() => {
    ({ root } = setupWorkflow());
    orchestrators = [];
  });

  afterEach(() => {
    for (const orch of orchestrators) {
      orch.stop();
    }
    teardownWorkflow(root);
  });

  function makeOrchestrator(): Orchestrator {
    const orch = new Orchestrator();
    orchestrators.push(orch);
    return orch;
  }

  async function waitFor(predicate: () => boolean, timeoutMs = 500): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!predicate()) {
      if (Date.now() >= deadline) {
        throw new Error("timed out waiting for orchestrator state");
      }
      await sleep(5);
    }
  }

  function injectRunning(orch: Orchestrator, issueId: string, entry: RunningEntry): void {
    orch.replaceState((state) => ({
      ...state,
      running: { [issueId]: entry },
      claimed: new Set([issueId]),
      retry_attempts: {},
    }));
  }

  test("missing running issues stop active agents without cleaning the workspace", async () => {
    const workspaceRoot = path.join(root, "ws");
    const issueId = "issue-missing";
    const issueIdentifier = "MT-557";
    const workspace = path.join(workspaceRoot, issueIdentifier);
    fs.mkdirSync(workspace, { recursive: true });
    writeWorkflowFile(workflowFilePath(), {
      tracker_kind: "memory",
      workspace_root: workspaceRoot,
      tracker_active_states: ["Todo", "In Progress", "Merging", "Rework"],
      tracker_terminal_states: ["Closed", "Cancelled", "Canceled", "Duplicate"],
    });
    putEnv("memory_tracker_issues", []);

    const orch = makeOrchestrator();
    const task = stoppableTask();
    injectRunning(orch, issueId, {
      task,
      ref: null,
      identifier: issueIdentifier,
      issue: newIssue({ id: issueId, state: "In Progress", identifier: issueIdentifier }),
      started_at: new Date(),
    });

    await orch.cast({ tag: "tick", token: null });
    await waitFor(() => !(issueId in orch.getState().running));

    const state = orch.getState();
    expect(issueId in state.running).toBe(false);
    expect(state.claimed.has(issueId)).toBe(false);
    expect(task.stopped).toBe(true);
    expect(fs.existsSync(workspace)).toBe(true);
  });

  test("normal worker exit schedules active-state continuation retry", async () => {
    const orch = makeOrchestrator();
    const issueId = "issue-resume";
    const ref = Symbol("ref");
    injectRunning(orch, issueId, {
      task: stoppableTask(),
      ref,
      identifier: "MT-558",
      issue: newIssue({ id: issueId, identifier: "MT-558", state: "In Progress" }),
      started_at: new Date(),
    });

    await orch.cast({ tag: "down", ref, reason: "normal" });

    const state = orch.getState();
    expect(issueId in state.running).toBe(false);
    expect(state.completed.has(issueId)).toBe(true);
    const retry = state.retry_attempts[issueId];
    expect(retry?.attempt).toBe(1);
    expect(typeof retry?.due_at_ms).toBe("number");
    expectDueInRange(retry?.due_at_ms ?? 0, 500, 1_100);
  });

  test("abnormal worker exit increments retry attempt progressively", async () => {
    const orch = makeOrchestrator();
    const issueId = "issue-crash";
    const ref = Symbol("ref");
    injectRunning(orch, issueId, {
      task: stoppableTask(),
      ref,
      identifier: "MT-559",
      retry_attempt: 2,
      issue: newIssue({ id: issueId, identifier: "MT-559", state: "In Progress" }),
      started_at: new Date(),
    });

    await orch.cast({ tag: "down", ref, reason: ":boom" });

    const retry = orch.getState().retry_attempts[issueId];
    expect(retry?.attempt).toBe(3);
    expect(retry?.identifier).toBe("MT-559");
    expect(retry?.error).toBe("agent exited: :boom");
    expectDueInRange(retry?.due_at_ms ?? 0, 39_500, 40_500);
  });

  test("first abnormal worker exit waits before retrying", async () => {
    const orch = makeOrchestrator();
    const issueId = "issue-crash-initial";
    const ref = Symbol("ref");
    injectRunning(orch, issueId, {
      task: stoppableTask(),
      ref,
      identifier: "MT-560",
      issue: newIssue({ id: issueId, identifier: "MT-560", state: "In Progress" }),
      started_at: new Date(),
    });

    await orch.cast({ tag: "down", ref, reason: ":boom" });

    const retry = orch.getState().retry_attempts[issueId];
    expect(retry?.attempt).toBe(1);
    expect(retry?.identifier).toBe("MT-560");
    expect(retry?.error).toBe("agent exited: :boom");
    expectDueInRange(retry?.due_at_ms ?? 0, 9_000, 10_500);
  });

  test("abnormal Review Agent exit preserves the review retry kind", async () => {
    const orch = makeOrchestrator();
    const issueId = "issue-review-crash";
    const ref = Symbol("ref");
    injectRunning(orch, issueId, {
      task: stoppableTask(),
      ref,
      identifier: "MT-REVIEW-CRASH",
      issue: newIssue({ id: issueId, identifier: "MT-REVIEW-CRASH", state: "Human Review" }),
      run_kind: "review",
      started_at: new Date(),
    });

    await orch.cast({ tag: "down", ref, reason: ":boom" });

    const retry = orch.getState().retry_attempts[issueId];
    expect(retry?.run_kind).toBe("review");
  });

  test("abnormal normal worker exit preserves a queued review intent", async () => {
    const orch = makeOrchestrator();
    const issueId = "issue-review-normal-crash";
    const ref = Symbol("ref");
    const issue = newIssue({
      id: issueId,
      identifier: "MT-REVIEW-NORMAL-CRASH",
      state: "Human Review",
      labels: ["symphony"],
    });
    injectRunning(orch, issueId, {
      task: stoppableTask(),
      ref,
      identifier: issue.identifier,
      issue: newIssue({ id: issueId, identifier: issue.identifier, state: "In Progress" }),
      run_kind: "normal",
      started_at: new Date(),
    });
    orch.replaceState((state) => ({
      ...state,
      review_queue: { [issueId]: { issue, enqueued_at: new Date() } },
    }));

    await orch.cast({ tag: "down", ref, reason: ":boom" });

    const state = orch.getState();
    expect(state.retry_attempts[issueId]?.run_kind).toBe("normal");
    expect(state.review_queue[issueId]?.issue.state).toBe("Human Review");
  });

  test("stalled normal worker cleanup preserves a queued review intent", async () => {
    const issueId = "issue-review-stalled";
    const issue = newIssue({
      id: issueId,
      identifier: "MT-REVIEW-STALLED",
      state: "Human Review",
      labels: ["symphony"],
    });
    writeWorkflowFile(workflowFilePath(), {
      tracker_kind: "memory",
      tracker_required_labels: ["symphony"],
      codex_stall_timeout_ms: 1,
    });
    putEnv("memory_tracker_issues", []);
    const orch = makeOrchestrator();
    const task = stoppableTask();
    injectRunning(orch, issueId, {
      task,
      ref: Symbol("stalled-ref"),
      identifier: issue.identifier,
      issue: newIssue({ id: issueId, identifier: issue.identifier, state: "In Progress" }),
      run_kind: "normal",
      started_at: new Date(Date.now() - 10_000),
    });
    orch.replaceState((state) => ({
      ...state,
      review_queue: { [issueId]: { issue, enqueued_at: new Date() } },
    }));

    await orch.cast({ tag: "tick", token: null });
    await waitFor(() => orch.getState().retry_attempts[issueId] !== undefined);

    const state = orch.getState();
    expect(issueId in state.running).toBe(false);
    expect(task.stopped).toBe(true);
    expect(state.retry_attempts[issueId]?.run_kind).toBe("normal");
    expect(state.review_queue[issueId]?.issue.state).toBe("Human Review");
  });

  test("stale retry timer messages do not consume newer retry entries", async () => {
    const orch = makeOrchestrator();
    const issueId = "issue-stale-retry";
    const currentRetryToken = Symbol("current");
    const staleRetryToken = Symbol("stale");
    orch.replaceState((state) => ({
      ...state,
      retry_attempts: {
        [issueId]: {
          attempt: 2,
          timer_ref: null,
          retry_token: currentRetryToken,
          due_at_ms: nowMs() + 30_000,
          identifier: "MT-561",
          error: "agent exited: :boom",
        },
      },
    }));

    await orch.cast({ tag: "retry_issue", issueId, retryToken: staleRetryToken });

    const retry = orch.getState().retry_attempts[issueId];
    expect(retry?.attempt).toBe(2);
    expect(retry?.retry_token).toBe(currentRetryToken);
    expect(retry?.identifier).toBe("MT-561");
    expect(retry?.error).toBe("agent exited: :boom");
  });

  test("manual refresh coalesces repeated requests and ignores superseded ticks", async () => {
    const orch = makeOrchestrator();
    const staleTickToken = Symbol("stale-tick");
    const state: State = {
      poll_interval_ms: 30_000,
      max_concurrent_agents: 1,
      next_poll_due_at_ms: nowMs() + 30_000,
      poll_check_in_progress: false,
      tick_timer_ref: null,
      tick_token: staleTickToken,
      running: {},
      completed: new Set(),
      claimed: new Set(),
      blocked: {},
      retry_attempts: {},
      review_queue: {},
      review_observed_states: {},
      codex_totals: { input_tokens: 0, output_tokens: 0, total_tokens: 0, seconds_running: 0 },
      codex_rate_limits: null,
    };

    const first = orch.handleRequestRefreshForTest(state);
    expect(first.reply.queued).toBe(true);
    expect(first.reply.coalesced).toBe(false);
    expect(first.state.tick_timer_ref).not.toBeNull();
    expect(typeof first.state.tick_token).toBe("symbol");
    expect(first.state.tick_token).not.toBe(staleTickToken);
    expect(first.state.next_poll_due_at_ms ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(
      nowMs(),
    );

    const second = orch.handleRequestRefreshForTest(first.state);
    expect(second.reply.queued).toBe(true);
    expect(second.reply.coalesced).toBe(true);
    expect(second.state.tick_token).toBe(first.state.tick_token);

    const afterStaleTick = await orch.handleTickInfoForTest(second.state, staleTickToken);
    expect(afterStaleTick).toBe(second.state);
  });

  test("Human Review status edge starts one Review Agent through the normal runner", async () => {
    const backend = blockingBackend();
    putEnv("agent_backend_overrides", { codex: backend.plugin });
    writeWorkflowFile(workflowFilePath(), {
      tracker_kind: "memory",
      tracker_required_labels: ["symphony"],
      workspace_root: path.join(root, "review-workspaces"),
    });
    const issue = newIssue({
      id: "issue-review-edge",
      identifier: "MT-REVIEW-EDGE",
      title: "Review edge",
      state: "Human Review",
      labels: ["symphony"],
    });
    putEnv("memory_tracker_issues", [issue]);
    const orch = makeOrchestrator();
    orch.replaceState((state) => ({
      ...state,
      review_observed_states: { "issue-review-edge": "in progress" },
    }));

    await orch.cast({ tag: "tick", token: null });
    await waitFor(() => backend.turns.length === 1);

    let state = orch.getState();
    expect(Object.keys(state.running)).toEqual(["issue-review-edge"]);
    expect(state.running["issue-review-edge"]?.run_kind).toBe("review");
    expect(state.running["issue-review-edge"]?.issue.state).toBe("Human Review");
    expect(Object.keys(state.review_queue)).toEqual([]);

    await orch.cast({ tag: "tick", token: null });
    await sleep(20);
    state = orch.getState();
    expect(Object.keys(state.running)).toEqual(["issue-review-edge"]);
    expect(backend.turns).toHaveLength(1);

    backend.resume();
    await waitFor(() => !("issue-review-edge" in orch.getState().running));
  });

  test("Human Review edge waits for the normal agent to release before dispatching one Review Agent", async () => {
    const backend = blockingBackend();
    const issueId = "issue-review-pending-release";
    const ref = Symbol("normal-ref");
    const issue = newIssue({
      id: issueId,
      identifier: "MT-REVIEW-PENDING",
      title: "Pending review release",
      state: "Human Review",
      labels: ["symphony"],
    });
    let runningRefreshFails = true;
    const tracker: TrackerPlugin = {
      id: "memory",
      displayName: "Review edge test tracker",
      fetchCandidateIssues: () => Promise.resolve(ok([])),
      fetchIssuesByStates: () => Promise.resolve(ok([issue])),
      fetchIssueStatesByIds: () =>
        runningRefreshFails
          ? Promise.resolve(
              err({
                tag: "temporary_tracker_failure",
                code: "transport_failed",
                message: "temporary tracker failure",
              }),
            )
          : Promise.resolve(ok([issue])),
    };
    putEnv("agent_backend_overrides", { codex: backend.plugin });
    putEnv("tracker_plugin_overrides", { memory: tracker });
    writeWorkflowFile(workflowFilePath(), {
      tracker_kind: "memory",
      tracker_required_labels: ["symphony"],
      workspace_root: path.join(root, "review-pending-workspaces"),
    });
    const orch = makeOrchestrator();
    orch.replaceState((state) => ({
      ...state,
      running: {
        [issueId]: {
          task: stoppableTask(),
          ref,
          identifier: issue.identifier,
          issue: newIssue({
            id: issueId,
            identifier: issue.identifier,
            title: issue.title,
            state: "In Progress",
            labels: ["symphony"],
          }),
          run_kind: "normal",
          started_at: new Date(),
        },
      },
      claimed: new Set([issueId]),
      review_observed_states: { [issueId]: "in progress" },
    }));

    await orch.cast({ tag: "tick", token: null });
    await waitFor(() => Object.keys(orch.getState().review_queue).length === 1);
    let state = orch.getState();
    expect(Object.keys(state.running)).toEqual([issueId]);
    expect(state.running[issueId]?.run_kind).toBe("normal");
    expect(Object.keys(state.review_queue)).toEqual([issueId]);
    expect(backend.turns).toHaveLength(0);

    await orch.cast({ tag: "down", ref, reason: "normal" });
    state = orch.getState();
    expect(issueId in state.running).toBe(false);
    expect(state.claimed.has(issueId)).toBe(false);
    expect(state.retry_attempts[issueId]).toBeUndefined();
    expect(Object.keys(state.review_queue)).toEqual([issueId]);

    runningRefreshFails = false;
    await orch.cast({ tag: "tick", token: null });
    await waitFor(() => backend.turns.length === 1);

    state = orch.getState();
    expect(Object.keys(state.running)).toEqual([issueId]);
    expect(state.running[issueId]?.run_kind).toBe("review");
    expect(Object.keys(state.review_queue)).toEqual([]);

    await orch.cast({ tag: "tick", token: null });
    await sleep(20);
    expect(backend.turns).toHaveLength(1);

    backend.resume();
    await waitFor(() => !(issueId in orch.getState().running));
  });

  test("blocked pending review does not dispatch until the block is released", async () => {
    const backend = blockingBackend();
    const issueId = "issue-review-blocked-dispatch";
    const issue = newIssue({
      id: issueId,
      identifier: "MT-REVIEW-BLOCKED-DISPATCH",
      title: "Blocked review dispatch",
      state: "Human Review",
      labels: ["symphony"],
    });
    putEnv("agent_backend_overrides", { codex: backend.plugin });
    putEnv("memory_tracker_issues", [issue]);
    writeWorkflowFile(workflowFilePath(), {
      tracker_kind: "memory",
      tracker_required_labels: ["symphony"],
    });
    const orch = makeOrchestrator();
    orch.replaceState((state) => ({
      ...state,
      claimed: new Set([issueId]),
      blocked: {
        [issueId]: {
          identifier: issue.identifier,
          issue,
          error: "operator input required",
          worker_host: null,
        },
      },
      review_queue: { [issueId]: { issue, enqueued_at: new Date() } },
    }));

    await orch.cast({ tag: "tick", token: null });
    await sleep(20);

    const state = orch.getState();
    expect(backend.turns).toHaveLength(0);
    expect(issueId in state.blocked).toBe(true);
    expect(state.review_queue[issueId]?.issue.state).toBe("Human Review");
  });

  test("review dispatch revalidation clears a stale pending review", async () => {
    const backend = blockingBackend();
    const issueId = "issue-review-stale";
    const queued = newIssue({
      id: issueId,
      identifier: "MT-REVIEW-STALE",
      title: "Stale review",
      state: "Human Review",
      labels: ["symphony"],
    });
    const refreshed = { ...queued, state: "Rework" };
    const tracker: TrackerPlugin = {
      id: "memory",
      displayName: "Stale review test tracker",
      fetchCandidateIssues: () => Promise.resolve(ok([])),
      fetchIssuesByStates: () => Promise.resolve(ok([queued])),
      fetchIssueStatesByIds: () => Promise.resolve(ok([refreshed])),
    };
    putEnv("agent_backend_overrides", { codex: backend.plugin });
    putEnv("tracker_plugin_overrides", { memory: tracker });
    writeWorkflowFile(workflowFilePath(), {
      tracker_kind: "memory",
      tracker_required_labels: ["symphony"],
    });
    const orch = makeOrchestrator();
    orch.replaceState((state) => ({
      ...state,
      review_queue: { [issueId]: { issue: queued, enqueued_at: new Date() } },
      review_observed_states: { [issueId]: "human review" },
    }));

    await orch.cast({ tag: "tick", token: null });
    await waitFor(() => Object.keys(orch.getState().review_queue).length === 0);

    expect(backend.turns).toHaveLength(0);
    expect(orch.getState().claimed.has(issueId)).toBe(false);
  });

  test("review retry restores the Review Agent path from retry state", async () => {
    const backend = blockingBackend();
    putEnv("agent_backend_overrides", { codex: backend.plugin });
    writeWorkflowFile(workflowFilePath(), {
      tracker_kind: "memory",
      tracker_required_labels: ["symphony"],
      workspace_root: path.join(root, "review-retry-workspaces"),
    });
    const issueId = "issue-review-retry";
    const issue = newIssue({
      id: issueId,
      identifier: "MT-REVIEW-RETRY",
      title: "Review retry",
      state: "Human Review",
      labels: ["symphony"],
    });
    putEnv("memory_tracker_issues", [issue]);
    const retryToken = Symbol("review-retry");
    const orch = makeOrchestrator();
    orch.replaceState((state) => ({
      ...state,
      claimed: new Set([issueId]),
      retry_attempts: {
        [issueId]: {
          attempt: 2,
          timer_ref: null,
          retry_token: retryToken,
          due_at_ms: nowMs(),
          identifier: issue.identifier,
          issue_url: issue.url,
          error: "agent exited: :boom",
          run_kind: "review",
        },
      },
    }));

    await orch.cast({ tag: "retry_issue", issueId, retryToken });
    await waitFor(() => backend.turns.length === 1);

    expect(orch.getState().running[issueId]?.run_kind).toBe("review");
    expect(orch.getState().retry_attempts[issueId]).toBeUndefined();

    backend.resume();
    await waitFor(() => !(issueId in orch.getState().running));
  });

  test("normal Review Agent completion releases the issue for future state polling", async () => {
    const orch = makeOrchestrator();
    const issueId = "issue-review-complete";
    const ref = Symbol("ref");
    injectRunning(orch, issueId, {
      task: stoppableTask(),
      ref,
      identifier: "MT-REVIEW-COMPLETE",
      issue: newIssue({ id: issueId, identifier: "MT-REVIEW-COMPLETE", state: "Human Review" }),
      run_kind: "review",
      started_at: new Date(),
    });

    await orch.cast({ tag: "down", ref, reason: "normal" });

    const state = orch.getState();
    expect(issueId in state.running).toBe(false);
    expect(state.claimed.has(issueId)).toBe(false);
    expect(issueId in state.retry_attempts).toBe(false);
    expect(state.completed.has(issueId)).toBe(true);
  });
});
