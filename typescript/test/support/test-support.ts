// Port of `elixir/test/support/test_support.exs` — generates WORKFLOW.md
// fixtures and wires the workflow file path for tests.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resetAgentOutputStoreForTest } from "../../src/symphony/agent-output-store.ts";
import { deleteEnv, putEnv } from "../../src/symphony/app-env.ts";
import { resetTokenCacheForTest as resetLarkTokenCache } from "../../src/symphony/plugins/trackers/lark-common/http.ts";
import { getRunningStore } from "../../src/symphony/workflow-store.ts";
import { setWorkflowFilePath } from "../../src/symphony/workflow.ts";

const WORKFLOW_PROMPT = "You are an agent for this repository.";

type Overrides = Record<string, unknown>;

const DEFAULT_WORKSPACE_ROOT = path.join(os.tmpdir(), "symphony_workspaces");

function defaults(): Overrides {
  return {
    tracker_kind: "linear",
    tracker_endpoint: "https://api.linear.app/graphql",
    tracker_api_token: "token",
    tracker_project_slug: "project",
    tracker_assignee: null,
    tracker_required_labels: [],
    tracker_active_states: ["Todo", "In Progress", "Rework"],
    tracker_terminal_states: ["Closed", "Cancelled", "Canceled", "Duplicate", "Done"],
    poll_interval_ms: 30_000,
    workspace_root: DEFAULT_WORKSPACE_ROOT,
    worker_ssh_hosts: [],
    worker_max_concurrent_agents_per_host: null,
    agent_backend: null,
    max_concurrent_agents: 10,
    max_turns: 20,
    max_retry_backoff_ms: 300_000,
    max_concurrent_agents_by_state: {},
    codex_command: "codex app-server",
    codex_approval_policy: "on-request",
    codex_permission_profile: null,
    codex_thread_sandbox: "workspace-write",
    codex_turn_sandbox_policy: null,
    codex_turn_timeout_ms: 3_600_000,
    codex_read_timeout_ms: 5_000,
    codex_stall_timeout_ms: 300_000,
    // Emitted as a top-level `claude_code:` section only when set to a map
    // (see claudeCodeYaml); absent by default so existing fixtures are unchanged.
    claude_code: null,
    hook_after_create: null,
    hook_before_run: null,
    hook_after_run: null,
    hook_before_remove: null,
    hook_timeout_ms: 60_000,
    observability_enabled: true,
    observability_refresh_ms: 1_000,
    observability_render_interval_ms: 16,
    observability_agent_output: "summary",
    observability_agent_output_max_event_bytes: 64 * 1024,
    observability_agent_output_max_file_bytes: 64 * 1024 * 1024,
    server_port: null,
    server_host: null,
    server_unsafe_allow_remote: false,
    prompt: WORKFLOW_PROMPT,
  };
}

export function writeWorkflowFile(filePath: string, overrides: Overrides = {}): void {
  fs.writeFileSync(filePath, workflowContent(overrides));
  const store = getRunningStore();
  if (store) {
    store.forceReload();
  }
}

function workflowContent(overrides: Overrides): string {
  const config = { ...defaults(), ...overrides };
  const g = (key: string): unknown => config[key];

  const sections: (string | null)[] = [
    "---",
    "tracker:",
    `  kind: ${yamlValue(g("tracker_kind"))}`,
    `  endpoint: ${yamlValue(g("tracker_endpoint"))}`,
    `  api_key: ${yamlValue(g("tracker_api_token"))}`,
    `  project_slug: ${yamlValue(g("tracker_project_slug"))}`,
    `  assignee: ${yamlValue(g("tracker_assignee"))}`,
    `  required_labels: ${yamlValue(g("tracker_required_labels"))}`,
    `  active_states: ${yamlValue(g("tracker_active_states"))}`,
    `  terminal_states: ${yamlValue(g("tracker_terminal_states"))}`,
    "polling:",
    `  interval_ms: ${yamlValue(g("poll_interval_ms"))}`,
    "workspace:",
    `  root: ${yamlValue(g("workspace_root"))}`,
    workerYaml(g("worker_ssh_hosts"), g("worker_max_concurrent_agents_per_host")),
    "agent:",
    agentBackendLine(g("agent_backend")),
    `  max_concurrent_agents: ${yamlValue(g("max_concurrent_agents"))}`,
    `  max_turns: ${yamlValue(g("max_turns"))}`,
    `  max_retry_backoff_ms: ${yamlValue(g("max_retry_backoff_ms"))}`,
    `  max_concurrent_agents_by_state: ${yamlValue(g("max_concurrent_agents_by_state"))}`,
    "codex:",
    `  command: ${yamlValue(g("codex_command"))}`,
    `  approval_policy: ${yamlValue(g("codex_approval_policy"))}`,
    codexPermissionProfileLine(g("codex_permission_profile")),
    `  thread_sandbox: ${yamlValue(g("codex_thread_sandbox"))}`,
    `  turn_sandbox_policy: ${yamlValue(g("codex_turn_sandbox_policy"))}`,
    `  turn_timeout_ms: ${yamlValue(g("codex_turn_timeout_ms"))}`,
    `  read_timeout_ms: ${yamlValue(g("codex_read_timeout_ms"))}`,
    `  stall_timeout_ms: ${yamlValue(g("codex_stall_timeout_ms"))}`,
    claudeCodeYaml(g("claude_code")),
    hooksYaml(
      g("hook_after_create"),
      g("hook_before_run"),
      g("hook_after_run"),
      g("hook_before_remove"),
      g("hook_timeout_ms"),
    ),
    observabilityYaml(
      g("observability_enabled"),
      g("observability_refresh_ms"),
      g("observability_render_interval_ms"),
      g("observability_agent_output"),
      g("observability_agent_output_max_event_bytes"),
      g("observability_agent_output_max_file_bytes"),
    ),
    serverYaml(g("server_port"), g("server_host"), g("server_unsafe_allow_remote")),
    "---",
    g("prompt") as string,
  ];

  return `${sections.filter((s) => s !== null && s !== "").join("\n")}\n`;
}

function codexPermissionProfileLine(value: unknown): string | null {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  return `  permission_profile: ${yamlValue(value)}`;
}

function yamlValue(value: unknown): string {
  if (typeof value === "string") {
    return `"${value.replace(/"/g, '\\"')}"`;
  }
  if (typeof value === "number") {
    return String(value);
  }
  if (value === true) {
    return "true";
  }
  if (value === false) {
    return "false";
  }
  if (value === null || value === undefined) {
    return "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map(yamlValue).join(", ")}]`;
  }
  if (typeof value === "object") {
    const entries = Object.entries(value).map(
      ([key, v]) => `${yamlValue(String(key))}: ${yamlValue(v)}`,
    );
    return `{${entries.join(", ")}}`;
  }
  return yamlValue(String(value));
}

function isBlank(value: unknown): boolean {
  return value === null || value === undefined || (Array.isArray(value) && value.length === 0);
}

// Emits `  backend: <value>` only when set, so the default WORKFLOW.md leaves
// `agent.backend` absent (defaulting to codex, zero migration).
function agentBackendLine(backend: unknown): string | null {
  if (backend === null || backend === undefined) {
    return null;
  }
  return `  backend: ${yamlValue(backend)}`;
}

// Emits the top-level `claude_code:` backend section as a YAML block, but only
// when the override is a map (default null -> omitted, existing fixtures
// unchanged). Keys are written verbatim (command, permission_mode, model,
// allowed_tools, disallowed_tools, turn_timeout_ms, read_timeout_ms).
function claudeCodeYaml(config: unknown): string | null {
  if (
    config === null ||
    config === undefined ||
    typeof config !== "object" ||
    Array.isArray(config)
  ) {
    return null;
  }
  const lines = ["claude_code:"];
  for (const [key, value] of Object.entries(config)) {
    lines.push(`  ${key}: ${yamlValue(value)}`);
  }
  return lines.join("\n");
}

function workerYaml(sshHosts: unknown, maxPerHost: unknown): string | null {
  if (isBlank(sshHosts) && (maxPerHost === null || maxPerHost === undefined)) {
    return null;
  }
  const lines = ["worker:"];
  if (!isBlank(sshHosts)) {
    lines.push(`  ssh_hosts: ${yamlValue(sshHosts)}`);
  }
  if (maxPerHost !== null && maxPerHost !== undefined) {
    lines.push(`  max_concurrent_agents_per_host: ${yamlValue(maxPerHost)}`);
  }
  return lines.join("\n");
}

function hooksYaml(
  afterCreate: unknown,
  beforeRun: unknown,
  afterRun: unknown,
  beforeRemove: unknown,
  timeoutMs: unknown,
): string {
  if (afterCreate === null && beforeRun === null && afterRun === null && beforeRemove === null) {
    return `hooks:\n  timeout_ms: ${yamlValue(timeoutMs)}`;
  }
  const lines = [
    "hooks:",
    `  timeout_ms: ${yamlValue(timeoutMs)}`,
    hookEntry("after_create", afterCreate),
    hookEntry("before_run", beforeRun),
    hookEntry("after_run", afterRun),
    hookEntry("before_remove", beforeRemove),
  ].filter((l): l is string => l !== null);
  return lines.join("\n");
}

function hookEntry(name: string, command: unknown): string | null {
  if (command === null || command === undefined) {
    return null;
  }
  const indented = String(command)
    .split("\n")
    .map((line) => `    ${line}`)
    .join("\n");
  return `  ${name}: |\n${indented}`;
}

function observabilityYaml(
  enabled: unknown,
  refreshMs: unknown,
  renderIntervalMs: unknown,
  agentOutput: unknown,
  maxEventBytes: unknown,
  maxFileBytes: unknown,
): string {
  return [
    "observability:",
    `  dashboard_enabled: ${yamlValue(enabled)}`,
    `  refresh_ms: ${yamlValue(refreshMs)}`,
    `  render_interval_ms: ${yamlValue(renderIntervalMs)}`,
    `  agent_output: ${yamlValue(agentOutput)}`,
    `  agent_output_max_event_bytes: ${yamlValue(maxEventBytes)}`,
    `  agent_output_max_file_bytes: ${yamlValue(maxFileBytes)}`,
  ].join("\n");
}

function serverYaml(port: unknown, host: unknown, unsafeAllowRemote: unknown): string | null {
  if (
    (port === null || port === undefined) &&
    (host === null || host === undefined) &&
    unsafeAllowRemote === false
  ) {
    return null;
  }
  const lines = ["server:"];
  if (port !== null && port !== undefined) {
    lines.push(`  port: ${yamlValue(port)}`);
  }
  if (host !== null && host !== undefined) {
    lines.push(`  host: ${yamlValue(host)}`);
  }
  if (
    unsafeAllowRemote !== null &&
    unsafeAllowRemote !== undefined &&
    unsafeAllowRemote !== false
  ) {
    lines.push(`  unsafe_allow_remote: ${yamlValue(unsafeAllowRemote)}`);
  }
  return lines.join("\n");
}

export function setupAgentOutputRoot(root: string): string {
  const agentOutputRoot = path.join(root, "agent-output");
  putEnv("agent_output_root", agentOutputRoot);
  return agentOutputRoot;
}

// Mirrors the ExUnit `setup` block: a fresh temp WORKFLOW.md per test.
export function setupWorkflow(): { root: string; workflowFile: string; agentOutputRoot: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "symphony-workflow-"));
  const workflowFile = path.join(root, "WORKFLOW.md");
  const agentOutputRoot = setupAgentOutputRoot(root);
  writeWorkflowFile(workflowFile);
  setWorkflowFilePath(workflowFile);
  return { root, workflowFile, agentOutputRoot };
}

export function teardownWorkflow(root: string): void {
  deleteEnv("workflow_file_path");
  deleteEnv("server_port_override");
  deleteEnv("memory_tracker_issues");
  deleteEnv("memory_tracker_recipient");
  deleteEnv("linear_client_module");
  deleteEnv("lark_client_module");
  deleteEnv("lark_task_client_module");
  deleteEnv("gitea_client_module");
  deleteEnv("tracker_plugin_overrides");
  deleteEnv("agent_backend_overrides");
  deleteEnv("agent_output_root");
  resetAgentOutputStoreForTest();
  // The token cache is shared by the lark-family plugins (lark, lark-task).
  resetLarkTokenCache();
  fs.rmSync(root, { recursive: true, force: true });
}
