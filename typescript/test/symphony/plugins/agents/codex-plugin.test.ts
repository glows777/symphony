import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CodexPlugin } from "../../../../src/symphony/plugins/agents/codex/plugin.ts";
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

// Reuses app-server.test.ts's fake-codex line-scripting, but drives the full
// plugin session API (startSession -> runTurn -> stopSession) so the adapter's
// handle storage, event normalization, and ToolProvider bridging are exercised
// end to end. This is the concrete proof the contract wraps app-server.
function codexScript(traceFile: string | null, cases: string): string {
  const traceLine = traceFile ? `trace_file="${traceFile}"\n` : "";
  const traceWrite = traceFile ? `  printf 'JSON:%s\\n' "$line" >> "$trace_file"\n` : "";
  return `#!/bin/sh
${traceLine}count=0
while IFS= read -r line; do
  count=$((count + 1))
${traceWrite}  case "$count" in
${cases}
  *)
    exit 0
    ;;
  esac
done
`;
}

const issue = (identifier: string): IssueLike => ({
  id: `issue-${identifier}`,
  identifier,
  title: `Title ${identifier}`,
});

const turnContext = (identifier: string) => ({
  issue: issue(identifier),
  turnNumber: 1,
  maxTurns: 1,
});

describe("Plugins.Agents.CodexPlugin", () => {
  let workflowRoot: string;
  let testRoot: string;
  let workspaceRoot: string;
  let codexBinary: string;
  let traceFile: string;

  beforeEach(() => {
    ({ root: workflowRoot } = setupWorkflow());
    testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "symphony-codex-plugin-"));
    workspaceRoot = path.join(testRoot, "workspaces");
    codexBinary = path.join(testRoot, "fake-codex");
    traceFile = path.join(testRoot, "codex.trace");
    fs.mkdirSync(workspaceRoot, { recursive: true });
  });

  afterEach(() => {
    teardownWorkflow(workflowRoot);
    fs.rmSync(testRoot, { recursive: true, force: true });
  });

  function installCodex(script: string, overrides: Record<string, unknown> = {}): void {
    fs.writeFileSync(codexBinary, script);
    fs.chmodSync(codexBinary, 0o755);
    writeWorkflowFile(workflowFilePath(), {
      workspace_root: workspaceRoot,
      codex_command: `${codexBinary} app-server`,
      ...overrides,
    });
  }

  function workspaceFor(identifier: string): string {
    const ws = path.join(workspaceRoot, identifier);
    fs.mkdirSync(ws, { recursive: true });
    return ws;
  }

  test("runs a start -> turn -> stop lifecycle and reports the backend pid", async () => {
    const workspace = workspaceFor("MT-201");
    const cases = `  1)
    printf '%s\\n' '{"id":1,"result":{}}'
    ;;
  2)
    printf '%s\\n' '{"id":2,"result":{"thread":{"id":"thread-201"}}}'
    ;;
  3)
    printf '%s\\n' '{"id":3,"result":{"turn":{"id":"turn-201"}}}'
    ;;
  4)
    printf '%s\\n' '{"method":"turn/completed"}'
    exit 0
    ;;`;
    installCodex(codexScript(null, cases));

    const messages: AgentMessage[] = [];
    const started = await CodexPlugin.sessions.startSession(workspace, {
      onMessage: (message) => messages.push(message),
    });
    expect(started.ok).toBe(true);
    if (!started.ok) {
      return;
    }
    const session = started.value;
    expect(session.backendId).toBe("codex");
    expect(session.workspace).toBe(path.resolve(workspace));
    expect(session.workerHost).toBeNull();
    expect(typeof session.backendPid).toBe("string");

    const turn = await CodexPlugin.sessions.runTurn(session, "do the work", turnContext("MT-201"));
    CodexPlugin.sessions.stopSession(session);

    expect(turn.ok).toBe(true);
    if (turn.ok) {
      expect(turn.value.sessionId).toBe("thread-201-turn-201");
    }

    const sessionStarted = messages.find((m) => m.event === "session_started");
    expect(sessionStarted?.sessionId).toBe("thread-201-turn-201");
    expect(sessionStarted?.timestamp).toBeInstanceOf(Date);
    expect(messages.some((m) => m.event === "turn_completed")).toBe(true);
  });

  test("auto-approves command approvals when the approval policy is never", async () => {
    const workspace = workspaceFor("MT-202");
    const cases = `  1)
    printf '%s\\n' '{"id":1,"result":{}}'
    ;;
  2)
    ;;
  3)
    printf '%s\\n' '{"id":2,"result":{"thread":{"id":"thread-202"}}}'
    ;;
  4)
    printf '%s\\n' '{"id":3,"result":{"turn":{"id":"turn-202"}}}'
    printf '%s\\n' '{"id":99,"method":"item/commandExecution/requestApproval","params":{"command":"gh pr view","cwd":"/tmp","reason":"need approval"}}'
    ;;
  5)
    printf '%s\\n' '{"method":"turn/completed"}'
    exit 0
    ;;`;
    installCodex(codexScript(traceFile, cases), { codex_approval_policy: "never" });

    const messages: AgentMessage[] = [];
    const started = await CodexPlugin.sessions.startSession(workspace, {
      onMessage: (message) => messages.push(message),
    });
    expect(started.ok).toBe(true);
    if (!started.ok) {
      return;
    }
    const turn = await CodexPlugin.sessions.runTurn(
      started.value,
      "approve please",
      turnContext("MT-202"),
    );
    CodexPlugin.sessions.stopSession(started.value);
    expect(turn.ok).toBe(true);

    expect(messages.some((m) => m.event === "approval_auto_approved")).toBe(true);
    const decision = fs
      .readFileSync(traceFile, "utf8")
      .split("\n")
      .filter((l) => l.startsWith("JSON:"))
      .map((l) => JSON.parse(l.slice("JSON:".length)))
      .find((p) => p.id === 99);
    expect(decision?.result?.decision).toBe("acceptForSession");
  });

  test("routes tool calls through the injected ToolProvider and returns its outcome", async () => {
    const workspace = workspaceFor("MT-203");
    const cases = `  1)
    printf '%s\\n' '{"id":1,"result":{}}'
    ;;
  2)
    ;;
  3)
    printf '%s\\n' '{"id":2,"result":{"thread":{"id":"thread-203"}}}'
    ;;
  4)
    printf '%s\\n' '{"id":3,"result":{"turn":{"id":"turn-203"}}}'
    printf '%s\\n' '{"id":102,"method":"item/tool/call","params":{"name":"linear_graphql","arguments":{"query":"query Viewer { viewer { id } }"}}}'
    ;;
  5)
    printf '%s\\n' '{"method":"turn/completed"}'
    exit 0
    ;;`;
    installCodex(codexScript(traceFile, cases));

    const calls: { tool: string | null; args: unknown }[] = [];
    const toolProvider: ToolProvider = {
      listSpecs: () => [],
      execute: (tool, args) => {
        calls.push({ tool, args });
        return Promise.resolve({ success: true, payload: { data: { viewer: { id: "usr_9" } } } });
      },
    };

    const messages: AgentMessage[] = [];
    const started = await CodexPlugin.sessions.startSession(workspace, {
      onMessage: (message) => messages.push(message),
      toolProvider,
    });
    expect(started.ok).toBe(true);
    if (!started.ok) {
      return;
    }
    const turn = await CodexPlugin.sessions.runTurn(
      started.value,
      "call a tool",
      turnContext("MT-203"),
    );
    CodexPlugin.sessions.stopSession(started.value);
    expect(turn.ok).toBe(true);

    expect(calls).toEqual([
      { tool: "linear_graphql", args: { query: "query Viewer { viewer { id } }" } },
    ]);
    expect(messages.some((m) => m.event === "tool_call_completed")).toBe(true);

    const toolResult = fs
      .readFileSync(traceFile, "utf8")
      .split("\n")
      .filter((l) => l.startsWith("JSON:"))
      .map((l) => JSON.parse(l.slice("JSON:".length)))
      .find((p) => p.id === 102);
    expect(toolResult?.result?.success).toBe(true);
    expect(String(toolResult?.result?.output)).toContain('"usr_9"');
  });

  test("fails the turn when the backend requests operator input", async () => {
    const workspace = workspaceFor("MT-204");
    const cases = `  1)
    printf '%s\\n' '{"id":1,"result":{}}'
    ;;
  2)
    printf '%s\\n' '{"id":2,"result":{"thread":{"id":"thread-204"}}}'
    ;;
  3)
    printf '%s\\n' '{"id":3,"result":{"turn":{"id":"turn-204"}}}'
    printf '%s\\n' '{"method":"turn/input_required","id":"resp-1","params":{"requiresInput":true,"reason":"blocked"}}'
    ;;`;
    installCodex(codexScript(null, cases));

    const messages: AgentMessage[] = [];
    const started = await CodexPlugin.sessions.startSession(workspace, {
      onMessage: (message) => messages.push(message),
    });
    expect(started.ok).toBe(true);
    if (!started.ok) {
      return;
    }
    const turn = await CodexPlugin.sessions.runTurn(
      started.value,
      "needs input",
      turnContext("MT-204"),
    );
    CodexPlugin.sessions.stopSession(started.value);

    expect(turn.ok).toBe(false);
    if (!turn.ok) {
      expect((turn.error as { tag: string }).tag).toBe("turn_input_required");
    }
    expect(messages.some((m) => m.event === "turn_input_required")).toBe(true);
  });

  test("normalizes messages: neutral backendPid alias and lifted rate_limits", async () => {
    const workspace = workspaceFor("MT-205");
    const rateLimits = {
      limit_id: "gpt-5",
      primary: { remaining: 10 },
      secondary: null,
      credits: { has_credits: true },
    };
    const tokenCount = JSON.stringify({
      method: "codex/event/token_count",
      params: {
        msg: { type: "event_msg", payload: { type: "token_count", rate_limits: rateLimits } },
      },
    });
    const cases = `  1)
    printf '%s\\n' '{"id":1,"result":{}}'
    ;;
  2)
    printf '%s\\n' '{"id":2,"result":{"thread":{"id":"thread-205"}}}'
    ;;
  3)
    printf '%s\\n' '{"id":3,"result":{"turn":{"id":"turn-205"}}}'
    ;;
  4)
    printf '%s\\n' '${tokenCount}'
    printf '%s\\n' '{"method":"turn/completed"}'
    exit 0
    ;;`;
    installCodex(codexScript(null, cases));

    const messages: AgentMessage[] = [];
    const started = await CodexPlugin.sessions.startSession(workspace, {
      onMessage: (message) => messages.push(message),
    });
    expect(started.ok).toBe(true);
    if (!started.ok) {
      return;
    }
    const turn = await CodexPlugin.sessions.runTurn(started.value, "go", turnContext("MT-205"));
    CodexPlugin.sessions.stopSession(started.value);
    expect(turn.ok).toBe(true);

    // The neutral backendPid alias mirrors the frozen codexAppServerPid.
    const withPid = messages.find((m) => typeof m.backendPid === "string");
    expect(withPid?.backendPid).toBe(withPid?.codexAppServerPid as string);

    // The token_count payload's rate limits are lifted onto the envelope.
    const lifted = messages.find((m) => m.rate_limits !== undefined);
    expect(lifted?.rate_limits).toEqual(rateLimits);
  });
});
