import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { putEnv } from "../../src/symphony/app-env.ts";
import { ok } from "../../src/symphony/result.ts";
import {
  type RetryEntry,
  type RunningEntry,
  type SnapshotData,
  formatSnapshotContentForTest,
} from "../../src/symphony/status-dashboard.ts";
import { setupWorkflow, teardownWorkflow } from "../support/test-support.ts";

const TERMINAL_COLUMNS = 115;
const SNAPSHOT_DIR = path.resolve(import.meta.dir, "../fixtures/status_dashboard_snapshots");

// Ported from test/support/snapshot_support.exs.
function normalizeContent(content: string): string {
  return `${content.replace(/\r\n/g, "\n").replace(/\n+$/g, "")}\n`;
}
const ESC_CHAR = String.fromCharCode(27);
const ESC_RE = new RegExp(ESC_CHAR, "g");
const ANSI_RE = new RegExp(`${ESC_CHAR}\\[[0-9;]*m`, "g");
function escapeAnsi(content: string): string {
  return content.replace(ESC_RE, "\\e");
}
function stripAnsi(content: string): string {
  return content.replace(ANSI_RE, "");
}
function evidenceMarkdown(raw: string): string {
  const plain = normalizeContent(stripAnsi(raw)).replace(/\n+$/g, "");
  return `\`\`\`text\n${plain}\n\`\`\`\n`;
}

function assertDashboardSnapshot(name: string, raw: string): void {
  const snapshotPath = path.join(SNAPSHOT_DIR, `${name}.snapshot.txt`);
  const evidencePath = path.join(SNAPSHOT_DIR, `${name}.evidence.md`);
  expect(normalizeContent(escapeAnsi(raw))).toBe(fs.readFileSync(snapshotPath, "utf8"));
  expect(normalizeContent(evidenceMarkdown(raw))).toBe(fs.readFileSync(evidencePath, "utf8"));
}

function runningEntry(overrides: Partial<RunningEntry>): RunningEntry {
  return {
    identifier: "MT-000",
    state: "running",
    session_id: "thread-1234567890",
    codex_app_server_pid: "4242",
    codex_total_tokens: 0,
    runtime_seconds: 0,
    turn_count: 1,
    last_codex_event: "notification",
    last_codex_message: turnStartedMessage(),
    ...overrides,
  };
}

function retryEntry(overrides: Partial<RetryEntry>): RetryEntry {
  return {
    issue_id: "issue-1",
    identifier: "MT-000",
    attempt: 1,
    due_in_ms: 1_000,
    error: "retry scheduled",
    ...overrides,
  };
}

function turnStartedMessage() {
  return {
    event: "notification",
    message: { method: "turn/started", params: { turn: { id: "turn-1" } } },
  };
}
function turnCompletedMessage(status: string) {
  return {
    event: "notification",
    message: { method: "turn/completed", params: { turn: { status } } },
  };
}
function execCommandMessage(command: string) {
  return {
    event: "notification",
    message: { method: "codex/event/exec_command_begin", params: { msg: { command } } },
  };
}
function agentMessageDelta(delta: string) {
  return {
    event: "notification",
    message: {
      method: "codex/event/agent_message_delta",
      params: { msg: { payload: { delta } } },
    },
  };
}
function tokenUsageMessage(input: number, output: number, total: number) {
  return {
    event: "notification",
    message: {
      method: "thread/tokenUsage/updated",
      params: {
        tokenUsage: { total: { inputTokens: input, outputTokens: output, totalTokens: total } },
      },
    },
  };
}

const render = (data: SnapshotData, tps: number): string =>
  formatSnapshotContentForTest(ok(data), tps, TERMINAL_COLUMNS);

describe("StatusDashboard snapshots", () => {
  let root: string;

  beforeEach(() => {
    ({ root } = setupWorkflow());
  });

  afterEach(() => {
    teardownWorkflow(root);
  });

  test("idle dashboard", () => {
    const data: SnapshotData = {
      running: [],
      retrying: [],
      codex_totals: { input_tokens: 0, output_tokens: 0, total_tokens: 0, seconds_running: 0 },
      rate_limits: null,
    };
    assertDashboardSnapshot("idle", render(data, 0.0));
  });

  test("idle dashboard with observability url", () => {
    putEnv("server_port_override", 4000);
    const data: SnapshotData = {
      running: [],
      retrying: [],
      codex_totals: { input_tokens: 0, output_tokens: 0, total_tokens: 0, seconds_running: 0 },
      rate_limits: null,
    };
    assertDashboardSnapshot("idle_with_dashboard_url", render(data, 0.0));
  });

  test("super busy dashboard", () => {
    const data: SnapshotData = {
      running: [
        runningEntry({
          identifier: "MT-101",
          codex_total_tokens: 120_450,
          runtime_seconds: 785,
          turn_count: 11,
          last_codex_event: "turn_completed",
          last_codex_message: turnCompletedMessage("completed"),
        }),
        runningEntry({
          identifier: "MT-102",
          session_id: "thread-abcdef1234567890",
          codex_app_server_pid: "5252",
          codex_total_tokens: 89_200,
          runtime_seconds: 412,
          turn_count: 4,
          last_codex_event: "codex/event/task_started",
          last_codex_message: execCommandMessage("mix test --cover"),
        }),
      ],
      retrying: [],
      codex_totals: {
        input_tokens: 250_000,
        output_tokens: 18_500,
        total_tokens: 268_500,
        seconds_running: 4_321,
      },
      rate_limits: {
        limit_id: "gpt-5",
        primary: { remaining: 12_345, limit: 20_000, reset_in_seconds: 30 },
        secondary: { remaining: 45, limit: 60, reset_in_seconds: 12 },
        credits: { has_credits: true, balance: 9_876.5 },
      },
    };
    assertDashboardSnapshot("super_busy", render(data, 1_842.7));
  });

  test("backoff queue pressure", () => {
    const data: SnapshotData = {
      running: [
        runningEntry({
          identifier: "MT-638",
          state: "retrying",
          codex_total_tokens: 14_200,
          runtime_seconds: 1_225,
          turn_count: 7,
          last_codex_event: "notification",
          last_codex_message: agentMessageDelta("waiting on rate-limit backoff window"),
        }),
      ],
      retrying: [
        retryEntry({
          identifier: "MT-450",
          attempt: 4,
          due_in_ms: 1_250,
          error: "rate limit exhausted",
        }),
        retryEntry({
          identifier: "MT-451",
          attempt: 2,
          due_in_ms: 3_900,
          error: "retrying after API timeout with jitter",
        }),
        retryEntry({
          identifier: "MT-452",
          attempt: 6,
          due_in_ms: 8_100,
          error: "worker crashed\nrestarting cleanly",
        }),
        retryEntry({
          identifier: "MT-453",
          attempt: 1,
          due_in_ms: 11_000,
          error: "fourth queued retry should also render after removing the top-three limit",
        }),
      ],
      codex_totals: {
        input_tokens: 18_000,
        output_tokens: 2_200,
        total_tokens: 20_200,
        seconds_running: 2_700,
      },
      rate_limits: {
        limit_id: "gpt-5",
        primary: { remaining: 0, limit: 20_000, reset_in_seconds: 95 },
        secondary: { remaining: 0, limit: 60, reset_in_seconds: 45 },
        credits: { has_credits: false },
      },
    };
    assertDashboardSnapshot("backoff_queue", render(data, 15.4));
  });

  test("backoff queue row escapes escaped newline sequences", () => {
    const data: SnapshotData = {
      running: [],
      retrying: [
        retryEntry({
          identifier: "MT-980",
          attempt: 1,
          due_in_ms: 1_500,
          error: "error with \\nnewline",
        }),
      ],
      codex_totals: { input_tokens: 0, output_tokens: 0, total_tokens: 0, seconds_running: 0 },
      rate_limits: null,
    };
    const rendered = render(data, 0.0);
    const lines = rendered.split("\n").filter((l) => l.includes("MT-980"));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("error=error with newline");
    expect(lines[0]).not.toContain("\\n");
  });

  test("unlimited credits variant", () => {
    const data: SnapshotData = {
      running: [
        runningEntry({
          identifier: "MT-777",
          state: "running",
          codex_total_tokens: 3_200,
          runtime_seconds: 75,
          turn_count: 7,
          last_codex_event: "codex/event/token_count",
          last_codex_message: tokenUsageMessage(90, 12, 102),
        }),
      ],
      retrying: [],
      codex_totals: { input_tokens: 90, output_tokens: 12, total_tokens: 102, seconds_running: 75 },
      rate_limits: {
        limit_id: "priority-tier",
        primary: { remaining: 100, limit: 100, reset_in_seconds: 1 },
        secondary: { remaining: 500, limit: 500, reset_in_seconds: 1 },
        credits: { unlimited: true },
      },
    };
    assertDashboardSnapshot("credits_unlimited", render(data, 42.0));
  });
});
