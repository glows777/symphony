// Plugin machinery shared by both extension points: tracker plugins
// (plugins/trackers/types.ts) and agent backend plugins
// (plugins/agents/types.ts). Post-cutover TS-native design (no Elixir
// counterpart; see MIGRATION.md -> Post-cutover divergence).
//
// Two things genuinely cross the two contracts and therefore live here rather
// than in either one:
//
//   * the config-schema hooks (`cast`/`finalize`/`validate`), which both kinds
//     of plugin implement to claim their own WORKFLOW.md section;
//   * the agent-facing tool vocabulary, which is produced by a tracker plugin's
//     `agentTools` capability and consumed by an agent backend (the bridge is
//     plugins/agents/tool-provider.ts).

import type { JsonMap, Settings } from "../../config/schema.ts";
import type { Result } from "../../result.ts";

// ---- agent-facing dynamic tools ------------------------------------------------

export type AgentToolSpec = { name: string; description: string; inputSchema: JsonMap };

// Plugins return a semantic outcome; protocol encoding (JSON.stringify,
// contentItems wrapping for codex, MCP content blocks for claude-code) stays in
// the consuming agent backend.
export type AgentToolOutcome = { success: boolean; payload: unknown };

export type AgentToolExecuteOpts = { [key: string]: unknown };

export type AgentToolCapability = {
  listAgentTools(): AgentToolSpec[];
  executeAgentTool(
    tool: string,
    args: unknown,
    opts?: AgentToolExecuteOpts,
  ): Promise<AgentToolOutcome>;
};

// ---- config schema hooks -------------------------------------------------------

export type PluginFieldError = { path: string; message: string };

// Semantic validation failure from a plugin's `validate` hook. Deliberately
// narrower than TrackerError: it carries the stable machine `tag`, the
// operator-facing `message`, and the untouched `detail`, but not the
// tracker-specific `code` taxonomy. TrackerError is structurally assignable to
// it, so tracker plugins keep returning their richer error unchanged while an
// agent backend returns its own without borrowing a tracker type.
export type PluginConfigError = {
  tag: string;
  message: string;
  detail?: unknown;
};

export type PluginConfigSchema = {
  // Casts the plugin's private fields out of the raw WORKFLOW.md section
  // (normalized keys, nils dropped). Synchronous and pure — `settings()`
  // re-parses on every call. Error messages follow the `${section}.${key}
  // <message>` convention from config/schema.ts.
  cast(raw: JsonMap, section: string): { value: JsonMap; errors: PluginFieldError[] };
  // Finalization pass: `$VAR` references and canonical env fallbacks
  // (e.g. LINEAR_API_KEY) are resolved here.
  finalize(value: JsonMap): JsonMap;
  // Semantic validation. Runs in config.validate() before dispatch.
  validate(settings: Settings): Result<undefined, PluginConfigError>;
};
