// ToolProvider -> streamable HTTP MCP bridge. Bun.serve binds a localhost-only
// random port and exposes the active tracker plugin's agent tools as an MCP
// server named "symphony", registered with the claude CLI through
// `--mcp-config` (inline JSON). Unlike the codex adapter — which advertises tool
// specs through app-server's frozen global DynamicTool.toolSpecs() (a registered
// contract gap) — this bridge holds the INJECTED opts.toolProvider directly, so
// advertisement and execution use the same provider (no global fallback).
//
// Only localhost is bound (security requirement). The server lifecycle equals
// the session lifecycle: stopSession() calls close().
//
// Wire encoding mirrors codex/dynamic-tool.ts's encodePayload (object/array ->
// JSON.stringify(_, null, 2); string -> Elixir `:atom` inspect) but wrapped in
// MCP `content: [{ type: "text", text }]` with `isError = !success`, per the
// agent contract §6. The three tool-call outcomes map to the frozen events
// tool_call_completed / tool_call_failed / unsupported_tool_call here in the
// handler (an unknown tool name — one not advertised by listSpecs — is the
// "unsupported" case; a known tool returning success:false is "failed").

import type { AgentToolSpec } from "../../types.ts";
import type { OnAgentMessage, ToolProvider } from "../types.ts";

const MCP_PROTOCOL_VERSION = "2024-11-05";

export type McpBridge = {
  url: string;
  close(): void;
};

type JsonRpcRequest = {
  jsonrpc?: string;
  id?: unknown;
  method?: unknown;
  params?: unknown;
};

// Starts the localhost MCP bridge. Returns its URL (for --mcp-config) and a
// close() bound to the session lifecycle.
export function startToolBridge(toolProvider: ToolProvider, onMessage: OnAgentMessage): McpBridge {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      if (req.method !== "POST") {
        return new Response("method not allowed", { status: 405 });
      }
      const body = await readJson(req);
      if (Array.isArray(body)) {
        const responses = [];
        for (const entry of body) {
          const response = await handleRpc(entry, toolProvider, onMessage);
          if (response !== null) {
            responses.push(response);
          }
        }
        return json(responses);
      }
      const response = await handleRpc(body, toolProvider, onMessage);
      // Notifications (no id) get an empty 202 with no JSON-RPC body.
      return response === null ? new Response(null, { status: 202 }) : json(response);
    },
  });
  return {
    url: `http://127.0.0.1:${server.port}/mcp`,
    close: () => server.stop(true),
  };
}

async function handleRpc(
  request: unknown,
  toolProvider: ToolProvider,
  onMessage: OnAgentMessage,
): Promise<Record<string, unknown> | null> {
  const req = (isObject(request) ? request : {}) as JsonRpcRequest;
  const method = typeof req.method === "string" ? req.method : "";
  const id = req.id;

  // Notifications carry no id and expect no response.
  if (id === undefined || id === null) {
    return null;
  }

  switch (method) {
    case "initialize":
      return result(id, {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: "symphony", version: "0.1.0" },
      });
    case "tools/list":
      return result(id, { tools: toolDefs(toolProvider.listSpecs()) });
    case "tools/call":
      return result(id, await callTool(req.params, toolProvider, onMessage));
    case "ping":
      return result(id, {});
    default:
      return { jsonrpc: "2.0", id, error: { code: -32601, message: `unknown method: ${method}` } };
  }
}

async function callTool(
  params: unknown,
  toolProvider: ToolProvider,
  onMessage: OnAgentMessage,
): Promise<Record<string, unknown>> {
  const name = isObject(params) && typeof params.name === "string" ? params.name : null;
  const args = isObject(params) ? (params.arguments ?? {}) : {};
  const known = name !== null && toolProvider.listSpecs().some((spec) => spec.name === name);

  const outcome = await toolProvider.execute(name, args);
  const event = outcome.success
    ? "tool_call_completed"
    : known
      ? "tool_call_failed"
      : "unsupported_tool_call";
  onMessage({
    event,
    timestamp: new Date(),
    payload: { tool: name, arguments: args, success: outcome.success },
  });

  return {
    content: [{ type: "text", text: encodePayload(outcome.payload) }],
    isError: !outcome.success,
  };
}

function toolDefs(specs: AgentToolSpec[]): Record<string, unknown>[] {
  return specs.map((spec) => ({
    name: spec.name,
    description: spec.description,
    inputSchema: spec.inputSchema,
  }));
}

// Mirrors codex/dynamic-tool.ts encodePayload: objects/arrays render as pretty
// JSON; a bare string renders as an Elixir `:atom` inspect.
function encodePayload(payload: unknown): string {
  if (isObject(payload) || Array.isArray(payload)) {
    return JSON.stringify(payload, null, 2);
  }
  if (typeof payload === "string") {
    return `:${payload}`;
  }
  return JSON.stringify(payload) ?? String(payload);
}

function result(id: unknown, value: Record<string, unknown>): Record<string, unknown> {
  return { jsonrpc: "2.0", id, result: value };
}

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
  });
}

async function readJson(req: Request): Promise<unknown> {
  try {
    return await req.json();
  } catch {
    return {};
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
