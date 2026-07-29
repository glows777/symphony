import { describe, expect, test } from "bun:test";
import { mergeLiveOutput, mergeOutput, withTranscript } from "../../frontend/src/App.tsx";
import {
  hasThinkingSummary,
  isVisibleActivity,
  toolActivityLabel,
} from "../../frontend/src/components/RunTimeline.tsx";
import type {
  AgentOutputEvent,
  AgentOutputMessage,
  OutputPayload,
} from "../../frontend/src/lib/api.ts";

function output(overrides: Partial<OutputPayload> = {}): ReturnType<typeof withTranscript> {
  return withTranscript({
    events: [],
    messages: [],
    next_cursor: null,
    has_more: false,
    before_cursor: null,
    has_before: false,
    run: null,
    backend: "codex",
    run_id: "run-1",
    session_id: "session-1",
    ...overrides,
  });
}

function event(overrides: Partial<AgentOutputEvent>): AgentOutputEvent {
  return {
    seq: 1,
    at: "2026-07-29T00:00:00.000Z",
    issue_identifier: "SYM-5",
    backend: "codex",
    worker_host: "local",
    run_id: "run-1",
    session_id: "session-1",
    turn: 1,
    event: "notification",
    ...overrides,
  };
}

function message(overrides: Partial<AgentOutputMessage>): AgentOutputMessage {
  return {
    message_id: "msg-1",
    activity_id: "msg-1",
    activity_type: "assistant_message",
    activity_status: "streaming",
    issue_identifier: "SYM-5",
    backend: "codex",
    run_id: "run-1",
    session_id: "session-1",
    turn: 1,
    role: "assistant",
    content: "",
    status: "streaming",
    seq_start: 1,
    seq_end: 1,
    at: "2026-07-29T00:00:00.000Z",
    updated_at: "2026-07-29T00:00:00.000Z",
    ...overrides,
  };
}

describe("frontend transcript merge", () => {
  test("does not append a replayed live delta already covered by the snapshot", () => {
    const delta = event({
      seq: 2,
      chat_id: "msg-1",
      chat_phase: "delta",
      chat_delta: "Hello",
      activity_type: "assistant_message",
      activity_status: "streaming",
      activity_id: "msg-1",
    });
    const current = output({
      events: [delta],
      messages: [
        message({
          content: "Hello",
          seq_start: 2,
          seq_end: 2,
        }),
      ],
      next_cursor: 2,
    });

    const merged = mergeLiveOutput(current, delta);

    expect(merged.messages).toHaveLength(1);
    expect(merged.messages[0]?.content).toBe("Hello");
    expect(merged.events).toHaveLength(1);
  });

  test("merges a later page in chronological order", () => {
    const current = output({
      events: [event({ seq: 1 }), event({ seq: 2 })],
      messages: [
        message({ message_id: "msg-1", activity_id: "msg-1", seq_start: 1, seq_end: 1 }),
        message({ message_id: "msg-2", activity_id: "msg-2", seq_start: 2, seq_end: 2 }),
      ],
      next_cursor: 2,
      has_more: true,
    });
    const later = output({
      events: [event({ seq: 3 })],
      messages: [message({ message_id: "msg-3", activity_id: "msg-3", seq_start: 3, seq_end: 3 })],
      next_cursor: 3,
      has_more: false,
    });

    const merged = mergeOutput(current, later);

    expect(merged.events.map((item) => item.seq)).toEqual([1, 2, 3]);
    expect(merged.messages.map((item) => item.message_id)).toEqual(["msg-1", "msg-2", "msg-3"]);
    expect(merged.next_cursor).toBe(3);
    expect(merged.has_more).toBe(false);
  });

  test("merges live thinking and tool activities by backend activity fields", () => {
    let current = mergeLiveOutput(
      null,
      event({
        seq: 2,
        activity_type: "thinking",
        activity_status: "streaming",
        activity_id: "think-1",
        thinking_summary_delta: "Reading logs\n",
      }),
    );
    current = mergeLiveOutput(
      current,
      event({
        seq: 3,
        activity_type: "tool_call",
        activity_status: "streaming",
        activity_id: "cmd-1",
        tool_command: "bun test",
        tool_output_delta: "pass\n",
      }),
    );
    current = mergeLiveOutput(
      current,
      event({
        seq: 4,
        event: "turn_completed",
        activity_type: "system",
        activity_status: "completed",
      }),
    );

    expect(current.messages).toHaveLength(2);
    expect(current.messages[0]).toMatchObject({
      activity_id: "think-1",
      activity_type: "thinking",
      content: "Reading logs\n",
      status: "completed",
    });
    expect(current.messages[1]).toMatchObject({
      activity_id: "cmd-1",
      activity_type: "tool_call",
      tool_command: "bun test",
      tool_output: "pass\n",
      status: "completed",
    });
  });

  test("only marks thinking as collapsible when a summary exists", () => {
    expect(hasThinkingSummary(" \n")).toBe(false);
    expect(hasThinkingSummary("Checked the run state.")).toBe(true);
    expect(isVisibleActivity(message({ activity_type: "thinking", content: " \n" }))).toBe(false);
    expect(
      isVisibleActivity(message({ activity_type: "thinking", content: "Checked the run state." })),
    ).toBe(true);
  });

  test("recovers a tool command from a related raw event", () => {
    const tool = message({
      message_id: "cmd-2",
      activity_id: "cmd-2",
      activity_type: "tool_call",
      activity_status: "completed",
      status: "completed",
      seq_start: 7,
      seq_end: 7,
    });
    const related = event({
      seq: 7,
      activity_id: "cmd-2",
      raw: JSON.stringify({
        params: { command: "bun test test/frontend/app-transcript.test.tsx" },
      }),
    });

    expect(toolActivityLabel(tool, [related])).toBe(
      "Ran bun test test/frontend/app-transcript.test.tsx",
    );
  });

  test("reduces a legacy tool event summary to its tool name", () => {
    const tool = message({
      message_id: "cmd-3",
      activity_id: "cmd-3",
      activity_type: "tool_call",
      activity_status: "completed",
      status: "completed",
      seq_start: 8,
      seq_end: 8,
    });
    const related = event({
      seq: 8,
      activity_id: "cmd-3",
      message: "dynamic tool call requested (linear_graphql)",
    });

    expect(toolActivityLabel(tool, [related])).toBe("linear_graphql");
  });

  test("humanizes shell wrapper commands into a compact tool summary", () => {
    const tool = message({
      message_id: "cmd-4",
      activity_id: "cmd-4",
      activity_type: "tool_call",
      activity_status: "completed",
      status: "completed",
      seq_start: 9,
      seq_end: 9,
    });
    const related = event({
      seq: 9,
      activity_id: "cmd-4",
      raw: JSON.stringify({
        params: {
          command: "/bin/zsh -lc \"sed -n '1,20p' typescript/src/symphony/orchestrator.ts\"",
        },
      }),
    });

    expect(toolActivityLabel(tool, [related])).toBe("Read files");
  });
});
