import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
// Side-effect import registers the built-in backends before the plugin module is
// used as a test entry, so config <-> plugins ESM resolution completes cleanly in
// isolation (mirrors registry.test.ts).
import "../../../../src/symphony/plugins/agents/index.ts";
import { ClaudeCodePlugin } from "../../../../src/symphony/plugins/agents/claude-code/plugin.ts";
import type {
  AgentMessage,
  IssueLike,
  ToolProvider,
} from "../../../../src/symphony/plugins/agents/types.ts";
import { workflowFilePath } from "../../../../src/symphony/workflow.ts";
import {
  setupWorkflow,
  teardownWorkflow,
  writeWorkflowFile,
} from "../../../support/test-support.ts";

// Drives the full plugin session API (startSession -> runTurn -> stopSession)
// against the scenario-driven fake claude CLI (test/harness/fake-claude.ts),
// which reproduces the stream-json shapes verified live against claude 2.1.218.
// No real CLI, no network.

const fakeClaudePath = path.resolve(import.meta.dir, "../../../harness/fake-claude.ts");

type Action = Record<string, unknown>;
type Scenario = { sessionId?: string; turns: { actions: Action[] }[] };

const issue = (identifier: string): IssueLike => ({
  id: `issue-${identifier}`,
  identifier,
  title: `Title ${identifier}`,
});

const turnContext = (identifier: string, turnNumber = 1) => ({
  issue: issue(identifier),
  turnNumber,
  maxTurns: 3,
});

describe("Plugins.Agents.ClaudeCodePlugin", () => {
  let workflowRoot: string;
  let testRoot: string;
  let workspaceRoot: string;
  let scenarioFile: string;

  beforeEach(() => {
    ({ root: workflowRoot } = setupWorkflow());
    testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "symphony-claude-plugin-"));
    workspaceRoot = path.join(testRoot, "workspaces");
    scenarioFile = path.join(testRoot, "scenario.json");
    fs.mkdirSync(workspaceRoot, { recursive: true });
  });

  afterEach(() => {
    teardownWorkflow(workflowRoot);
    fs.rmSync(testRoot, { recursive: true, force: true });
  });

  // Writes the scenario and a WORKFLOW.md whose claude_code.command spawns the
  // fake via `bun <fake> <scenario>`. process.execPath (the bun binary) is used
  // verbatim so bash -lc need not resolve `bun` on a login-shell PATH.
  function installClaude(scenario: Scenario, ccOverrides: Record<string, unknown> = {}): void {
    fs.writeFileSync(scenarioFile, JSON.stringify(scenario));
    writeWorkflowFile(workflowFilePath(), {
      workspace_root: workspaceRoot,
      agent_backend: "claude_code",
      claude_code: {
        command: `${process.execPath} ${fakeClaudePath} ${scenarioFile}`,
        permission_mode: "bypass",
        turn_timeout_ms: 5_000,
        read_timeout_ms: 5_000,
        ...ccOverrides,
      },
    });
  }

  function workspaceFor(identifier: string): string {
    const ws = path.join(workspaceRoot, identifier);
    fs.mkdirSync(ws, { recursive: true });
    return ws;
  }

  async function start(workspace: string, opts: Record<string, unknown> = {}) {
    const messages: AgentMessage[] = [];
    const started = await ClaudeCodePlugin.sessions.startSession(workspace, {
      onMessage: (message) => messages.push(message),
      ...opts,
    });
    return { started, messages };
  }

  test("runs a start -> turn -> stop lifecycle and reports the backend pid", async () => {
    installClaude({
      sessionId: "sess-A",
      turns: [
        {
          actions: [
            { t: "init" },
            { t: "assistant", text: "on it" },
            { t: "result", subtype: "success", usage: { input_tokens: 10, output_tokens: 5 } },
          ],
        },
      ],
    });
    const workspace = workspaceFor("CC-1");

    const { started, messages } = await start(workspace);
    expect(started.ok).toBe(true);
    if (!started.ok) {
      return;
    }
    const session = started.value;
    expect(session.backendId).toBe("claude_code");
    expect(session.workspace).toBe(path.resolve(workspace));
    expect(session.workerHost).toBeNull();
    expect(typeof session.backendPid).toBe("string");

    const turn = await ClaudeCodePlugin.sessions.runTurn(
      session,
      "do the work",
      turnContext("CC-1"),
    );
    ClaudeCodePlugin.sessions.stopSession(session);

    expect(turn.ok).toBe(true);
    if (turn.ok) {
      expect(turn.value.sessionId).toBe("sess-A-1");
    }
    const sessionStarted = messages.find((m) => m.event === "session_started");
    expect(sessionStarted?.sessionId).toBe("sess-A-1");
    expect(sessionStarted?.timestamp).toBeInstanceOf(Date);
    expect(typeof sessionStarted?.backendPid).toBe("string");
    expect(messages.some((m) => m.event === "notification")).toBe(true);
    expect(messages.some((m) => m.event === "turn_completed")).toBe(true);
  });

  test("fails the turn when the result is an error subtype", async () => {
    installClaude({
      sessionId: "sess-B",
      turns: [{ actions: [{ t: "init" }, { t: "result", subtype: "error_during_execution" }] }],
    });
    const { started, messages } = await start(workspaceFor("CC-2"));
    expect(started.ok).toBe(true);
    if (!started.ok) {
      return;
    }
    const turn = await ClaudeCodePlugin.sessions.runTurn(started.value, "go", turnContext("CC-2"));
    ClaudeCodePlugin.sessions.stopSession(started.value);

    expect(turn.ok).toBe(false);
    if (!turn.ok) {
      expect((turn.error as { tag: string }).tag).toBe("turn_failed");
    }
    expect(messages.some((m) => m.event === "turn_failed")).toBe(true);
  });

  test("times out when no result arrives", async () => {
    installClaude(
      {
        sessionId: "sess-C",
        turns: [{ actions: [{ t: "init" }, { t: "assistant", text: "thinking forever" }] }],
      },
      { turn_timeout_ms: 400, read_timeout_ms: 2_000 },
    );
    const { started, messages } = await start(workspaceFor("CC-3"));
    expect(started.ok).toBe(true);
    if (!started.ok) {
      return;
    }
    const turn = await ClaudeCodePlugin.sessions.runTurn(started.value, "go", turnContext("CC-3"));
    ClaudeCodePlugin.sessions.stopSession(started.value);

    expect(turn.ok).toBe(false);
    if (!turn.ok) {
      expect((turn.error as { tag: string }).tag).toBe("turn_timeout");
    }
    // A terminal event is emitted so the dashboard shows the failure, not a
    // stale in-progress notification.
    expect(messages.some((m) => m.event === "turn_ended_with_error")).toBe(true);
  });

  test("reports port_exit when the process exits mid-turn", async () => {
    installClaude({
      sessionId: "sess-D",
      turns: [{ actions: [{ t: "init" }, { t: "exit", code: 0 }] }],
    });
    const { started, messages } = await start(workspaceFor("CC-4"));
    expect(started.ok).toBe(true);
    if (!started.ok) {
      return;
    }
    const turn = await ClaudeCodePlugin.sessions.runTurn(started.value, "go", turnContext("CC-4"));
    ClaudeCodePlugin.sessions.stopSession(started.value);

    expect(turn.ok).toBe(false);
    if (!turn.ok) {
      expect((turn.error as { tag: string }).tag).toBe("port_exit");
    }
    // session_started fired before the exit, and a terminal event closes the turn.
    expect(messages.some((m) => m.event === "session_started")).toBe(true);
    expect(messages.some((m) => m.event === "turn_ended_with_error")).toBe(true);
  });

  test("forwards a malformed protocol line as a malformed event", async () => {
    installClaude({
      sessionId: "sess-E",
      turns: [
        {
          actions: [
            { t: "init" },
            { t: "raw", line: '{"type":"assistant"' },
            { t: "result", subtype: "success", usage: { input_tokens: 1, output_tokens: 1 } },
          ],
        },
      ],
    });
    const { started, messages } = await start(workspaceFor("CC-5"));
    expect(started.ok).toBe(true);
    if (!started.ok) {
      return;
    }
    const turn = await ClaudeCodePlugin.sessions.runTurn(started.value, "go", turnContext("CC-5"));
    ClaudeCodePlugin.sessions.stopSession(started.value);

    expect(turn.ok).toBe(true);
    expect(messages.some((m) => m.event === "malformed")).toBe(true);
  });

  test("derives a per-turn sessionId and accumulates cumulative usage across turns", async () => {
    installClaude({
      sessionId: "sess-F",
      turns: [
        {
          actions: [
            { t: "init" },
            { t: "result", subtype: "success", usage: { input_tokens: 10, output_tokens: 5 } },
          ],
        },
        {
          actions: [
            { t: "result", subtype: "success", usage: { input_tokens: 20, output_tokens: 5 } },
          ],
        },
      ],
    });
    const { started, messages } = await start(workspaceFor("CC-6"));
    expect(started.ok).toBe(true);
    if (!started.ok) {
      return;
    }
    const session = started.value;
    const turn1 = await ClaudeCodePlugin.sessions.runTurn(session, "first", turnContext("CC-6", 1));
    const turn2 = await ClaudeCodePlugin.sessions.runTurn(
      session,
      "second",
      turnContext("CC-6", 2),
    );
    ClaudeCodePlugin.sessions.stopSession(session);

    expect(turn1.ok && turn1.value.sessionId).toBe("sess-F-1");
    expect(turn2.ok && turn2.value.sessionId).toBe("sess-F-2");
    // Two distinct session ids => orchestrator's turnCountForUpdate advances.
    expect(turn1.ok && turn2.ok && turn1.value.sessionId !== turn2.value.sessionId).toBe(true);

    // session_started fires every turn with the derived ids.
    const startedIds = messages
      .filter((m) => m.event === "session_started")
      .map((m) => m.sessionId);
    expect(startedIds).toEqual(["sess-F-1", "sess-F-2"]);

    // Cumulative absolute totals (10/15 then 30/40), NOT per-turn deltas.
    const totals = messages
      .filter((m) => m.event === "turn_completed")
      .map((m) => (m.usage as { total_tokens?: number }).total_tokens);
    expect(totals).toEqual([15, 40]);
    const inputs = messages
      .filter((m) => m.event === "turn_completed")
      .map((m) => (m.usage as { input_tokens?: number }).input_tokens);
    expect(inputs).toEqual([10, 30]);
  });

  test("bridges MCP tool calls to the injected ToolProvider (completed/failed/unsupported)", async () => {
    const calls: { tool: string | null; args: unknown }[] = [];
    const toolProvider: ToolProvider = {
      listSpecs: () => [
        { name: "good_tool", description: "d", inputSchema: {} },
        { name: "bad_tool", description: "d", inputSchema: {} },
      ],
      execute: (tool, args) => {
        calls.push({ tool, args });
        if (tool === "good_tool") {
          return Promise.resolve({ success: true, payload: { data: { ok: true } } });
        }
        if (tool === "bad_tool") {
          return Promise.resolve({ success: false, payload: { error: { message: "boom" } } });
        }
        return Promise.resolve({
          success: false,
          payload: { error: { message: "unsupported", supportedTools: ["good_tool", "bad_tool"] } },
        });
      },
    };

    installClaude({
      sessionId: "sess-G",
      turns: [
        {
          actions: [
            { t: "init" },
            { t: "mcpCall", name: "good_tool", arguments: { q: 1 } },
            { t: "mcpCall", name: "bad_tool", arguments: {} },
            { t: "mcpCall", name: "ghost_tool", arguments: {} },
            { t: "result", subtype: "success", usage: { input_tokens: 1, output_tokens: 1 } },
          ],
        },
      ],
    });

    const { started, messages } = await start(workspaceFor("CC-7"), { toolProvider });
    expect(started.ok).toBe(true);
    if (!started.ok) {
      return;
    }
    const turn = await ClaudeCodePlugin.sessions.runTurn(
      started.value,
      "tools",
      turnContext("CC-7"),
    );
    ClaudeCodePlugin.sessions.stopSession(started.value);
    expect(turn.ok).toBe(true);

    expect(calls.map((c) => c.tool)).toEqual(["good_tool", "bad_tool", "ghost_tool"]);
    expect(calls[0]?.args).toEqual({ q: 1 });
    expect(messages.some((m) => m.event === "tool_call_completed")).toBe(true);
    expect(messages.some((m) => m.event === "tool_call_failed")).toBe(true);
    expect(messages.some((m) => m.event === "unsupported_tool_call")).toBe(true);
  });

  test("permission_mode bypass ignores permission_denials and completes", async () => {
    installClaude({
      sessionId: "sess-H",
      turns: [
        {
          actions: [
            { t: "init" },
            {
              t: "result",
              subtype: "success",
              usage: { input_tokens: 1, output_tokens: 1 },
              permission_denials: [{ tool: "Bash" }],
            },
          ],
        },
      ],
    });
    const { started, messages } = await start(workspaceFor("CC-8"));
    expect(started.ok).toBe(true);
    if (!started.ok) {
      return;
    }
    const turn = await ClaudeCodePlugin.sessions.runTurn(started.value, "go", turnContext("CC-8"));
    ClaudeCodePlugin.sessions.stopSession(started.value);

    expect(turn.ok).toBe(true);
    expect(messages.some((m) => m.event === "turn_completed")).toBe(true);
    expect(messages.some((m) => m.event === "approval_required")).toBe(false);
  });

  test("permission_mode default surfaces permission_denials as approval_required", async () => {
    installClaude(
      {
        sessionId: "sess-I",
        turns: [
          {
            actions: [
              { t: "init" },
              {
                t: "result",
                subtype: "success",
                usage: { input_tokens: 1, output_tokens: 1 },
                permission_denials: [{ tool: "Bash", command: "rm -rf /" }],
              },
            ],
          },
        ],
      },
      { permission_mode: "default" },
    );
    const { started, messages } = await start(workspaceFor("CC-9"));
    expect(started.ok).toBe(true);
    if (!started.ok) {
      return;
    }
    const turn = await ClaudeCodePlugin.sessions.runTurn(started.value, "go", turnContext("CC-9"));
    ClaudeCodePlugin.sessions.stopSession(started.value);

    expect(turn.ok).toBe(false);
    if (!turn.ok) {
      expect((turn.error as { tag: string }).tag).toBe("approval_required");
    }
    expect(messages.some((m) => m.event === "approval_required")).toBe(true);
  });

  test("rejects a workspace equal to the configured root before spawning", async () => {
    installClaude({ sessionId: "sess-J", turns: [] });
    const started = await ClaudeCodePlugin.sessions.startSession(workspaceRoot);
    expect(started.ok).toBe(false);
    if (!started.ok) {
      const error = started.error as { tag: string; reason: string };
      expect(error.tag).toBe("invalid_workspace_cwd");
      expect(error.reason).toBe("workspace_root");
    }
  });

  test("rejects a workspace outside the configured root before spawning", async () => {
    installClaude({ sessionId: "sess-K", turns: [] });
    const outside = path.join(testRoot, "outside");
    fs.mkdirSync(outside, { recursive: true });
    const started = await ClaudeCodePlugin.sessions.startSession(outside);
    expect(started.ok).toBe(false);
    if (!started.ok) {
      const error = started.error as { tag: string; reason: string };
      expect(error.tag).toBe("invalid_workspace_cwd");
      expect(error.reason).toBe("outside_workspace_root");
    }
  });
});
