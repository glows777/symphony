// Tracker plugin contract. Post-cutover TS-native design (no Elixir
// counterpart; see MIGRATION.md -> Post-cutover divergence).
//
// A tracker plugin adapts one work-management tool (Linear, in-memory, ...) to
// the orchestrator. The three read operations are required — they drive the
// poll/reconcile/cleanup loops. Everything else (write-backs, agent-facing
// dynamic tools, UI contributions) is an optional capability: plugins for
// tools without a native state machine or comment API simply omit them, and
// the tracker facade reports `unsupported_operation` instead of guessing.

import type { JsonMap, Settings } from "../config/schema.ts";
import type { Issue } from "../linear/issue.ts";
import type { Result } from "../result.ts";

// ---- error model -------------------------------------------------------------

// Normalized error category. Core code branches on `code`; the legacy `tag`
// strings (e.g. `missing_linear_api_token`) are preserved verbatim for
// backwards compatibility with existing switch sites and tests.
export type TrackerErrorCode =
  | "missing_credentials"
  | "missing_config"
  | "transport_failed"
  | "provider_status"
  | "provider_error"
  | "invalid_payload"
  | "unsupported_operation"
  | "unknown";

export type TrackerError = {
  // Stable machine tag, plugin-defined. Existing tags are kept as-is.
  tag: string;
  code: TrackerErrorCode;
  // Operator-facing message supplied by the plugin (replaces core hardcoded
  // provider-specific log copy).
  message: string;
  // Raw payload (HTTP status, provider errors, ...) passed through untouched.
  detail?: unknown;
};

export function trackerError(
  tag: string,
  code: TrackerErrorCode,
  message: string,
  detail?: unknown,
): TrackerError {
  return detail === undefined ? { tag, code, message } : { tag, code, message, detail };
}

// ---- agent-facing dynamic tools ------------------------------------------------

export type AgentToolSpec = { name: string; description: string; inputSchema: JsonMap };

// Plugins return a semantic outcome; protocol encoding (JSON.stringify,
// contentItems wrapping) stays centralized in codex/dynamic-tool.ts.
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

// ---- write-path capabilities ---------------------------------------------------

export type CommentCapability = {
  createComment(issueId: string, body: string): Promise<Result<undefined, unknown>>;
};

export type StateUpdateCapability = {
  updateIssueState(issueId: string, stateName: string): Promise<Result<undefined, unknown>>;
};

// ---- UI contributions ----------------------------------------------------------

export type UiCapability = {
  // Dashboard "Project:" line; null renders "n/a".
  projectUrl?(settings: Settings): string | null;
  // Default Liquid prompt template used when WORKFLOW.md has no body.
  defaultPromptTemplate?: string;
  // Noun used in operator/agent copy, e.g. "Linear issue".
  workItemNoun?: string;
};

// ---- config schema hooks -------------------------------------------------------

export type PluginFieldError = { path: string; message: string };

export type PluginConfigSchema = {
  // Casts the plugin's private fields out of the raw WORKFLOW.md `tracker`
  // section (normalized keys, nils dropped). Synchronous and pure —
  // `settings()` re-parses on every call. Error messages follow the
  // `${section}.${key} <message>` convention from config/schema.ts.
  cast(raw: JsonMap, section: string): { value: JsonMap; errors: PluginFieldError[] };
  // Finalization pass: `$VAR` references and canonical env fallbacks
  // (e.g. LINEAR_API_KEY) are resolved here.
  finalize(value: JsonMap): JsonMap;
  // Semantic validation (previously the hardcoded linear branch of
  // config.validateSemantics). Runs in config.validate() before dispatch.
  validate(settings: Settings): Result<undefined, TrackerError>;
};

// ---- plugin --------------------------------------------------------------------

export type TrackerPlugin = {
  // Matches `tracker.kind` in WORKFLOW.md ("linear", "memory", ...).
  id: string;
  displayName: string;
  configSchema?: PluginConfigSchema;

  // Required core: the three read operations the orchestrator depends on.
  fetchCandidateIssues(): Promise<Result<Issue[], unknown>>;
  fetchIssuesByStates(states: string[]): Promise<Result<Issue[], unknown>>;
  fetchIssueStatesByIds(ids: string[]): Promise<Result<Issue[], unknown>>;

  // Optional capabilities.
  comments?: CommentCapability;
  stateUpdates?: StateUpdateCapability;
  agentTools?: AgentToolCapability;
  ui?: UiCapability;
};
