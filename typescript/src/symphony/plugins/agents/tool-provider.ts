// Neutral tool bridge shared by every agent backend. Lifted out of
// codex/dynamic-tool.ts so the "resolve the active tracker plugin's agentTools
// + dispatch + unsupported-tool failure" logic lives in one backend-agnostic
// place; each backend keeps its own wire encoding (codex: contentItems +
// item/tool/call; a future claude-code plugin: MCP content blocks).
//
// The tracker plugin is re-resolved from WORKFLOW.md on every call, matching the
// dispatcher's original per-call resolution: a plugin with no agentTools
// advertises an empty spec list and every call gets the unsupported payload.

import { settings } from "../../config.ts";
import { trackerPluginOrNull } from "../registry.ts";
import type { AgentToolCapability, AgentToolExecuteOpts, AgentToolSpec } from "../types.ts";
import type { AgentToolOutcome } from "../types.ts";
import type { ToolProvider } from "./types.ts";

export function trackerToolProvider(opts: AgentToolExecuteOpts = {}): ToolProvider {
  return {
    listSpecs(): AgentToolSpec[] {
      return activeAgentTools()?.listAgentTools() ?? [];
    },
    execute(tool: string | null, args: unknown): Promise<AgentToolOutcome> {
      return executeTool(tool, args, opts);
    },
  };
}

async function executeTool(
  tool: string | null,
  args: unknown,
  opts: AgentToolExecuteOpts,
): Promise<AgentToolOutcome> {
  const provider = activeAgentTools();
  if (
    provider !== null &&
    tool !== null &&
    provider.listAgentTools().some((spec) => spec.name === tool)
  ) {
    return provider.executeAgentTool(tool, args, opts);
  }
  return {
    success: false,
    payload: {
      error: {
        message: `Unsupported dynamic tool: ${inspectToolName(tool)}.`,
        supportedTools: supportedToolNames(),
      },
    },
  };
}

// Resolves the active plugin's agent tools from the current WORKFLOW.md config.
// Unparseable config or an unregistered kind advertises no tools (turns still
// run; unsupported calls get the failure payload above).
function activeAgentTools(): AgentToolCapability | null {
  const config = settings();
  if (!config.ok) {
    return null;
  }
  return trackerPluginOrNull(config.value.tracker.kind)?.agentTools ?? null;
}

function supportedToolNames(): string[] {
  return (activeAgentTools()?.listAgentTools() ?? []).map((spec) => spec.name);
}

// Elixir `inspect` of a binary tool name: quoted.
function inspectToolName(name: unknown): string {
  return JSON.stringify(name);
}
