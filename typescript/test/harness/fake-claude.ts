#!/usr/bin/env bun
// Scenario-driven fake `claude` CLI for claude-code plugin tests — the
// stream-json twin of test/harness/fake-codex.ts. It reproduces the message
// shapes verified live against claude CLI 2.1.218 (system/init, assistant,
// result with per-turn usage + permission_denials) without needing the real CLI
// or network.
//
// Invocation: the plugin spawns `<command> -p --input-format stream-json ...`,
// and tests set command = `bun <fake-claude.ts> <scenario.json>`, so:
//   Bun.argv = [bun, fake-claude.ts, scenario.json, -p, --input-format, ...].
// The scenario file (argv[2]) is a JSON { sessionId, turns: [{ actions }] }.
// Each line read from stdin is one user turn; the Nth user message runs
// scenario.turns[N-1].actions in order. The bridge URL (for MCP round-trip
// actions) is parsed from the --mcp-config JSON passed by the plugin.
//
// Action kinds:
//   { "t": "init" }                              -> emit system/init(session_id)
//   { "t": "assistant", "text"|"tool": "..." }   -> emit an assistant line
//   { "t": "emit", "line": <object> }            -> emit an arbitrary object line
//   { "t": "raw", "line": "<string>" }           -> emit a raw (maybe non-JSON) line
//   { "t": "result", ...fields }                 -> emit a result line
//   { "t": "mcpList" }                           -> POST tools/list to the bridge
//   { "t": "mcpCall", "name", "arguments" }      -> POST tools/call to the bridge
//   { "t": "exit", "code"? }                     -> flush and exit the process

import fs from "node:fs";

type Action = Record<string, unknown>;
type Scenario = { sessionId?: string; turns?: { actions?: Action[] }[] };

const scenario = loadScenario();
const sessionId = typeof scenario.sessionId === "string" ? scenario.sessionId : "fake-session";
const bridgeUrl = parseMcpUrl(Bun.argv);
let mcpRequestId = 0;

await driveTurns();

async function driveTurns(): Promise<void> {
  const turns = Array.isArray(scenario.turns) ? scenario.turns : [];
  let turnIndex = 0;
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of Bun.stdin.stream()) {
    buffer += decoder.decode(chunk);
    let nl = buffer.indexOf("\n");
    while (nl >= 0) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      if (line.trim() !== "") {
        await runActions(turns[turnIndex]?.actions ?? []);
        turnIndex += 1;
      }
      nl = buffer.indexOf("\n");
    }
  }
}

async function runActions(actions: Action[]): Promise<void> {
  for (const action of actions) {
    await runAction(action);
  }
}

async function runAction(action: Action): Promise<void> {
  switch (action.t) {
    case "init":
      emit({
        type: "system",
        subtype: "init",
        session_id: sessionId,
        cwd: process.cwd(),
        tools: [],
        mcp_servers: [],
        model: "fake-model",
        permissionMode: "default",
      });
      return;
    case "assistant":
      emit(assistantMessage(action));
      return;
    case "emit":
      emit(action.line);
      return;
    case "raw":
      write(String(action.line ?? ""));
      return;
    case "result":
      emit(resultMessage(action));
      return;
    case "mcpList":
      await mcpRequest("tools/list", {});
      return;
    case "mcpCall":
      await mcpRequest("tools/call", { name: action.name, arguments: action.arguments ?? {} });
      return;
    case "exit":
      await flush();
      process.exit(typeof action.code === "number" ? action.code : 0);
      return;
    default:
      return;
  }
}

function assistantMessage(action: Action): Record<string, unknown> {
  const content =
    typeof action.tool === "string"
      ? [{ type: "tool_use", id: "toolu_fake", name: action.tool, input: {} }]
      : [{ type: "text", text: typeof action.text === "string" ? action.text : "" }];
  return {
    type: "assistant",
    message: { role: "assistant", model: "fake-model", content },
    session_id: sessionId,
  };
}

function resultMessage(action: Action): Record<string, unknown> {
  const subtype = typeof action.subtype === "string" ? action.subtype : "success";
  return {
    type: "result",
    subtype,
    is_error: subtype !== "success",
    num_turns: typeof action.num_turns === "number" ? action.num_turns : 1,
    session_id: sessionId,
    result: typeof action.result === "string" ? action.result : "",
    total_cost_usd: typeof action.total_cost_usd === "number" ? action.total_cost_usd : 0,
    usage: isObject(action.usage) ? action.usage : {},
    permission_denials: Array.isArray(action.permission_denials) ? action.permission_denials : [],
  };
}

async function mcpRequest(method: string, params: Record<string, unknown>): Promise<void> {
  if (bridgeUrl === null) {
    return;
  }
  mcpRequestId += 1;
  try {
    await fetch(bridgeUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: mcpRequestId, method, params }),
    });
  } catch {
    // The bridge closing mid-request is fine for these tests.
  }
}

function loadScenario(): Scenario {
  const path = Bun.argv[2];
  if (typeof path !== "string" || !path.endsWith(".json")) {
    return {};
  }
  try {
    return JSON.parse(fs.readFileSync(path, "utf8")) as Scenario;
  } catch {
    return {};
  }
}

function parseMcpUrl(argv: string[]): string | null {
  const idx = argv.indexOf("--mcp-config");
  const raw = idx < 0 ? undefined : argv[idx + 1];
  if (raw === undefined) {
    return null;
  }
  try {
    const config = JSON.parse(raw);
    const url = config?.mcpServers?.symphony?.url;
    return typeof url === "string" ? url : null;
  } catch {
    return null;
  }
}

function emit(value: unknown): void {
  write(JSON.stringify(value));
}

function write(line: string): void {
  process.stdout.write(`${line}\n`);
}

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 20));
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
