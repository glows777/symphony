import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AgentOutputStore } from "../../src/symphony/agent-output-store.ts";
import type { AgentMessage } from "../../src/symphony/plugins/agents/types.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function tempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "symphony-agent-output-"));
  roots.push(root);
  return root;
}

function message(overrides: Partial<AgentMessage> = {}): AgentMessage {
  return {
    event: "notification",
    timestamp: new Date("2026-07-28T12:34:56.000Z"),
    sessionId: "thread-1-turn-1",
    stream: "stdout",
    payload: { message: "Inspecting the workspace" },
    raw: '{"message":"Inspecting the workspace"}',
    ...overrides,
  };
}

describe("AgentOutputStore", () => {
  test("writes independently parseable raw JSONL with cursor reads and stream metadata", () => {
    const store = new AgentOutputStore({ root: tempRoot(), mode: "raw" });
    const run = store.startRun({
      issueId: "issue-2",
      issueIdentifier: "SYM-2",
      title: "Observability",
      backend: "codex",
      workerHost: null,
      runId: "provisional-run",
    });
    run.bindRunId("thread-1");
    run.record(message({ event: "session_started" }), 1, "Session started");
    run.record(message({ stream: "stderr", raw: "warning from tool" }), 1, "warning from tool");
    run.record(message({ event: "turn_completed", payload: { total: 3 } }), 1, "Turn completed");
    run.finish("completed");

    const metadata = store.latestRun("SYM-2");
    expect(metadata?.run_id).toBe("thread-1");
    expect(metadata?.path).toContain(`${path.sep}thread-1.jsonl`);
    expect(metadata?.backend).toBe("codex");
    expect(metadata?.status).toBe("completed");
    expect(metadata?.ended_at).toBeString();

    const lines = fs
      .readFileSync(metadata?.path ?? "", "utf8")
      .trim()
      .split("\n");
    const parsed = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(parsed.every((event) => typeof event.seq === "number")).toBe(true);
    expect(parsed.map((event) => event.seq)).toEqual([1, 2, 3, 4, 5]);
    expect(parsed.find((event) => event.stream === "stderr")).toMatchObject({
      event: "notification",
      stream: "stderr",
    });

    const tail = store.readIssueOutput("SYM-2", { limit: 2 });
    expect(tail.events.map((event) => event.seq)).toEqual([4, 5]);
    expect(tail.hasMore).toBe(true);
    const incremental = store.readIssueOutput("SYM-2", { limit: 2, after: 2 });
    expect(incremental.events.map((event) => event.seq)).toEqual([3, 4]);
    expect(incremental.nextCursor).toBe(4);
  });

  test("keeps transport failure reasons in normalized events", () => {
    const store = new AgentOutputStore({ root: tempRoot(), mode: "summary" });
    const run = store.startRun({
      issueId: "issue-3",
      issueIdentifier: "SYM-3",
      backend: "claude_code",
      workerHost: null,
      runId: "run-3",
    });
    run.record(
      {
        event: "turn_ended_with_error",
        timestamp: new Date(),
        reason: { tag: "port_exit", status: 1 },
      },
      1,
    );

    const event = store.readIssueOutput("SYM-3").events.find((item) => item.event === "port_exit");
    expect(event).toMatchObject({
      event: "port_exit",
      reason: { tag: "port_exit", status: 1 },
    });
    expect(event?.message).toContain("port_exit");
  });

  test("honors off, summary, and raw modes", () => {
    const off = new AgentOutputStore({ root: tempRoot(), mode: "off" });
    const offRun = off.startRun({
      issueId: "issue-off",
      issueIdentifier: "OFF-1",
      backend: "codex",
      workerHost: null,
    });
    offRun.record(message(), 1, "Summary");
    offRun.finish("completed");
    expect(off.latestRun("OFF-1")).toBeNull();

    const summary = new AgentOutputStore({ root: tempRoot(), mode: "summary" });
    const summaryRun = summary.startRun({
      issueId: "issue-summary",
      issueIdentifier: "SUM-1",
      backend: "claude_code",
      workerHost: null,
    });
    summaryRun.record(message(), 1, "Summary only");
    summaryRun.finish("completed");
    const summaryEvent = summary
      .readIssueOutput("SUM-1")
      .events.find((event) => event.event === "notification");
    expect(summaryEvent).toMatchObject({ message: "Summary only" });
    expect(summaryEvent?.payload).toBeUndefined();
    expect(summaryEvent?.raw).toBeUndefined();

    const raw = new AgentOutputStore({ root: tempRoot(), mode: "raw" });
    const rawRun = raw.startRun({
      issueId: "issue-raw",
      issueIdentifier: "RAW-1",
      backend: "claude_code",
      workerHost: null,
    });
    rawRun.record(message(), 1, "Summary");
    rawRun.finish("completed");
    const rawEvent = raw
      .readIssueOutput("RAW-1")
      .events.find((event) => event.event === "notification");
    expect(rawEvent?.payload).toEqual({ message: "Inspecting the workspace" });
    expect(rawEvent?.raw).toBe('{"message":"Inspecting the workspace"}');
  });

  test("marks payload truncation and stops at the file limit", () => {
    const store = new AgentOutputStore({
      root: tempRoot(),
      mode: "raw",
      maxEventBytes: 512,
      maxFileBytes: 1_700,
    });
    const run = store.startRun({
      issueId: "issue-limit",
      issueIdentifier: "LIM-1",
      backend: "codex",
      workerHost: null,
    });
    for (let index = 0; index < 12; index += 1) {
      run.record(
        message({ payload: { output: "x".repeat(2_000), index }, raw: "y".repeat(2_000) }),
        1,
        "Large event",
      );
    }
    run.finish("completed");

    const metadata = store.latestRun("LIM-1");
    expect(metadata?.size).toBeLessThanOrEqual(1_700);
    expect(metadata?.truncated).toBe(true);
    const lines = fs
      .readFileSync(metadata?.path ?? "", "utf8")
      .trim()
      .split("\n");
    expect(lines.every((line) => Buffer.byteLength(line, "utf8") + 1 <= 1_700)).toBe(true);
    expect(lines.some((line) => JSON.parse(line).event === "log_truncated")).toBe(true);
  });

  test("returns a stable corruption warning without throwing", () => {
    const root = tempRoot();
    const store = new AgentOutputStore({ root, mode: "raw" });
    const run = store.startRun({
      issueId: "issue-corrupt",
      issueIdentifier: "BAD-1",
      backend: "codex",
      workerHost: null,
      runId: "bad-run",
    });
    run.record(message(), 1, "Valid event");
    const pathName = run.metadata().path;
    fs.appendFileSync(pathName, "not-json\n");
    const result = store.readIssueOutput("BAD-1");
    expect(result.error).toEqual({
      code: "log_corrupt",
      message: "Some lines in the agent log were not valid JSON",
    });
    expect(result.events.length).toBeGreaterThan(0);
  });

  test("does not fail an agent run when the log root cannot be written", () => {
    const root = path.join(tempRoot(), "not-a-directory");
    fs.writeFileSync(root, "locked");
    const store = new AgentOutputStore({ root, mode: "raw" });
    const run = store.startRun({
      issueId: "issue-write-failure",
      issueIdentifier: "WRITE-1",
      backend: "codex",
      workerHost: null,
    });
    expect(() => {
      run.record(message(), 1, "Still running");
      run.finish("completed");
    }).not.toThrow();
  });
});
