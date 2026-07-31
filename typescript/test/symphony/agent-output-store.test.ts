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
  test("normalizes and persists session display names", async () => {
    const root = tempRoot();
    const store = new AgentOutputStore({ root, mode: "raw" });
    const run = store.startRun({
      issueId: "issue-name",
      issueIdentifier: "SYM-NAME",
      title: "Issue title",
      displayName: "  检查 API\n 和   admin 同步状态  ",
      runKind: "review",
      backend: "codex",
      workerHost: null,
      runId: "name-run",
    });

    await run.finish("completed");

    expect(store.latestRun("SYM-NAME")?.display_name).toBe("检查 API");
    expect(store.latestRun("SYM-NAME")?.run_kind).toBe("review");
    const restarted = new AgentOutputStore({ root, mode: "raw" });
    expect(restarted.latestRun("SYM-NAME")?.display_name).toBe("检查 API");
    expect(restarted.latestRun("SYM-NAME")?.run_kind).toBe("review");
  });

  test("persists the prompt sent to the agent in run metadata", async () => {
    const root = tempRoot();
    const store = new AgentOutputStore({ root, mode: "summary" });
    const run = store.startRun({
      issueId: "issue-prompt",
      issueIdentifier: "SYM-PROMPT",
      title: "Prompt issue",
      backend: "codex",
      workerHost: null,
      runId: "prompt-run",
    });

    run.bindRunId("prompt-session");
    run.setPrompt("Review the issue and report actionable findings.");
    await run.finish("completed");

    expect(store.latestRun("SYM-PROMPT")?.prompt).toBe(
      "Review the issue and report actionable findings.",
    );
    expect(store.readIssueOutput("SYM-PROMPT").run?.prompt).toBe(
      "Review the issue and report actionable findings.",
    );

    const restarted = new AgentOutputStore({ root, mode: "summary" });
    expect(restarted.latestRun("SYM-PROMPT")?.prompt).toBe(
      "Review the issue and report actionable findings.",
    );
  });

  test("writes independently parseable raw JSONL with cursor reads and stream metadata", async () => {
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
    await run.finish("completed");

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
    expect(tail.beforeCursor).toBe(4);
    expect(tail.hasBefore).toBe(true);
    const earlier = store.readIssueOutput("SYM-2", { limit: 2, before: 4 });
    expect(earlier.events.map((event) => event.seq)).toEqual([2, 3]);
    expect(earlier.beforeCursor).toBe(2);
    expect(earlier.hasBefore).toBe(true);
    const oldest = store.readIssueOutput("SYM-2", { limit: 2, before: 2 });
    expect(oldest.events.map((event) => event.seq)).toEqual([1]);
    expect(oldest.hasBefore).toBe(false);
    const incremental = store.readIssueOutput("SYM-2", { limit: 2, after: 2 });
    expect(incremental.events.map((event) => event.seq)).toEqual([3, 4]);
    expect(incremental.nextCursor).toBe(4);
  });

  test("keeps transport failure reasons in normalized events", async () => {
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
    expect(event).toMatchObject({ event: "port_exit", reason: { tag: "port_exit" } });
    expect((event?.reason as Record<string, unknown>)?.status).toBeUndefined();
    expect(event?.message).toContain("port_exit");
    await run.finish("failed", { tag: "port_exit", status: 1 });
  });

  test("keeps agent cancellation stop reasons in summary terminal events", async () => {
    const store = new AgentOutputStore({ root: tempRoot(), mode: "summary" });
    const run = store.startRun({
      issueId: "issue-cancel",
      issueIdentifier: "SYM-CANCEL",
      backend: "codex",
      workerHost: null,
      runId: "run-cancel",
    });

    await run.finish("cancelled", {
      tag: "agent_run_cancelled",
      reason: "issue_stalled",
      session_id: "thread-stall-turn-stall",
      elapsed_ms: 5019,
      cause: { tag: "port_exit", status: 143 },
    });

    const terminal = store
      .readIssueOutput("SYM-CANCEL")
      .events.find((event) => event.event === "run_cancelled");
    expect(terminal?.reason).toMatchObject({
      tag: "agent_run_cancelled",
      reason: "issue_stalled",
      session_id: "thread-stall-turn-stall",
      elapsed_ms: "5019",
      cause_tag: "port_exit",
      cause_status: "143",
    });
  });

  test("keeps the live run object authoritative after an output read", async () => {
    const store = new AgentOutputStore({ root: tempRoot(), mode: "raw" });
    const run = store.startRun({
      issueId: "issue-live",
      issueIdentifier: "LIVE-1",
      backend: "codex",
      workerHost: null,
      runId: "live-run",
    });
    run.record(message(), 1, "Still running");

    expect(store.readIssueOutput("LIVE-1").events.length).toBeGreaterThan(0);
    await run.finish("completed");

    expect(store.latestRun("LIVE-1")?.status).toBe("completed");
  });

  test("honors off, summary, and raw modes", async () => {
    const off = new AgentOutputStore({ root: tempRoot(), mode: "off" });
    const offRun = off.startRun({
      issueId: "issue-off",
      issueIdentifier: "OFF-1",
      backend: "codex",
      workerHost: null,
    });
    offRun.record(message(), 1, "Summary");
    await offRun.finish("completed");
    expect(off.latestRun("OFF-1")).toBeNull();

    const summary = new AgentOutputStore({ root: tempRoot(), mode: "summary" });
    const summaryRun = summary.startRun({
      issueId: "issue-summary",
      issueIdentifier: "SUM-1",
      backend: "claude_code",
      workerHost: null,
    });
    summaryRun.record(message(), 1, "Summary only");
    await summaryRun.finish("completed");
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
    await rawRun.finish("completed");
    const rawEvent = raw
      .readIssueOutput("RAW-1")
      .events.find((event) => event.event === "notification");
    expect(rawEvent?.payload).toEqual({ message: "Inspecting the workspace" });
    expect(rawEvent?.raw).toBe('{"message":"Inspecting the workspace"}');
  });

  test("projects exact assistant deltas into one streaming transcript message", async () => {
    const store = new AgentOutputStore({ root: tempRoot(), mode: "summary" });
    const run = store.startRun({
      issueId: "issue-transcript",
      issueIdentifier: "TRANSCRIPT-1",
      backend: "codex",
      workerHost: null,
      runId: "transcript-run",
    });
    run.record(
      message({
        payload: {
          method: "item/started",
          params: { item: { id: "msg-1", type: "agentMessage" } },
        },
      }),
      1,
      "item started: agent message (msg-1)",
    );
    run.record(
      message({
        payload: {
          method: "item/agentMessage/delta",
          params: { itemId: "msg-1", delta: "Hello\n" },
        },
      }),
      1,
      "agent message streaming: Hello",
    );
    run.record(
      message({
        payload: {
          method: "item/agentMessage/delta",
          params: { itemId: "msg-1", delta: " world  " },
        },
      }),
      1,
      "agent message streaming: world",
    );

    const streaming = store.readIssueOutput("TRANSCRIPT-1");
    expect(streaming.messages).toHaveLength(1);
    expect(streaming.messages[0]).toMatchObject({
      message_id: "msg-1",
      activity_id: "msg-1",
      activity_type: "assistant_message",
      activity_status: "streaming",
      content: "Hello\n world  ",
      status: "streaming",
    });
    const deltaEvent = streaming.events.find((event) => event.chat_delta === "Hello\n");
    expect(deltaEvent).toMatchObject({
      activity_type: "assistant_message",
      activity_status: "streaming",
      activity_id: "msg-1",
    });
    expect(deltaEvent?.payload).toBeUndefined();

    run.record(
      message({
        payload: {
          method: "item/completed",
          params: { item: { id: "msg-1", type: "agentMessage" } },
        },
      }),
      1,
      "item completed: agent message (msg-1)",
    );
    await run.finish("completed");

    expect(store.readIssueOutput("TRANSCRIPT-1").messages[0]?.status).toBe("completed");
  });

  test("aggregates legacy assistant summaries with streaming deltas", async () => {
    const store = new AgentOutputStore({ root: tempRoot(), mode: "summary" });
    const run = store.startRun({
      issueId: "issue-legacy-transcript",
      issueIdentifier: "TRANSCRIPT-LEGACY",
      backend: "codex",
      workerHost: null,
      runId: "legacy-transcript-run",
    });
    const legacyMessage = (): AgentMessage => message({ payload: {}, raw: "{}" });

    run.record(legacyMessage(), 1, "item started: agent message (msg-1)");
    run.record(legacyMessage(), 1, "agent message streaming: Hello");
    run.record(legacyMessage(), 1, "agent message streaming: world");

    const streaming = store.readIssueOutput("TRANSCRIPT-LEGACY");
    expect(streaming.messages).toHaveLength(1);
    expect(streaming.messages[0]).toMatchObject({
      message_id: "msg-1",
      activity_id: "msg-1",
      activity_type: "assistant_message",
      activity_status: "streaming",
      content: "Helloworld",
      status: "streaming",
    });

    run.record(legacyMessage(), 1, "item completed: agent message (msg-1)");
    await run.finish("completed");

    const completed = store.readIssueOutput("TRANSCRIPT-LEGACY");
    expect(completed.messages).toHaveLength(1);
    expect(completed.messages[0]).toMatchObject({
      message_id: "msg-1",
      activity_id: "msg-1",
      content: "Helloworld",
      status: "completed",
      activity_status: "completed",
    });
  });

  test("closes streaming assistant messages when the turn ends without item completion", async () => {
    const store = new AgentOutputStore({ root: tempRoot(), mode: "raw" });
    const run = store.startRun({
      issueId: "issue-transcript-close",
      issueIdentifier: "TRANSCRIPT-2",
      backend: "codex",
      workerHost: null,
      runId: "transcript-close-run",
    });
    run.record(
      message({
        payload: {
          method: "item/started",
          params: { item: { id: "msg-open", type: "agentMessage" } },
        },
      }),
      1,
      "item started: agent message (msg-open)",
    );
    run.record(
      message({
        payload: {
          method: "item/agentMessage/delta",
          params: { itemId: "msg-open", delta: "Still exact  text\n" },
        },
      }),
      1,
      "agent message streaming",
    );
    run.record(message({ event: "turn_completed", payload: { method: "turn/completed" } }), 1);

    const result = store.readIssueOutput("TRANSCRIPT-2");
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]).toMatchObject({
      message_id: "msg-open",
      content: "Still exact  text\n",
      status: "completed",
      activity_status: "completed",
    });
    await run.finish("completed");
  });

  test("projects reasoning summaries and tool calls without exposing hidden reasoning text", async () => {
    const store = new AgentOutputStore({ root: tempRoot(), mode: "raw" });
    const run = store.startRun({
      issueId: "issue-activities",
      issueIdentifier: "ACT-1",
      backend: "codex",
      workerHost: null,
      runId: "activity-run",
    });
    run.record(
      message({
        payload: {
          method: "item/reasoning/textDelta",
          params: { itemId: "think-1", textDelta: "do not show this" },
        },
      }),
      1,
      "reasoning text streaming",
    );
    run.record(
      message({
        payload: {
          method: "item/reasoning/summaryTextDelta",
          params: { itemId: "think-1", summaryTextDelta: "Checked constraints.\n" },
        },
      }),
      1,
      "reasoning summary streaming",
    );
    run.record(
      message({
        payload: {
          method: "item/commandExecution/outputDelta",
          params: { itemId: "cmd-1", command: "bun test", outputDelta: "pass  one\n" },
        },
      }),
      1,
      "command output streaming",
    );
    run.record(
      message({
        event: "tool_call_failed",
        reason: { message: "tool exploded" },
        payload: {
          method: "item/tool/call",
          params: { itemId: "tool-1", name: "linear_graphql", arguments: { query: "bad" } },
        },
      }),
      1,
      "tool failed",
    );
    run.record(message({ event: "turn_completed", payload: { method: "turn/completed" } }), 1);

    const result = store.readIssueOutput("ACT-1");
    const hiddenEvent = result.events.find(
      (event) =>
        event.activity_type === "thinking" &&
        event.payload !== undefined &&
        (event.payload as { method?: string }).method === "item/reasoning/textDelta",
    );
    expect(hiddenEvent).toMatchObject({ activity_type: "thinking", activity_id: "think-1" });
    expect(hiddenEvent?.thinking_summary_delta).toBeUndefined();

    const thinking = result.messages.find((item) => item.activity_type === "thinking");
    expect(thinking).toMatchObject({
      activity_id: "think-1",
      content: "Checked constraints.\n",
      status: "completed",
    });
    expect(thinking?.content).not.toContain("do not show this");

    const command = result.messages.find((item) => item.activity_id === "cmd-1");
    expect(command).toMatchObject({
      activity_type: "tool_call",
      tool_command: "bun test",
      tool_output: "pass  one\n",
      status: "completed",
    });

    const failed = result.messages.find((item) => item.activity_id === "tool-1");
    expect(failed).toMatchObject({
      activity_type: "tool_call",
      status: "failed",
      tool_name: "linear_graphql",
      tool_input: { query: "bad" },
      tool_error: "tool exploded",
    });
    await run.finish("completed");
  });

  test("keeps tool metadata when replaying summary-mode events", async () => {
    const store = new AgentOutputStore({ root: tempRoot(), mode: "summary" });
    const run = store.startRun({
      issueId: "issue-summary-tool",
      issueIdentifier: "ACT-SUMMARY",
      backend: "codex",
      workerHost: null,
      runId: "summary-tool-run",
    });
    run.record(
      message({
        payload: {
          method: "item/commandExecution/outputDelta",
          params: {
            itemId: "cmd-summary",
            command: "git status --short",
            outputDelta: " M file.ts\n",
          },
        },
      }),
      1,
      "command output streaming",
    );
    run.record(
      message({
        payload: {
          method: "item/tool/call",
          params: {
            itemId: "tool-summary",
            name: "linear_graphql",
            arguments: { query: "query Issue { id }" },
          },
        },
      }),
      1,
      "tool call completed",
    );
    await run.finish("completed");

    const result = store.readIssueOutput("ACT-SUMMARY");
    expect(result.messages.find((item) => item.activity_id === "cmd-summary")).toMatchObject({
      activity_type: "tool_call",
      tool_command: "git status --short",
      tool_output: " M file.ts\n",
    });
    expect(result.messages.find((item) => item.activity_id === "tool-summary")).toMatchObject({
      activity_type: "tool_call",
      tool_name: "linear_graphql",
      tool_input: { query: "query Issue { id }" },
    });
  });

  test("preserves protocol tool names for command and file activities", async () => {
    const store = new AgentOutputStore({ root: tempRoot(), mode: "summary" });
    const run = store.startRun({
      issueId: "issue-protocol-tools",
      issueIdentifier: "ACT-PROTOCOL-TOOLS",
      backend: "codex",
      workerHost: null,
      runId: "protocol-tools-run",
    });
    run.record(
      message({
        payload: {
          method: "item/started",
          params: { item: { id: "file-1", type: "fileChange" } },
        },
      }),
      1,
      "item started: file change (file-1, inprogress)",
    );
    run.record(
      message({
        payload: {
          method: "item/commandExecution/outputDelta",
          params: {
            itemId: "command-1",
            command: "git status --short",
            outputDelta: " M file.ts\n",
          },
        },
      }),
      1,
      "command output streaming",
    );
    run.record(
      message({
        payload: {
          method: "item/completed",
          params: { item: { id: "file-1", type: "fileChange", status: "completed" } },
        },
      }),
      1,
      "item completed: file change (file-1, completed)",
    );

    const result = store.readIssueOutput("ACT-PROTOCOL-TOOLS");
    expect(result.events.filter((event) => event.activity_type === "tool_call")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ activity_id: "file-1", tool_name: "fileChange" }),
        expect.objectContaining({ activity_id: "command-1", tool_name: "commandExecution" }),
      ]),
    );
    expect(result.messages.find((item) => item.activity_id === "file-1")).toMatchObject({
      activity_type: "tool_call",
      tool_name: "fileChange",
    });
    expect(result.messages.find((item) => item.activity_id === "command-1")).toMatchObject({
      activity_type: "tool_call",
      tool_name: "commandExecution",
      tool_command: "git status --short",
    });
    await run.finish("completed");
  });

  test("keeps one store live across output configuration changes", async () => {
    const firstRoot = tempRoot();
    const secondRoot = tempRoot();
    const store = new AgentOutputStore({ root: firstRoot, mode: "raw" });
    const first = store.startRun({
      issueId: "issue-config",
      issueIdentifier: "CFG-1",
      backend: "codex",
      workerHost: null,
      runId: "first-run",
    });
    first.record(message(), 1, "First");
    await first.finish("completed");

    await Bun.sleep(1);
    store.reconfigure({ root: secondRoot, mode: "summary" });
    const second = store.startRun({
      issueId: "issue-config",
      issueIdentifier: "CFG-1",
      backend: "codex",
      workerHost: null,
      runId: "second-run",
    });
    second.record(message(), 1, "Second");
    await second.finish("completed");

    expect(store.listRecentRuns(10).map((run) => run.run_id)).toEqual(["second-run", "first-run"]);
    expect(store.readIssueOutput("CFG-1").run?.run_id).toBe("second-run");
  });

  test("allocates duplicate run ids before asynchronous writes flush", async () => {
    const store = new AgentOutputStore({ root: tempRoot(), mode: "raw" });
    const first = store.startRun({
      issueId: "issue-duplicate",
      issueIdentifier: "DUP-1",
      backend: "codex",
      workerHost: null,
      runId: "same-run",
    });
    const second = store.startRun({
      issueId: "issue-duplicate",
      issueIdentifier: "DUP-1",
      backend: "codex",
      workerHost: null,
      runId: "same-run",
    });

    first.record(message(), 1, "First");
    second.record(message(), 1, "Second");
    await Promise.all([first.finish("completed"), second.finish("completed")]);

    expect(first.metadata().run_id).toBe("same-run");
    expect(second.metadata().run_id).toBe("same-run-2");
    expect(store.listRecentRuns(10).map((run) => run.run_id)).toEqual(
      expect.arrayContaining(["same-run", "same-run-2"]),
    );
  });

  test("batches burst output writes instead of truncating at an event-count limit", async () => {
    const store = new AgentOutputStore({
      root: tempRoot(),
      mode: "summary",
      maxFileBytes: 4 * 1024 * 1024,
    });
    const run = store.startRun({
      issueId: "issue-burst",
      issueIdentifier: "BURST-1",
      backend: "codex",
      workerHost: null,
      runId: "burst-run",
    });
    const eventCount = 512;

    for (let index = 0; index < eventCount; index += 1) {
      run.record(message({ payload: { message: `stream chunk ${index}` } }), 1, `Chunk ${index}`);
    }
    await run.finish("completed");

    const metadata = store.latestRun("BURST-1");
    expect(metadata?.truncated).toBe(false);
    const events = fs
      .readFileSync(metadata?.path ?? "", "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { seq: number; event: string });
    expect(events).toHaveLength(eventCount + 2);
    expect(events.map((event) => event.seq)).toEqual(
      Array.from({ length: eventCount + 2 }, (_, index) => index + 1),
    );
    expect(events.at(-1)?.event).toBe("run_completed");
  });

  test("marks payload truncation and stops at the file limit", async () => {
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
    await run.finish("completed");

    const metadata = store.latestRun("LIM-1");
    expect(metadata?.size).toBeLessThanOrEqual(1_700);
    expect(metadata?.truncated).toBe(true);
    const lines = fs
      .readFileSync(metadata?.path ?? "", "utf8")
      .trim()
      .split("\n");
    expect(lines.every((line) => Buffer.byteLength(line, "utf8") + 1 <= 1_700)).toBe(true);
    expect(lines.some((line) => JSON.parse(line).event === "log_truncated")).toBe(true);

    const restarted = new AgentOutputStore({
      root: path.dirname(path.dirname(path.dirname(path.dirname(metadata?.path ?? "")))),
      mode: "raw",
      maxEventBytes: 512,
      maxFileBytes: 1_700,
    });
    expect(restarted.latestRun("LIM-1")?.status).toBe("completed");
  });

  test("returns a stable corruption warning without throwing", async () => {
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
    await run.finish("completed");
    const pathName = run.metadata().path;
    fs.appendFileSync(pathName, "not-json\n");
    const result = store.readIssueOutput("BAD-1");
    expect(result.error).toEqual({
      code: "log_corrupt",
      message: "Some lines in the agent log were not valid JSON",
    });
    expect(result.events.length).toBeGreaterThan(0);
  });

  test("does not fail an agent run when the log root cannot be written", async () => {
    const root = path.join(tempRoot(), "not-a-directory");
    fs.writeFileSync(root, "locked");
    const store = new AgentOutputStore({ root, mode: "raw" });
    const run = store.startRun({
      issueId: "issue-write-failure",
      issueIdentifier: "WRITE-1",
      backend: "codex",
      workerHost: null,
    });
    await expect(async () => {
      run.record(message(), 1, "Still running");
      await run.finish("completed");
    }).not.toThrow();
  });
});
