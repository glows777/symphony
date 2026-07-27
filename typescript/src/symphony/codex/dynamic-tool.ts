// Executes client-side tool calls requested by Codex app-server turns.
// Originally a literal port of `symphony_elixir/codex/dynamic_tool.ex` with a
// single hardcoded `linear_graphql` tool; now a thin codex wire-encoder over the
// neutral `trackerToolProvider` (which resolves the active tracker plugin's
// agentTools capability and dispatches). Protocol encoding stays centralized
// here: Elixir atoms that cross these boundaries are modeled as strings;
// `inspect` is reproduced contextually (reason atoms render `:name`).
// Jason.encode! -> JSON.stringify(_, null, 2).

import { trackerToolProvider } from "../plugins/agents/tool-provider.ts";
import type { LinearClientFn } from "../plugins/linear/graphql-tool.ts";
import type { AgentToolOutcome } from "../plugins/types.ts";

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
  return encodeToolOutcome(await trackerToolProvider(opts).execute(tool, args));
}

export function toolSpecs(): Record<string, unknown>[] {
  return trackerToolProvider()
    .listSpecs()
    .map((spec) => ({
      name: spec.name,
      description: spec.description,
      inputSchema: spec.inputSchema,
    }));
}

// Encodes a semantic tool outcome into the codex wire response (JSON body +
// inputText content item). Shared with the codex agent backend adapter, which
// wraps a ToolProvider into an AppServer.ToolExecutor.
export function encodeToolOutcome(outcome: AgentToolOutcome): DynamicToolResponse {
  return dynamicToolResponse(outcome.success, encodePayload(outcome.payload));
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

// ---- helpers ---------------------------------------------------------------

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Elixir `inspect` of an atom reason (`:timeout`) — strings render `:name`.
function inspectReason(reason: unknown): string {
  if (typeof reason === "string") {
    return `:${reason}`;
  }
  return JSON.stringify(reason) ?? String(reason);
}
