import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  type AppServerMessage,
  type IssueLike,
  type ToolExecutor,
  run,
} from "../../../src/symphony/codex/app-server.ts";
import { workflowFilePath } from "../../../src/symphony/workflow.ts";
import { setupWorkflow, teardownWorkflow, writeWorkflowFile } from "../../support/test-support.ts";

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

describe("Codex.AppServer", () => {
  let workflowRoot: string;
  let testRoot: string;
  let workspaceRoot: string;
  let codexBinary: string;
  let traceFile: string;

  beforeEach(() => {
    ({ root: workflowRoot } = setupWorkflow());
    testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "symphony-codex-"));
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

  test("rejects the workspace root and paths outside the workspace root", async () => {
    writeWorkflowFile(workflowFilePath(), { workspace_root: workspaceRoot });
    const outside = path.join(testRoot, "outside");
    fs.mkdirSync(outside, { recursive: true });

    const root = await run(workspaceRoot, "guard", issue("MT-999"));
    expect(root.ok).toBe(false);
    if (!root.ok) {
      expect((root.error as { tag: string; reason: string }).reason).toBe("workspace_root");
    }

    const out = await run(outside, "guard", issue("MT-999"));
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect((out.error as { reason: string }).reason).toBe("outside_workspace_root");
    }
  });

  test("rejects symlink escape cwd paths under the workspace root", async () => {
    writeWorkflowFile(workflowFilePath(), { workspace_root: workspaceRoot });
    const outside = path.join(testRoot, "outside");
    const symlinkWorkspace = path.join(workspaceRoot, "MT-1000");
    fs.mkdirSync(outside, { recursive: true });
    fs.symlinkSync(outside, symlinkWorkspace);

    const result = await run(symlinkWorkspace, "guard", issue("MT-1000"));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const error = result.error as { reason: string; path: string };
      expect(error.reason).toBe("symlink_escape");
      expect(error.path).toBe(path.resolve(symlinkWorkspace));
    }
  });

  test("passes explicit turn sandbox policies through unchanged", async () => {
    const workspace = workspaceFor("MT-1001");
    const cases = `  1)
    printf '%s\\n' '{"id":1,"result":{}}'
    ;;
  2)
    printf '%s\\n' '{"id":2,"result":{"thread":{"id":"thread-1001"}}}'
    ;;
  3)
    printf '%s\\n' '{"id":3,"result":{"turn":{"id":"turn-1001"}}}'
    ;;
  4)
    printf '%s\\n' '{"method":"turn/completed"}'
    exit 0
    ;;`;

    const policies = [
      { type: "dangerFullAccess" },
      { type: "externalSandbox", profile: "remote-ci" },
      { type: "workspaceWrite", writableRoots: ["relative/path"], networkAccess: true },
      { type: "futureSandbox", nested: { flag: true } },
    ];

    for (const policy of policies) {
      fs.rmSync(traceFile, { force: true });
      installCodex(codexScript(traceFile, cases), { codex_turn_sandbox_policy: policy });

      const result = await run(workspace, "Validate supported turn policy", issue("MT-1001"));
      expect(result.ok).toBe(true);

      const trace = fs.readFileSync(traceFile, "utf8");
      const turnStart = trace
        .split("\n")
        .filter((l) => l.startsWith("JSON:"))
        .map((l) => JSON.parse(l.slice("JSON:".length)))
        .find((p) => p.method === "turn/start");
      expect(turnStart?.params?.sandboxPolicy).toEqual(policy);
    }
  });

  test("marks request-for-input events as a hard failure", async () => {
    const workspace = workspaceFor("MT-88");
    const cases = `  1)
    printf '%s\\n' '{"id":1,"result":{}}'
    ;;
  2)
    printf '%s\\n' '{"id":2,"result":{"thread":{"id":"thread-88"}}}'
    ;;
  3)
    printf '%s\\n' '{"id":3,"result":{"turn":{"id":"turn-88"}}}'
    printf '%s\\n' '{"method":"turn/input_required","id":"resp-1","params":{"requiresInput":true,"reason":"blocked"}}'
    ;;`;
    installCodex(codexScript(null, cases));

    const result = await run(workspace, "Needs input", issue("MT-88"));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const error = result.error as { tag: string; payload: { method: string } };
      expect(error.tag).toBe("turn_input_required");
      expect(error.payload.method).toBe("turn/input_required");
    }
  });

  test("fails when command execution approval is required under safer defaults", async () => {
    const workspace = workspaceFor("MT-89");
    const cases = `  1)
    printf '%s\\n' '{"id":1,"result":{}}'
    ;;
  2)
    printf '%s\\n' '{"id":2,"result":{"thread":{"id":"thread-89"}}}'
    ;;
  3)
    printf '%s\\n' '{"id":3,"result":{"turn":{"id":"turn-89"}}}'
    printf '%s\\n' '{"id":99,"method":"item/commandExecution/requestApproval","params":{"command":"gh pr view","cwd":"/tmp","reason":"need approval"}}'
    ;;`;
    installCodex(codexScript(null, cases));

    const result = await run(workspace, "Handle approval request", issue("MT-89"));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect((result.error as { tag: string }).tag).toBe("approval_required");
    }
  });

  test("auto-approves command execution approval requests when approval policy is never", async () => {
    const workspace = workspaceFor("MT-89");
    const cases = `  1)
    printf '%s\\n' '{"id":1,"result":{}}'
    ;;
  2)
    ;;
  3)
    printf '%s\\n' '{"id":2,"result":{"thread":{"id":"thread-89"}}}'
    ;;
  4)
    printf '%s\\n' '{"id":3,"result":{"turn":{"id":"turn-89"}}}'
    printf '%s\\n' '{"id":99,"method":"item/commandExecution/requestApproval","params":{"command":"gh pr view","cwd":"/tmp","reason":"need approval"}}'
    ;;
  5)
    printf '%s\\n' '{"method":"turn/completed"}'
    exit 0
    ;;`;
    installCodex(codexScript(traceFile, cases), { codex_approval_policy: "never" });

    const result = await run(workspace, "Handle approval request", issue("MT-89"));
    expect(result.ok).toBe(true);

    const trace = fs.readFileSync(traceFile, "utf8");
    const decision = trace
      .split("\n")
      .filter((l) => l.startsWith("JSON:"))
      .map((l) => JSON.parse(l.slice("JSON:".length)))
      .find((p) => p.id === 99);
    expect(decision?.result?.decision).toBe("acceptForSession");
  });

  test("executes supported dynamic tool calls and returns the tool result", async () => {
    const workspace = workspaceFor("MT-90A");
    const cases = `  1)
    printf '%s\\n' '{"id":1,"result":{}}'
    ;;
  2)
    ;;
  3)
    printf '%s\\n' '{"id":2,"result":{"thread":{"id":"thread-90a"}}}'
    ;;
  4)
    printf '%s\\n' '{"id":3,"result":{"turn":{"id":"turn-90a"}}}'
    printf '%s\\n' '{"id":102,"method":"item/tool/call","params":{"name":"linear_graphql","arguments":{"query":"query Viewer { viewer { id } }","variables":{"includeTeams":false}}}}'
    ;;
  5)
    printf '%s\\n' '{"method":"turn/completed"}'
    exit 0
    ;;`;
    installCodex(codexScript(traceFile, cases));

    const calls: { tool: string | null; args: unknown }[] = [];
    const toolExecutor: ToolExecutor = (tool, args) => {
      calls.push({ tool, args });
      return {
        success: true,
        output: '{"data":{"viewer":{"id":"usr_123"}}}',
        contentItems: [{ type: "inputText", text: '{"data":{"viewer":{"id":"usr_123"}}}' }],
      };
    };

    const result = await run(workspace, "Handle supported tool calls", issue("MT-90A"), {
      toolExecutor,
    });
    expect(result.ok).toBe(true);
    expect(calls).toEqual([
      {
        tool: "linear_graphql",
        args: { query: "query Viewer { viewer { id } }", variables: { includeTeams: false } },
      },
    ]);

    const trace = fs.readFileSync(traceFile, "utf8");
    const toolResult = trace
      .split("\n")
      .filter((l) => l.startsWith("JSON:"))
      .map((l) => JSON.parse(l.slice("JSON:".length)))
      .find((p) => p.id === 102);
    expect(toolResult?.result?.success).toBe(true);
  });

  test("rejects unsupported dynamic tool calls without stalling", async () => {
    const workspace = workspaceFor("MT-90");
    const cases = `  1)
    printf '%s\\n' '{"id":1,"result":{}}'
    ;;
  2)
    ;;
  3)
    printf '%s\\n' '{"id":2,"result":{"thread":{"id":"thread-90"}}}'
    ;;
  4)
    printf '%s\\n' '{"id":3,"result":{"turn":{"id":"turn-90"}}}'
    printf '%s\\n' '{"id":101,"method":"item/tool/call","params":{"tool":"some_tool","arguments":{}}}'
    ;;
  5)
    printf '%s\\n' '{"method":"turn/completed"}'
    exit 0
    ;;`;
    installCodex(codexScript(traceFile, cases));

    const result = await run(workspace, "Reject unsupported tool calls", issue("MT-90"));
    expect(result.ok).toBe(true);

    const trace = fs.readFileSync(traceFile, "utf8");
    const toolResult = trace
      .split("\n")
      .filter((l) => l.startsWith("JSON:"))
      .map((l) => JSON.parse(l.slice("JSON:".length)))
      .find((p) => p.id === 101);
    expect(toolResult?.result?.success).toBe(false);
    expect(String(toolResult?.result?.output)).toContain("Unsupported dynamic tool");
  });

  test("buffers partial JSON lines until newline terminator", async () => {
    const workspace = workspaceFor("MT-91");
    const cases = `  1)
    padding=$(printf '%*s' 1100000 '' | tr ' ' a)
    printf '{"id":1,"result":{},"padding":"%s"}\\n' "$padding"
    ;;
  2)
    printf '%s\\n' '{"id":2,"result":{"thread":{"id":"thread-91"}}}'
    ;;
  3)
    printf '%s\\n' '{"id":3,"result":{"turn":{"id":"turn-91"}}}'
    ;;
  4)
    printf '%s\\n' '{"method":"turn/completed"}'
    exit 0
    ;;`;
    installCodex(codexScript(null, cases));

    const result = await run(workspace, "Validate newline-delimited buffering", issue("MT-91"));
    expect(result.ok).toBe(true);
  });

  test("emits malformed events for JSON-like protocol lines that fail to decode", async () => {
    const workspace = workspaceFor("MT-93");
    const cases = `  1)
    printf '%s\\n' '{"id":1,"result":{}}'
    ;;
  2)
    printf '%s\\n' '{"id":2,"result":{"thread":{"id":"thread-93"}}}'
    ;;
  3)
    printf '%s\\n' '{"id":3,"result":{"turn":{"id":"turn-93"}}}'
    printf '%s\\n' '{"method":"turn/completed"'
    printf '%s\\n' '{"method":"turn/completed"}'
    ;;`;
    installCodex(codexScript(null, cases));

    const messages: AppServerMessage[] = [];
    const result = await run(workspace, "Capture malformed protocol line", issue("MT-93"), {
      onMessage: (m) => messages.push(m),
    });
    expect(result.ok).toBe(true);

    const malformed = messages.find((m) => m.event === "malformed");
    expect(malformed?.payload).toBe('{"method":"turn/completed"');
    expect(messages.some((m) => m.event === "turn_completed")).toBe(true);
  });

  test("decodes multibyte UTF-8 sequences split across stream chunks", async () => {
    const workspace = workspaceFor("MT-94");
    // "€" (0xE2 0x82 0xAC) is written in two separate writes so the byte
    // sequence straddles a chunk boundary in the stdout stream.
    const cases = `  1)
    printf '%s\\n' '{"id":1,"result":{}}'
    ;;
  2)
    printf '%s\\n' '{"id":2,"result":{"thread":{"id":"thread-94"}}}'
    ;;
  3)
    printf '%s\\n' '{"id":3,"result":{"turn":{"id":"turn-94"}}}'
    printf '{"method":"item/agentMessage/delta","params":{"delta":"'
    sleep 0.05
    printf '\\342\\202'
    sleep 0.05
    printf '\\254"}}\\n'
    printf '%s\\n' '{"method":"turn/completed"}'
    ;;`;
    installCodex(codexScript(null, cases));

    const messages: AppServerMessage[] = [];
    const result = await run(workspace, "Capture split multibyte delta", issue("MT-94"), {
      onMessage: (m) => messages.push(m),
    });
    expect(result.ok).toBe(true);

    const notification = messages.find(
      (m) =>
        m.event === "notification" &&
        (m.payload as { method?: string })?.method === "item/agentMessage/delta",
    );
    expect(notification).toBeDefined();
    const params = (notification?.payload as { params?: { delta?: string } })?.params;
    expect(params?.delta).toBe("€");
  });
});
