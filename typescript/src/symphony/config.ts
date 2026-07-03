// Literal port of `symphony_elixir/config.ex`.
//
// Runtime configuration loaded from WORKFLOW.md.

// Side-effect import: built-in tracker plugins must be registered before
// settings are parsed (schema casting delegates the tracker plugin section).
import "./plugins/index.ts";

import { getEnv } from "./app-env.ts";
import {
  type JsonMap,
  type Settings,
  normalizeIssueState,
  parse as parseSchema,
  resolveRuntimeTurnSandboxPolicy,
} from "./config/schema.ts";
import { trackerPlugin, trackerPluginOrNull } from "./plugins/registry.ts";
import { type Result, err, ok } from "./result.ts";
import { current as workflowCurrent } from "./workflow.ts";

// Provider-neutral fallback; plugins may contribute their own copy via the
// ui.defaultPromptTemplate capability (the Linear plugin restores the
// original "Linear issue" wording).
const GENERIC_PROMPT_TEMPLATE = `You are working on a work item.

Identifier: {{ issue.identifier }}
Title: {{ issue.title }}

Body:
{% if issue.description %}
{{ issue.description }}
{% else %}
No description provided.
{% endif %}
`;

export type CodexRuntimeSettings = {
  approvalPolicy: string | JsonMap;
  threadSandbox: string;
  turnSandboxPolicy: JsonMap;
};

export function settings(): Result<Settings, unknown> {
  const workflow = workflowCurrent();
  if (!workflow.ok) {
    return err(workflow.error);
  }
  const config = workflow.value.config;
  return parseSchema(config);
}

export function settingsBang(): Settings {
  const result = settings();
  if (result.ok) {
    return result.value;
  }
  throw new Error(formatConfigError(result.error));
}

export function maxConcurrentAgentsForState(stateName: unknown): number {
  const config = settingsBang();
  if (typeof stateName !== "string") {
    return config.agent.maxConcurrentAgents;
  }
  const key = normalizeIssueState(stateName);
  const limit = config.agent.maxConcurrentAgentsByState[key];
  return typeof limit === "number" ? limit : config.agent.maxConcurrentAgents;
}

export function codexTurnSandboxPolicy(workspace: unknown = null): JsonMap {
  const result = resolveRuntimeTurnSandboxPolicy(settingsBang(), workspace);
  if (result.ok) {
    return result.value;
  }
  throw new Error(`Invalid codex turn sandbox policy: ${inspect(result.error)}`);
}

export function workflowPrompt(): string {
  const workflow = workflowCurrent();
  if (workflow.ok) {
    const prompt = workflow.value.promptTemplate;
    return prompt.trim() === "" ? defaultPromptTemplate() : prompt;
  }
  return defaultPromptTemplate();
}

function defaultPromptTemplate(): string {
  const config = settings();
  if (!config.ok) {
    return GENERIC_PROMPT_TEMPLATE;
  }
  const plugin = trackerPluginOrNull(config.value.tracker.kind);
  return plugin?.ui?.defaultPromptTemplate ?? GENERIC_PROMPT_TEMPLATE;
}

export function serverPort(): number | null {
  const override = getEnv<unknown>("server_port_override", null);
  if (typeof override === "number" && Number.isInteger(override) && override >= 0) {
    return override;
  }
  return settingsBang().server.port;
}

export function validate(): Result<undefined, unknown> {
  const result = settings();
  if (!result.ok) {
    return err(result.error);
  }
  return validateSemantics(result.value);
}

export function codexRuntimeSettings(
  workspace: unknown = null,
  opts: { remote?: boolean } = {},
): Result<CodexRuntimeSettings, unknown> {
  const result = settings();
  if (!result.ok) {
    return err(result.error);
  }
  const policy = resolveRuntimeTurnSandboxPolicy(result.value, workspace, opts);
  if (!policy.ok) {
    return err(policy.error);
  }
  return ok({
    approvalPolicy: result.value.codex.approvalPolicy,
    threadSandbox: result.value.codex.threadSandbox,
    turnSandboxPolicy: policy.value,
  });
}

function validateSemantics(settings: Settings): Result<undefined, unknown> {
  const plugin = trackerPlugin(settings.tracker.kind);
  if (!plugin.ok) {
    return err(plugin.error);
  }
  const schema = plugin.value.configSchema;
  if (schema === undefined) {
    return ok(undefined);
  }
  return schema.validate(settings);
}

function formatConfigError(reason: unknown): string {
  if (isTagged(reason, "invalid_workflow_config")) {
    return `Invalid WORKFLOW.md config: ${(reason as { message: string }).message}`;
  }
  if (isTagged(reason, "missing_workflow_file")) {
    const r = reason as { path: string; reason: unknown };
    return `Missing WORKFLOW.md at ${r.path}: ${inspect(r.reason)}`;
  }
  if (isTagged(reason, "workflow_parse_error")) {
    return `Failed to parse WORKFLOW.md: ${inspect((reason as { reason: unknown }).reason)}`;
  }
  if (isTagged(reason, "workflow_front_matter_not_a_map")) {
    return "Failed to parse WORKFLOW.md: workflow front matter must decode to a map";
  }
  return `Invalid WORKFLOW.md config: ${inspect(reason)}`;
}

function isTagged(value: unknown, tag: string): boolean {
  return typeof value === "object" && value !== null && (value as { tag?: string }).tag === tag;
}

function inspect(value: unknown): string {
  if (typeof value === "string") {
    return `:${value}`;
  }
  return JSON.stringify(value);
}
