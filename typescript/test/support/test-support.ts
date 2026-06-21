// Port of `elixir/test/support/test_support.exs` — generates WORKFLOW.md
// fixtures and wires the workflow file path for tests.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { deleteEnv } from "../../src/symphony/app-env.ts";
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
    tracker_active_states: ["Todo", "In Progress"],
    tracker_terminal_states: ["Closed", "Cancelled", "Canceled", "Duplicate", "Done"],
    poll_interval_ms: 30_000,
    workspace_root: DEFAULT_WORKSPACE_ROOT,
    worker_ssh_hosts: [],
    worker_max_concurrent_agents_per_host: null,
    max_concurrent_agents: 10,
    max_turns: 20,
    max_retry_backoff_ms: 300_000,
    max_concurrent_agents_by_state: {},
    codex_command: "codex app-server",
    codex_approval_policy: {
      reject: { sandbox_approval: true, rules: true, mcp_elicitations: true },
    },
    codex_thread_sandbox: "workspace-write",
    codex_turn_sandbox_policy: null,
    codex_turn_timeout_ms: 3_600_000,
    codex_read_timeout_ms: 5_000,
    codex_stall_timeout_ms: 300_000,
    hook_after_create: null,
    hook_before_run: null,
    hook_after_run: null,
    hook_before_remove: null,
    hook_timeout_ms: 60_000,
    observability_enabled: true,
    observability_refresh_ms: 1_000,
    observability_render_interval_ms: 16,
    server_port: null,
    server_host: null,
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
    `  max_concurrent_agents: ${yamlValue(g("max_concurrent_agents"))}`,
    `  max_turns: ${yamlValue(g("max_turns"))}`,
    `  max_retry_backoff_ms: ${yamlValue(g("max_retry_backoff_ms"))}`,
    `  max_concurrent_agents_by_state: ${yamlValue(g("max_concurrent_agents_by_state"))}`,
    "codex:",
    `  command: ${yamlValue(g("codex_command"))}`,
    `  approval_policy: ${yamlValue(g("codex_approval_policy"))}`,
    `  thread_sandbox: ${yamlValue(g("codex_thread_sandbox"))}`,
    `  turn_sandbox_policy: ${yamlValue(g("codex_turn_sandbox_policy"))}`,
    `  turn_timeout_ms: ${yamlValue(g("codex_turn_timeout_ms"))}`,
    `  read_timeout_ms: ${yamlValue(g("codex_read_timeout_ms"))}`,
    `  stall_timeout_ms: ${yamlValue(g("codex_stall_timeout_ms"))}`,
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
    ),
    serverYaml(g("server_port"), g("server_host")),
    "---",
    g("prompt") as string,
  ];

  return `${sections.filter((s) => s !== null && s !== "").join("\n")}\n`;
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
): string {
  return [
    "observability:",
    `  dashboard_enabled: ${yamlValue(enabled)}`,
    `  refresh_ms: ${yamlValue(refreshMs)}`,
    `  render_interval_ms: ${yamlValue(renderIntervalMs)}`,
  ].join("\n");
}

function serverYaml(port: unknown, host: unknown): string | null {
  if ((port === null || port === undefined) && (host === null || host === undefined)) {
    return null;
  }
  const lines = ["server:"];
  if (port !== null && port !== undefined) {
    lines.push(`  port: ${yamlValue(port)}`);
  }
  if (host !== null && host !== undefined) {
    lines.push(`  host: ${yamlValue(host)}`);
  }
  return lines.join("\n");
}

// Mirrors the ExUnit `setup` block: a fresh temp WORKFLOW.md per test.
export function setupWorkflow(): { root: string; workflowFile: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "symphony-workflow-"));
  const workflowFile = path.join(root, "WORKFLOW.md");
  writeWorkflowFile(workflowFile);
  setWorkflowFilePath(workflowFile);
  return { root, workflowFile };
}

export function teardownWorkflow(root: string): void {
  deleteEnv("workflow_file_path");
  deleteEnv("server_port_override");
  deleteEnv("memory_tracker_issues");
  deleteEnv("memory_tracker_recipient");
  deleteEnv("linear_client_module");
  fs.rmSync(root, { recursive: true, force: true });
}
