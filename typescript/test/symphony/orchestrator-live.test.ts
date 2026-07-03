import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { putEnv } from "../../src/symphony/app-env.ts";
import { newIssue } from "../../src/symphony/linear/issue.ts";
import {
  Orchestrator,
  type RunningEntry,
  type RunningTask,
  type State,
  nowMs,
} from "../../src/symphony/orchestrator.ts";
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
      tracker_active_states: ["Todo", "In Progress", "In Review"],
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

  test("snapshot timeout timers are released once the call settles", async () => {
    const orch = makeOrchestrator();
    const timers = (orch as unknown as { timers: Set<unknown> }).timers;
    const before = timers.size;

    for (let i = 0; i < 5; i++) {
      const snapshot = await orch.snapshot(5_000);
      expect(snapshot).not.toBe("timeout");
    }

    expect(timers.size).toBe(before);
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
});
