import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  type CodexUpdate,
  Orchestrator,
  type RunningEntry,
  type RunningTask,
  type Snapshot,
  nowMs,
} from "../../src/symphony/orchestrator.ts";
import { newIssue } from "../../src/symphony/plugins/work-item.ts";
import { workflowFilePath } from "../../src/symphony/workflow.ts";
import { setupWorkflow, teardownWorkflow, writeWorkflowFile } from "../support/test-support.ts";

// Translated from the orchestrator-specific cases in orchestrator_status_test.exs
// (the status-dashboard rendering cases live in status-dashboard-snapshot.test.ts).
// The live GenServer becomes the `Orchestrator` class; `:sys.replace_state`
// becomes `replaceState`, `GenServer.call(:snapshot)` becomes `snapshot`, and
// `send(pid, msg)` becomes `cast`.

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

describe("Orchestrator status / live GenServer", () => {
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

  async function snap(orch: Orchestrator): Promise<Snapshot> {
    const result = await orch.snapshot(1_000);
    if (typeof result === "string") {
      throw new Error(`snapshot returned ${result}`);
    }
    return result;
  }

  async function waitForSnapshot(
    orch: Orchestrator,
    predicate: (s: Snapshot) => boolean,
    timeoutMs = 1_000,
  ): Promise<Snapshot> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const s = await snap(orch);
      if (predicate(s)) {
        return s;
      }
      if (Date.now() >= deadline) {
        throw new Error(`timed out waiting for snapshot: ${JSON.stringify(s.polling)}`);
      }
      await sleep(5);
    }
  }

  async function waitForState(
    orch: Orchestrator,
    predicate: (state: ReturnType<Orchestrator["getState"]>) => boolean,
    timeoutMs = 1_000,
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!predicate(orch.getState())) {
      if (Date.now() >= deadline) {
        throw new Error("timed out waiting for orchestrator state");
      }
      await sleep(5);
    }
  }

  function runningEntry(overrides: Partial<RunningEntry>): RunningEntry {
    return {
      task: stoppableTask(),
      ref: Symbol("ref"),
      identifier: "MT-0",
      issue: newIssue({}),
      session_id: null,
      turn_count: 0,
      last_codex_message: null,
      last_codex_timestamp: null,
      last_codex_event: null,
      codex_input_tokens: 0,
      codex_output_tokens: 0,
      codex_total_tokens: 0,
      codex_last_reported_input_tokens: 0,
      codex_last_reported_output_tokens: 0,
      codex_last_reported_total_tokens: 0,
      started_at: new Date(),
      ...overrides,
    };
  }

  function injectRunning(orch: Orchestrator, issueId: string, entry: RunningEntry): void {
    orch.replaceState((state) => ({
      ...state,
      running: { [issueId]: entry },
      claimed: new Set(state.claimed).add(issueId),
    }));
  }

  test("snapshot returns timeout when the mailbox is unresponsive", async () => {
    const orch = makeOrchestrator();
    orch.stallForTest(1_000);
    expect(await orch.snapshot(10)).toBe("timeout");
  });

  test("snapshot reflects last codex update and session id", async () => {
    const orch = makeOrchestrator();
    const issueId = "issue-snapshot";
    const issue = newIssue({
      id: issueId,
      identifier: "MT-188",
      title: "Snapshot test",
      state: "In Progress",
      url: "https://example.org/issues/MT-188",
    });
    injectRunning(orch, issueId, runningEntry({ identifier: issue.identifier, issue }));

    const now = new Date();
    await orch.cast({
      tag: "codex_worker_update",
      issueId,
      update: { event: "session_started", sessionId: "thread-live-turn-live", timestamp: now },
    });
    await orch.cast({
      tag: "codex_worker_update",
      issueId,
      update: { event: "notification", payload: { method: "some-event" }, timestamp: now },
    });

    const snapshot = await snap(orch);
    expect(snapshot.running).toHaveLength(1);
    const entry = snapshot.running[0];
    expect(entry?.issue_id).toBe(issueId);
    expect(entry?.issue_url).toBe("https://example.org/issues/MT-188");
    expect(entry?.session_id).toBe("thread-live-turn-live");
    expect(entry?.turn_count).toBe(1);
    expect(entry?.last_codex_timestamp).toEqual(now);
    expect(entry?.last_codex_message).toEqual({
      event: "notification",
      message: { method: "some-event" },
      timestamp: now,
    });
  });

  test("snapshot tracks codex thread totals and app-server pid", async () => {
    const orch = makeOrchestrator();
    const issueId = "issue-usage-snapshot";
    const ref = Symbol("ref");
    const issue = newIssue({
      id: issueId,
      identifier: "MT-201",
      state: "In Progress",
      url: "https://example.org/issues/MT-201",
    });
    injectRunning(orch, issueId, runningEntry({ ref, identifier: issue.identifier, issue }));

    const now = new Date();
    await orch.cast({
      tag: "codex_worker_update",
      issueId,
      update: { event: "session_started", sessionId: "thread-usage-turn-usage", timestamp: now },
    });
    await orch.cast({
      tag: "codex_worker_update",
      issueId,
      update: {
        event: "notification",
        payload: {
          method: "thread/tokenUsage/updated",
          params: { tokenUsage: { total: { inputTokens: 12, outputTokens: 4, totalTokens: 16 } } },
        },
        timestamp: now,
        codexAppServerPid: "4242",
      },
    });

    const snapshot = await snap(orch);
    const entry = snapshot.running[0];
    expect(entry?.codex_app_server_pid).toBe("4242");
    expect(entry?.codex_input_tokens).toBe(12);
    expect(entry?.codex_output_tokens).toBe(4);
    expect(entry?.codex_total_tokens).toBe(16);
    expect(entry?.turn_count).toBe(1);
    expect(Number.isInteger(entry?.runtime_seconds)).toBe(true);

    await orch.cast({ tag: "down", ref, reason: "normal" });
    const totals = orch.getState().codex_totals;
    expect(totals?.input_tokens).toBe(12);
    expect(totals?.output_tokens).toBe(4);
    expect(totals?.total_tokens).toBe(16);
    expect(Number.isInteger(totals?.seconds_running)).toBe(true);
  });

  test("snapshot tracks turn completed usage when present", async () => {
    const orch = makeOrchestrator();
    const issueId = "issue-turn-completed-usage";
    const ref = Symbol("ref");
    const issue = newIssue({ id: issueId, identifier: "MT-202", state: "In Progress" });
    injectRunning(orch, issueId, runningEntry({ ref, identifier: issue.identifier, issue }));

    await orch.cast({
      tag: "codex_worker_update",
      issueId,
      update: {
        event: "turn_completed",
        payload: {
          method: "turn/completed",
          usage: { input_tokens: "12", output_tokens: 4, total_tokens: 16 },
        },
        timestamp: new Date(),
      },
    });

    const snapshot = await snap(orch);
    const entry = snapshot.running[0];
    expect(entry?.codex_input_tokens).toBe(12);
    expect(entry?.codex_output_tokens).toBe(4);
    expect(entry?.codex_total_tokens).toBe(16);

    await orch.cast({ tag: "down", ref, reason: "normal" });
    const totals = orch.getState().codex_totals;
    expect(totals?.input_tokens).toBe(12);
    expect(totals?.output_tokens).toBe(4);
    expect(totals?.total_tokens).toBe(16);
  });

  test("snapshot tracks codex token-count cumulative usage payloads", async () => {
    const orch = makeOrchestrator();
    const issueId = "issue-token-count-snapshot";
    const ref = Symbol("ref");
    const issue = newIssue({ id: issueId, identifier: "MT-220", state: "In Progress" });
    injectRunning(orch, issueId, runningEntry({ ref, identifier: issue.identifier, issue }));

    const tokenCountUpdate = (usage: Record<string, unknown>): CodexUpdate => ({
      event: "notification",
      payload: {
        method: "codex/event/token_count",
        params: { msg: { type: "token_count", info: { total_token_usage: usage } } },
      },
      timestamp: new Date(),
    });

    await orch.cast({
      tag: "codex_worker_update",
      issueId,
      update: tokenCountUpdate({ input_tokens: "2", output_tokens: 2, total_tokens: 4 }),
    });
    await orch.cast({
      tag: "codex_worker_update",
      issueId,
      update: tokenCountUpdate({ prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }),
    });

    const snapshot = await snap(orch);
    const entry = snapshot.running[0];
    expect(entry?.codex_input_tokens).toBe(10);
    expect(entry?.codex_output_tokens).toBe(5);
    expect(entry?.codex_total_tokens).toBe(15);

    await orch.cast({ tag: "down", ref, reason: "normal" });
    const totals = orch.getState().codex_totals;
    expect(totals?.input_tokens).toBe(10);
    expect(totals?.output_tokens).toBe(5);
    expect(totals?.total_tokens).toBe(15);
  });

  test("snapshot tracks codex rate-limit payloads", async () => {
    const orch = makeOrchestrator();
    const issueId = "issue-rate-limit-snapshot";
    const issue = newIssue({ id: issueId, identifier: "MT-221", state: "In Progress" });
    injectRunning(orch, issueId, runningEntry({ identifier: issue.identifier, issue }));

    const rateLimits = {
      limit_id: "codex",
      primary: { remaining: 90, limit: 100 },
      secondary: null,
      credits: { has_credits: false, unlimited: false, balance: null },
    };

    await orch.cast({
      tag: "codex_worker_update",
      issueId,
      update: {
        event: "notification",
        payload: {
          method: "codex/event/token_count",
          params: {
            msg: { type: "event_msg", payload: { type: "token_count", rate_limits: rateLimits } },
          },
        },
        timestamp: new Date(),
      },
    });

    const snapshot = await snap(orch);
    expect(snapshot.rate_limits).toEqual(rateLimits);
  });

  test("token accounting prefers total_token_usage over last_token_usage", async () => {
    const orch = makeOrchestrator();
    const issueId = "issue-token-precedence";
    const issue = newIssue({ id: issueId, identifier: "MT-222", state: "In Progress" });
    injectRunning(orch, issueId, runningEntry({ identifier: issue.identifier, issue }));

    await orch.cast({
      tag: "codex_worker_update",
      issueId,
      update: {
        event: "notification",
        payload: {
          method: "codex/event/token_count",
          params: {
            msg: {
              type: "event_msg",
              payload: {
                type: "token_count",
                info: {
                  last_token_usage: { input_tokens: 2, output_tokens: 1, total_tokens: 3 },
                  total_token_usage: { input_tokens: 200, output_tokens: 100, total_tokens: 300 },
                },
              },
            },
          },
        },
        timestamp: new Date(),
      },
    });

    const snapshot = await snap(orch);
    const entry = snapshot.running[0];
    expect(entry?.codex_input_tokens).toBe(200);
    expect(entry?.codex_output_tokens).toBe(100);
    expect(entry?.codex_total_tokens).toBe(300);
  });

  test("token accounting accumulates monotonic thread token usage totals", async () => {
    const orch = makeOrchestrator();
    const issueId = "issue-thread-token-usage";
    const issue = newIssue({ id: issueId, identifier: "MT-223", state: "In Progress" });
    injectRunning(orch, issueId, runningEntry({ identifier: issue.identifier, issue }));

    for (const usage of [
      { input_tokens: 8, output_tokens: 3, total_tokens: 11 },
      { input_tokens: 10, output_tokens: 4, total_tokens: 14 },
    ]) {
      await orch.cast({
        tag: "codex_worker_update",
        issueId,
        update: {
          event: "notification",
          payload: {
            method: "thread/tokenUsage/updated",
            params: { tokenUsage: { total: usage } },
          },
          timestamp: new Date(),
        },
      });
    }

    const snapshot = await snap(orch);
    const entry = snapshot.running[0];
    expect(entry?.codex_input_tokens).toBe(10);
    expect(entry?.codex_output_tokens).toBe(4);
    expect(entry?.codex_total_tokens).toBe(14);
  });

  test("token accounting ignores last_token_usage without cumulative totals", async () => {
    const orch = makeOrchestrator();
    const issueId = "issue-last-token-ignored";
    const issue = newIssue({ id: issueId, identifier: "MT-224", state: "In Progress" });
    injectRunning(orch, issueId, runningEntry({ identifier: issue.identifier, issue }));

    await orch.cast({
      tag: "codex_worker_update",
      issueId,
      update: {
        event: "notification",
        payload: {
          method: "codex/event/token_count",
          params: {
            msg: {
              type: "event_msg",
              payload: {
                type: "token_count",
                info: { last_token_usage: { input_tokens: 8, output_tokens: 3, total_tokens: 11 } },
              },
            },
          },
        },
        timestamp: new Date(),
      },
    });

    const snapshot = await snap(orch);
    const entry = snapshot.running[0];
    expect(entry?.codex_input_tokens).toBe(0);
    expect(entry?.codex_output_tokens).toBe(0);
    expect(entry?.codex_total_tokens).toBe(0);
  });

  test("snapshot includes retry backoff entries", async () => {
    const orch = makeOrchestrator();
    orch.replaceState((state) => ({
      ...state,
      retry_attempts: {
        "mt-500": {
          attempt: 2,
          timer_ref: null,
          due_at_ms: nowMs() + 5_000,
          identifier: "MT-500",
          issue_url: "https://example.org/issues/MT-500",
          error: "agent exited: :boom",
        },
      },
    }));

    const snapshot = await snap(orch);
    expect(snapshot.retrying).toHaveLength(1);
    const retry = snapshot.retrying[0];
    expect(retry?.issue_id).toBe("mt-500");
    expect(retry?.attempt).toBe(2);
    expect(retry?.identifier).toBe("MT-500");
    expect(retry?.issue_url).toBe("https://example.org/issues/MT-500");
    expect(retry?.error).toBe("agent exited: :boom");
    expect(retry?.due_in_ms as number).toBeGreaterThan(0);
  });

  test("snapshot includes poll countdown and checking status", async () => {
    const orch = makeOrchestrator();
    orch.replaceState((state) => ({
      ...state,
      poll_interval_ms: 30_000,
      tick_timer_ref: null,
      tick_token: Symbol("tick"),
      next_poll_due_at_ms: nowMs() + 4_000,
      poll_check_in_progress: false,
    }));

    let snapshot = await snap(orch);
    expect(snapshot.polling?.checking).toBe(false);
    expect(snapshot.polling?.poll_interval_ms).toBe(30_000);
    const dueInMs = snapshot.polling?.next_poll_in_ms;
    expect(typeof dueInMs).toBe("number");
    expect(dueInMs as number).toBeGreaterThanOrEqual(0);
    expect(dueInMs as number).toBeLessThanOrEqual(4_000);

    orch.replaceState((state) => ({
      ...state,
      poll_check_in_progress: true,
      next_poll_due_at_ms: null,
    }));
    snapshot = await snap(orch);
    expect(snapshot.polling?.checking).toBe(true);
    expect(snapshot.polling?.next_poll_in_ms).toBeNull();
  });

  test("triggers an immediate poll cycle shortly after startup", async () => {
    writeWorkflowFile(workflowFilePath(), { tracker_api_token: null, poll_interval_ms: 5_000 });
    const orch = makeOrchestrator();
    await orch.start();

    await waitForSnapshot(orch, (s) => s.polling?.checking === true);
    const settled = await waitForSnapshot(
      orch,
      (s) =>
        s.polling?.checking === false &&
        typeof s.polling?.next_poll_in_ms === "number" &&
        s.polling?.next_poll_in_ms <= 5_000,
    );
    expect(settled.polling?.poll_interval_ms).toBe(5_000);
    expect(settled.polling?.next_poll_in_ms as number).toBeGreaterThanOrEqual(0);
  });

  test("poll cycle resets next refresh countdown after a check", async () => {
    writeWorkflowFile(workflowFilePath(), { tracker_api_token: null, poll_interval_ms: 50 });
    const orch = makeOrchestrator();
    orch.replaceState((state) => ({
      ...state,
      poll_interval_ms: 50,
      poll_check_in_progress: true,
      next_poll_due_at_ms: null,
    }));

    await orch.cast({ tag: "run_poll_cycle" });

    const snapshot = await waitForSnapshot(
      orch,
      (s) =>
        s.polling?.checking === false &&
        s.polling?.poll_interval_ms === 50 &&
        typeof s.polling?.next_poll_in_ms === "number" &&
        s.polling?.next_poll_in_ms <= 50,
    );
    expect(snapshot.polling?.next_poll_in_ms as number).toBeGreaterThanOrEqual(0);
  });

  test("restarts stalled workers with retry backoff", async () => {
    writeWorkflowFile(workflowFilePath(), {
      tracker_api_token: null,
      codex_stall_timeout_ms: 1_000,
    });
    const orch = makeOrchestrator();
    const issueId = "issue-stall";
    const staleAt = new Date(Date.now() - 5_000);
    const task = stoppableTask();
    injectRunning(
      orch,
      issueId,
      runningEntry({
        task,
        identifier: "MT-STALL",
        issue: newIssue({
          id: issueId,
          identifier: "MT-STALL",
          state: "In Progress",
          url: "https://example.org/issues/MT-STALL",
        }),
        session_id: "thread-stall-turn-stall",
        last_codex_timestamp: staleAt,
        last_codex_event: "notification",
        started_at: staleAt,
      }),
    );

    await orch.cast({ tag: "tick", token: null });
    await waitForState(orch, (s) => !(issueId in s.running));

    const state = orch.getState();
    expect(issueId in state.running).toBe(false);
    const retry = state.retry_attempts[issueId];
    expect(retry?.attempt).toBe(1);
    expect(retry?.identifier).toBe("MT-STALL");
    expect(retry?.issue_url).toBe("https://example.org/issues/MT-STALL");
    expect(String(retry?.error).startsWith("stalled for ")).toBe(true);
    const remaining = (retry?.due_at_ms ?? 0) - nowMs();
    expect(remaining).toBeGreaterThanOrEqual(9_500);
    expect(remaining).toBeLessThanOrEqual(10_500);
  });

  test("blocks stalled workers that are waiting on MCP elicitation", async () => {
    writeWorkflowFile(workflowFilePath(), {
      tracker_api_token: null,
      codex_stall_timeout_ms: 1_000,
    });
    const orch = makeOrchestrator();
    const issueId = "issue-mcp-elicitation-stall";
    const staleAt = new Date(Date.now() - 5_000);
    injectRunning(
      orch,
      issueId,
      runningEntry({
        identifier: "MT-MCP",
        issue: newIssue({
          id: issueId,
          identifier: "MT-MCP",
          state: "In Progress",
          url: "https://example.org/issues/MT-MCP",
        }),
        worker_host: "dm-dev2",
        workspace_path: "/workspaces/MT-MCP",
        session_id: "thread-mcp-turn-mcp",
        last_codex_message: {
          event: "notification",
          message: { method: "mcpServer/elicitation/request" },
          timestamp: staleAt,
        },
        last_codex_timestamp: staleAt,
        last_codex_event: "notification",
        started_at: staleAt,
      }),
    );

    await orch.cast({ tag: "tick", token: null });
    await waitForState(orch, (s) => issueId in s.blocked);

    const state = orch.getState();
    expect(issueId in state.running).toBe(false);
    expect(issueId in state.retry_attempts).toBe(false);
    expect(state.claimed.has(issueId)).toBe(true);
    const blocked = state.blocked[issueId];
    expect(blocked?.identifier).toBe("MT-MCP");
    expect(blocked?.error).toBe("codex MCP elicitation requires operator input");
    expect(blocked?.worker_host).toBe("dm-dev2");
    expect(blocked?.workspace_path).toBe("/workspaces/MT-MCP");

    const snapshot = await snap(orch);
    expect(snapshot.blocked).toHaveLength(1);
    expect(snapshot.blocked[0]?.identifier).toBe("MT-MCP");
    expect(snapshot.blocked[0]?.issue_url).toBe("https://example.org/issues/MT-MCP");
    expect(snapshot.blocked[0]?.error).toBe("codex MCP elicitation requires operator input");
  });

  test("blocks failed workers after app-server reports input required", async () => {
    writeWorkflowFile(workflowFilePath(), { tracker_api_token: null });
    const orch = makeOrchestrator();
    const issueId = "issue-input-required";
    const ref = Symbol("ref");
    const startedAt = new Date();
    injectRunning(
      orch,
      issueId,
      runningEntry({
        ref,
        identifier: "MT-INPUT",
        issue: newIssue({ id: issueId, identifier: "MT-INPUT", state: "In Progress" }),
        session_id: "thread-input-turn-input",
        last_codex_message: {
          event: "turn_input_required",
          message: { method: "mcpServer/elicitation/request" },
          timestamp: startedAt,
        },
        last_codex_timestamp: startedAt,
        last_codex_event: "turn_input_required",
        started_at: startedAt,
      }),
    );

    await orch.cast({ tag: "down", ref, reason: { shutdown: "input_required" } });

    const state = orch.getState();
    expect(issueId in state.running).toBe(false);
    expect(issueId in state.retry_attempts).toBe(false);
    expect(state.claimed.has(issueId)).toBe(true);
    expect(state.blocked[issueId]?.identifier).toBe("MT-INPUT");
    expect(state.blocked[issueId]?.error).toBe("codex turn requires operator input");
  });

  test("blocks normal worker exits after input required completion", async () => {
    writeWorkflowFile(workflowFilePath(), { tracker_api_token: null });
    const orch = makeOrchestrator();
    const issueId = "issue-input-required-normal";
    const ref = Symbol("ref");
    injectRunning(
      orch,
      issueId,
      runningEntry({
        ref,
        identifier: "MT-INPUT-NORMAL",
        issue: newIssue({ id: issueId, identifier: "MT-INPUT-NORMAL", state: "In Progress" }),
        session_id: "thread-input-normal",
        completion: { outcome: "input_required" },
      }),
    );

    await orch.cast({ tag: "down", ref, reason: "normal" });

    const state = orch.getState();
    expect(issueId in state.running).toBe(false);
    expect(issueId in state.retry_attempts).toBe(false);
    expect(state.completed.has(issueId)).toBe(false);
    expect(state.claimed.has(issueId)).toBe(true);
    expect(state.blocked[issueId]?.identifier).toBe("MT-INPUT-NORMAL");
    expect(state.blocked[issueId]?.error).toBe("codex turn requires operator input");
  });
});
