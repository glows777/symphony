// Executes client-side tool calls requested by Codex app-server turns.
// Originally a literal port of `symphony_elixir/codex/dynamic_tool.ex` with a
// single hardcoded `linear_graphql` tool; now a dispatcher over the active
// tracker plugin's agentTools capability (plugins without agent tools
// advertise none). Protocol encoding is centralized here: Elixir atoms that
// cross these boundaries are modeled as strings; `inspect` is reproduced
// contextually (tool names render quoted, reason atoms render `:name`).
// Jason.encode! -> JSON.stringify(_, null, 2).

import { settings } from "../config.ts";
import type { LinearClientFn } from "../plugins/linear/graphql-tool.ts";
import { trackerPluginOrNull } from "../plugins/registry.ts";
import type { AgentToolCapability } from "../plugins/types.ts";

export type DynamicToolResponse = {
  success: boolean;
  output: string;
  contentItems: { type: "inputText"; text: string }[];
};

export type { LinearClientFn };

export type ExecuteOpts = { linearClient?: LinearClientFn };

export async function execute(
  tool: string | null,
  args: unknown,
  opts: ExecuteOpts = {},
): Promise<DynamicToolResponse> {
  const provider = activeAgentTools();
  if (
    provider !== null &&
    tool !== null &&
    provider.listAgentTools().some((spec) => spec.name === tool)
  ) {
    const outcome = await provider.executeAgentTool(tool, args, opts);
    return dynamicToolResponse(outcome.success, encodePayload(outcome.payload));
  }
  return failureResponse({
    error: {
      message: `Unsupported dynamic tool: ${inspectToolName(tool)}.`,
      supportedTools: supportedToolNames(),
    },
  });
}

export function toolSpecs(): Record<string, unknown>[] {
  const provider = activeAgentTools();
  if (provider === null) {
    return [];
  }
  return provider.listAgentTools().map((spec) => ({
    name: spec.name,
    description: spec.description,
    inputSchema: spec.inputSchema,
  }));
}

// Resolves the active plugin's agent tools from the current WORKFLOW.md
// config. Unparseable config or an unregistered kind advertises no tools
// (turns still run; unsupported calls get the failure payload below).
function activeAgentTools(): AgentToolCapability | null {
  const config = settings();
  if (!config.ok) {
    return null;
  }
  return trackerPluginOrNull(config.value.tracker.kind)?.agentTools ?? null;
}

function failureResponse(payload: unknown): DynamicToolResponse {
  return dynamicToolResponse(false, encodePayload(payload));
}

function dynamicToolResponse(success: boolean, output: string): DynamicToolResponse {
  return {
    success,
    output,
    contentItems: [{ type: "inputText", text: output }],
  };
}

function encodePayload(payload: unknown): string {
  if (isObject(payload) || Array.isArray(payload)) {
    return JSON.stringify(payload, null, 2);
  }
  return inspectReason(payload);
}

function supportedToolNames(): string[] {
  return toolSpecs().map((spec) => spec.name as string);
}

// ---- helpers ---------------------------------------------------------------

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Elixir `inspect` of a binary tool name: quoted.
function inspectToolName(name: unknown): string {
  return JSON.stringify(name);
}

// Elixir `inspect` of an atom reason (`:timeout`) — strings render `:name`.
function inspectReason(reason: unknown): string {
  if (typeof reason === "string") {
    return `:${reason}`;
  }
  return JSON.stringify(reason) ?? String(reason);
}
