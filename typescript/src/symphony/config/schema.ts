// Literal port of `symphony_elixir/config/schema.ex`.
//
// The Elixir module uses Ecto embedded schemas + changesets. We reproduce the
// same casting, validation, defaulting, finalization, and error-path formatting
// with a hand-rolled validator (the rulebook maps ecto -> zod, but the changeset
// semantics here — empty_values, update_change, embedded error paths — are
// reproduced directly so behavior matches exactly). See MIGRATION.md.

import os from "node:os";
import path from "node:path";
import { canonicalize } from "../path-safety.ts";
import { agentBackendOrNull } from "../plugins/agents/registry.ts";
import { envReferenceName } from "../plugins/config-helpers.ts";
import { trackerPluginOrNull } from "../plugins/registry.ts";
import { type Result, err, ok } from "../result.ts";

const DEFAULT_WORKSPACE_ROOT = path.join(os.tmpdir(), "symphony_workspaces");

export type JsonMap = { [key: string]: unknown };

// Core tracker settings: only the fields the orchestrator's scheduling loop
// reads (routing labels + state machine vocabulary). Provider-specific fields
// (endpoint, credentials, project selection, ...) live in `plugin`, cast and
// finalized by the active tracker plugin's configSchema; unregistered kinds
// pass the raw section through untouched so validate() can report them.
export type TrackerSettings = {
  kind: string | null;
  requiredLabels: string[];
  activeStates: string[];
  terminalStates: string[];
  plugin: JsonMap;
};

export type PollingSettings = { intervalMs: number };
export type WorkspaceSettings = { root: string };
export type WorkerSettings = { sshHosts: string[]; maxConcurrentAgentsPerHost: number | null };
export type AgentSettings = {
  // Selects the agent backend plugin ("codex" by default; zero migration for
  // existing WORKFLOW.md files). Resolved once per run and pinned by the runner.
  backend: string;
  maxConcurrentAgents: number;
  maxTurns: number;
  maxRetryBackoffMs: number;
  maxConcurrentAgentsByState: JsonMap;
  // Raw contents of the backend's same-named top-level section, cast/finalized
  // by the active backend's configSchema. The codex backend omits a schema, so
  // its `codex` section stays typed in core (settings.codex) and this passes
  // through untouched.
  backendConfig: JsonMap;
};
export type CodexSettings = {
  command: string;
  approvalPolicy: string | JsonMap;
  threadSandbox: string;
  turnSandboxPolicy: JsonMap | null;
  turnTimeoutMs: number;
  readTimeoutMs: number;
  stallTimeoutMs: number;
};
export type HooksSettings = {
  afterCreate: string | null;
  beforeRun: string | null;
  afterRun: string | null;
  beforeRemove: string | null;
  timeoutMs: number;
};
export type ObservabilitySettings = {
  dashboardEnabled: boolean;
  refreshMs: number;
  renderIntervalMs: number;
};
export type ServerSettings = { port: number | null; host: string };

export type Settings = {
  tracker: TrackerSettings;
  polling: PollingSettings;
  workspace: WorkspaceSettings;
  worker: WorkerSettings;
  agent: AgentSettings;
  codex: CodexSettings;
  hooks: HooksSettings;
  observability: ObservabilitySettings;
  server: ServerSettings;
};

export type InvalidWorkflowConfig = { tag: "invalid_workflow_config"; message: string };

const DEFAULT_APPROVAL_POLICY: JsonMap = {
  reject: { sandbox_approval: true, rules: true, mcp_elicitations: true },
};

// ---- public API ------------------------------------------------------------

export function parse(config: JsonMap): Result<Settings, InvalidWorkflowConfig> {
  const normalized = normalizeKeys(config) as JsonMap;
  const dropped = dropNilValues(normalized) as JsonMap;
  const { settings, errors } = changeset(dropped);

  if (errors.length > 0) {
    return err({ tag: "invalid_workflow_config", message: formatErrors(errors) });
  }
  return ok(finalizeSettings(settings));
}

export function resolveTurnSandboxPolicy(settings: Settings, workspace: unknown = null): JsonMap {
  const policy = settings.codex.turnSandboxPolicy;
  if (isMap(policy)) {
    return policy;
  }
  const root = defaultWorkspaceRoot(workspace, settings.workspace.root);
  return defaultTurnSandboxPolicy(expandLocalWorkspaceRoot(root));
}

export function resolveRuntimeTurnSandboxPolicy(
  settings: Settings,
  workspace: unknown = null,
  opts: { remote?: boolean } = {},
): Result<JsonMap, unknown> {
  const policy = settings.codex.turnSandboxPolicy;
  if (isMap(policy)) {
    return ok(policy);
  }
  const root = defaultWorkspaceRoot(workspace, settings.workspace.root);
  return defaultRuntimeTurnSandboxPolicy(root, opts);
}

export function normalizeIssueState(stateName: string): string {
  return stateName.toLowerCase();
}

export function normalizeStateLimits(limits: JsonMap | null | undefined): JsonMap {
  if (limits === null || limits === undefined) {
    return {};
  }
  const acc: JsonMap = {};
  for (const [stateName, limit] of Object.entries(limits)) {
    acc[normalizeIssueState(String(stateName))] = limit;
  }
  return acc;
}

// Returns the list of validation error messages (ecto's validate_state_limits
// pushes one `{field, message}` per offending entry).
export function validateStateLimits(limits: JsonMap): string[] {
  const errors: string[] = [];
  for (const [stateName, limit] of Object.entries(limits)) {
    if (String(stateName) === "") {
      errors.push("state names must not be blank");
    } else if (!Number.isInteger(limit) || (limit as number) <= 0) {
      errors.push("limits must be positive integers");
    }
  }
  return errors;
}

// Mirrors the Ecto.Type custom type used for codex.approval_policy.
export const StringOrMap = {
  type(): "map" {
    return "map";
  },
  embedAs(_format: unknown): "self" {
    return "self";
  },
  equal(left: unknown, right: unknown): boolean {
    return deepEqual(left, right);
  },
  cast(value: unknown): Result<string | JsonMap, "error"> {
    if (typeof value === "string" || isMap(value)) {
      return ok(value as string | JsonMap);
    }
    return err("error");
  },
  load(value: unknown): Result<string | JsonMap, "error"> {
    return StringOrMap.cast(value);
  },
  dump(value: unknown): Result<string | JsonMap, "error"> {
    return StringOrMap.cast(value);
  },
};

// ---- changeset / casting ---------------------------------------------------

type FieldError = { path: string; message: string };
type CastResult = { ok: true; value: unknown } | { ok: false; message: string };

function changeset(attrs: JsonMap): { settings: Settings; errors: FieldError[] } {
  const errors: FieldError[] = [];

  const tracker = castTracker(attrs.tracker, "tracker", errors);
  const polling = castPolling(attrs.polling, "polling", errors);
  const workspace = castWorkspace(attrs.workspace, "workspace", errors);
  const worker = castWorker(attrs.worker, "worker", errors);
  const agent = castAgent(attrs, "agent", errors);
  const codex = castCodex(attrs.codex, "codex", errors);
  const hooks = castHooks(attrs.hooks, "hooks", errors);
  const observability = castObservability(attrs.observability, "observability", errors);
  const server = castServer(attrs.server, "server", errors);

  return {
    settings: { tracker, polling, workspace, worker, agent, codex, hooks, observability, server },
    errors,
  };
}

// Casts a raw section object. Returns the entries that were present (and valid)
// keyed by input key, plus records any cast errors against `errors`.
function castSection(
  raw: unknown,
  section: string,
  errors: FieldError[],
): Map<string, unknown> | null {
  if (raw === undefined) {
    return new Map();
  }
  if (!isMap(raw)) {
    errors.push({ path: section, message: "is invalid" });
    return null;
  }
  return new Map(Object.entries(raw));
}

function castString(v: unknown): CastResult {
  return typeof v === "string" ? { ok: true, value: v } : { ok: false, message: "is invalid" };
}

function castInteger(v: unknown): CastResult {
  if (typeof v === "number" && Number.isInteger(v)) {
    return { ok: true, value: v };
  }
  if (typeof v === "string" && /^-?\d+$/.test(v.trim())) {
    return { ok: true, value: Number.parseInt(v.trim(), 10) };
  }
  return { ok: false, message: "is invalid" };
}

function castBoolean(v: unknown): CastResult {
  return typeof v === "boolean" ? { ok: true, value: v } : { ok: false, message: "is invalid" };
}

function castStringArray(v: unknown): CastResult {
  if (Array.isArray(v) && v.every((item) => typeof item === "string")) {
    return { ok: true, value: v };
  }
  return { ok: false, message: "is invalid" };
}

function castMap(v: unknown): CastResult {
  return isMap(v) ? { ok: true, value: v } : { ok: false, message: "is invalid" };
}

function castStringOrMap(v: unknown): CastResult {
  if (typeof v === "string" || isMap(v)) {
    return { ok: true, value: v };
  }
  return { ok: false, message: "is invalid" };
}

// Applies `cast` for a present field, recording an error on failure. Returns the
// cast value, or `fallback` (the schema default) when absent or invalid.
function field<T>(
  raw: Map<string, unknown> | null,
  inKey: string,
  section: string,
  cast: (v: unknown) => CastResult,
  fallback: T,
  errors: FieldError[],
): { value: T; cast: boolean } {
  if (!raw || !raw.has(inKey)) {
    return { value: fallback, cast: false };
  }
  const result = cast(raw.get(inKey));
  if (result.ok) {
    return { value: result.value as T, cast: true };
  }
  errors.push({ path: `${section}.${inKey}`, message: result.message });
  return { value: fallback, cast: false };
}

function validateGreaterThan(
  field: { value: unknown; cast: boolean },
  section: string,
  inKey: string,
  threshold: number,
  errors: FieldError[],
): void {
  if (typeof field.value === "number" && field.value <= threshold) {
    errors.push({ path: `${section}.${inKey}`, message: `must be greater than ${threshold}` });
  }
}

function validateGreaterThanOrEqual(
  field: { value: unknown; cast: boolean },
  section: string,
  inKey: string,
  threshold: number,
  errors: FieldError[],
): void {
  if (typeof field.value === "number" && field.value < threshold) {
    errors.push({
      path: `${section}.${inKey}`,
      message: `must be greater than or equal to ${threshold}`,
    });
  }
}

function castTracker(raw: unknown, section: string, errors: FieldError[]): TrackerSettings {
  const r = castSection(raw, section, errors);
  const requiredLabels = field<string[]>(
    r,
    "required_labels",
    section,
    castStringArray,
    [],
    errors,
  );
  const kind = field<string | null>(r, "kind", section, castString, null, errors).value;
  return {
    kind,
    requiredLabels: requiredLabels.cast ? normalizeRequiredLabels(requiredLabels.value) : [],
    activeStates: field<string[]>(
      r,
      "active_states",
      section,
      castStringArray,
      ["Todo", "In Progress"],
      errors,
    ).value,
    terminalStates: field<string[]>(
      r,
      "terminal_states",
      section,
      castStringArray,
      ["Closed", "Cancelled", "Canceled", "Duplicate", "Done"],
      errors,
    ).value,
    plugin: castTrackerPluginSection(raw, kind, section, errors),
  };
}

// Delegates the provider-specific fields of the raw tracker section to the
// active plugin's configSchema. Unregistered kinds (including a missing kind)
// pass the section through untouched: parse succeeds and validate() reports
// the unsupported/missing kind, matching the pre-plugin behavior.
function castTrackerPluginSection(
  raw: unknown,
  kind: string | null,
  section: string,
  errors: FieldError[],
): JsonMap {
  const rawSection = isMap(raw) ? raw : {};
  const schema = trackerPluginOrNull(kind)?.configSchema;
  if (schema === undefined) {
    return rawSection;
  }
  const result = schema.cast(rawSection, section);
  errors.push(...result.errors);
  return result.value;
}

function normalizeRequiredLabels(labels: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const label of labels) {
    const normalized = label.trim().toLowerCase();
    if (!seen.has(normalized)) {
      seen.add(normalized);
      result.push(normalized);
    }
  }
  return result;
}

function castPolling(raw: unknown, section: string, errors: FieldError[]): PollingSettings {
  const r = castSection(raw, section, errors);
  const intervalMs = field<number>(r, "interval_ms", section, castInteger, 30_000, errors);
  validateGreaterThan(intervalMs, section, "interval_ms", 0, errors);
  return { intervalMs: intervalMs.value };
}

function castWorkspace(raw: unknown, section: string, errors: FieldError[]): WorkspaceSettings {
  const r = castSection(raw, section, errors);
  return {
    root: field<string>(r, "root", section, castString, DEFAULT_WORKSPACE_ROOT, errors).value,
  };
}

function castWorker(raw: unknown, section: string, errors: FieldError[]): WorkerSettings {
  const r = castSection(raw, section, errors);
  const maxPerHost = field<number | null>(
    r,
    "max_concurrent_agents_per_host",
    section,
    castInteger,
    null,
    errors,
  );
  validateGreaterThan(maxPerHost, section, "max_concurrent_agents_per_host", 0, errors);
  return {
    sshHosts: field<string[]>(r, "ssh_hosts", section, castStringArray, [], errors).value,
    maxConcurrentAgentsPerHost: maxPerHost.value,
  };
}

// Takes the full attrs map (not just the `agent` section): the selected
// backend's config lives in a top-level sibling section named after the
// backend, so `backend: codex` claims the top-level `codex` section.
function castAgent(attrs: JsonMap, section: string, errors: FieldError[]): AgentSettings {
  const r = castSection(attrs.agent, section, errors);
  const backend = field<string>(r, "backend", section, castString, "codex", errors).value;
  const maxConcurrent = field<number>(r, "max_concurrent_agents", section, castInteger, 10, errors);
  validateGreaterThan(maxConcurrent, section, "max_concurrent_agents", 0, errors);
  const maxTurns = field<number>(r, "max_turns", section, castInteger, 20, errors);
  validateGreaterThan(maxTurns, section, "max_turns", 0, errors);
  const maxBackoff = field<number>(
    r,
    "max_retry_backoff_ms",
    section,
    castInteger,
    300_000,
    errors,
  );
  validateGreaterThan(maxBackoff, section, "max_retry_backoff_ms", 0, errors);

  const byStateField = field<JsonMap>(
    r,
    "max_concurrent_agents_by_state",
    section,
    castMap,
    {},
    errors,
  );
  const byState = byStateField.cast ? normalizeStateLimits(byStateField.value) : {};
  if (byStateField.cast) {
    for (const message of validateStateLimits(byState)) {
      errors.push({ path: `${section}.max_concurrent_agents_by_state`, message });
    }
  }

  return {
    backend,
    maxConcurrentAgents: maxConcurrent.value,
    maxTurns: maxTurns.value,
    maxRetryBackoffMs: maxBackoff.value,
    maxConcurrentAgentsByState: byState,
    backendConfig: castAgentBackendSection(attrs, backend, errors),
  };
}

// Delegates the selected backend's private top-level section to its
// configSchema. The codex backend omits a schema, so its `codex` section passes
// through untouched (parse succeeds; validate() reports an unsupported backend).
// Mirrors castTrackerPluginSection.
function castAgentBackendSection(attrs: JsonMap, backend: string, errors: FieldError[]): JsonMap {
  const rawSection = isMap(attrs[backend]) ? attrs[backend] : {};
  const schema = agentBackendOrNull(backend)?.configSchema;
  if (schema === undefined) {
    return rawSection;
  }
  const result = schema.cast(rawSection, backend);
  errors.push(...result.errors);
  return result.value;
}

function castCodex(raw: unknown, section: string, errors: FieldError[]): CodexSettings {
  const r = castSection(raw, section, errors);
  const command = field<string>(r, "command", section, castString, "codex app-server", errors);
  if (command.value === "") {
    errors.push({ path: `${section}.command`, message: "can't be blank" });
  }
  const turnTimeout = field<number>(r, "turn_timeout_ms", section, castInteger, 3_600_000, errors);
  validateGreaterThan(turnTimeout, section, "turn_timeout_ms", 0, errors);
  const readTimeout = field<number>(r, "read_timeout_ms", section, castInteger, 5_000, errors);
  validateGreaterThan(readTimeout, section, "read_timeout_ms", 0, errors);
  const stallTimeout = field<number>(r, "stall_timeout_ms", section, castInteger, 300_000, errors);
  validateGreaterThanOrEqual(stallTimeout, section, "stall_timeout_ms", 0, errors);

  return {
    command: command.value,
    approvalPolicy: field<string | JsonMap>(
      r,
      "approval_policy",
      section,
      castStringOrMap,
      DEFAULT_APPROVAL_POLICY,
      errors,
    ).value,
    threadSandbox: field<string>(
      r,
      "thread_sandbox",
      section,
      castString,
      "workspace-write",
      errors,
    ).value,
    turnSandboxPolicy: field<JsonMap | null>(
      r,
      "turn_sandbox_policy",
      section,
      castMap,
      null,
      errors,
    ).value,
    turnTimeoutMs: turnTimeout.value,
    readTimeoutMs: readTimeout.value,
    stallTimeoutMs: stallTimeout.value,
  };
}

function castHooks(raw: unknown, section: string, errors: FieldError[]): HooksSettings {
  const r = castSection(raw, section, errors);
  const timeoutMs = field<number>(r, "timeout_ms", section, castInteger, 60_000, errors);
  validateGreaterThan(timeoutMs, section, "timeout_ms", 0, errors);
  return {
    afterCreate: field<string | null>(r, "after_create", section, castString, null, errors).value,
    beforeRun: field<string | null>(r, "before_run", section, castString, null, errors).value,
    afterRun: field<string | null>(r, "after_run", section, castString, null, errors).value,
    beforeRemove: field<string | null>(r, "before_remove", section, castString, null, errors).value,
    timeoutMs: timeoutMs.value,
  };
}

function castObservability(
  raw: unknown,
  section: string,
  errors: FieldError[],
): ObservabilitySettings {
  const r = castSection(raw, section, errors);
  const refreshMs = field<number>(r, "refresh_ms", section, castInteger, 1_000, errors);
  validateGreaterThan(refreshMs, section, "refresh_ms", 0, errors);
  const renderIntervalMs = field<number>(r, "render_interval_ms", section, castInteger, 16, errors);
  validateGreaterThan(renderIntervalMs, section, "render_interval_ms", 0, errors);
  return {
    dashboardEnabled: field<boolean>(r, "dashboard_enabled", section, castBoolean, true, errors)
      .value,
    refreshMs: refreshMs.value,
    renderIntervalMs: renderIntervalMs.value,
  };
}

function castServer(raw: unknown, section: string, errors: FieldError[]): ServerSettings {
  const r = castSection(raw, section, errors);
  const port = field<number | null>(r, "port", section, castInteger, null, errors);
  validateGreaterThanOrEqual(port, section, "port", 0, errors);
  return {
    port: port.value,
    host: field<string>(r, "host", section, castString, "127.0.0.1", errors).value,
  };
}

// ---- finalization ----------------------------------------------------------

function finalizeSettings(settings: Settings): Settings {
  return {
    ...settings,
    tracker: {
      ...settings.tracker,
      plugin: finalizeTrackerPluginSection(settings.tracker),
    },
    agent: {
      ...settings.agent,
      backendConfig: finalizeAgentBackendSection(settings.agent),
    },
    workspace: {
      ...settings.workspace,
      root: resolvePathValue(settings.workspace.root, DEFAULT_WORKSPACE_ROOT),
    },
    codex: {
      ...settings.codex,
      approvalPolicy: normalizeKeys(settings.codex.approvalPolicy) as string | JsonMap,
      turnSandboxPolicy: normalizeOptionalMap(settings.codex.turnSandboxPolicy),
    },
  };
}

// Plugin finalization pass ($VAR references, canonical env fallbacks such as
// LINEAR_API_KEY). Unregistered kinds keep the raw pass-through section.
function finalizeTrackerPluginSection(tracker: TrackerSettings): JsonMap {
  const schema = trackerPluginOrNull(tracker.kind)?.configSchema;
  if (schema === undefined) {
    return tracker.plugin;
  }
  return schema.finalize(tracker.plugin);
}

// Backend finalization pass. The codex backend omits a schema, so its section
// passes through untouched.
function finalizeAgentBackendSection(agent: AgentSettings): JsonMap {
  const schema = agentBackendOrNull(agent.backend)?.configSchema;
  if (schema === undefined) {
    return agent.backendConfig;
  }
  return schema.finalize(agent.backendConfig);
}

function resolvePathValue(value: string, fallback: string): string {
  const token = normalizePathToken(value);
  if (token === MISSING || token === "") {
    return fallback;
  }
  return token;
}

const MISSING = Symbol("missing");

function normalizePathToken(value: string): string | typeof MISSING {
  const envName = envReferenceName(value);
  if (envName === null) {
    return value;
  }
  const envValue = process.env[envName];
  return envValue === undefined ? MISSING : envValue;
}

function normalizeOptionalMap(value: JsonMap | null): JsonMap | null {
  return value === null ? null : (normalizeKeys(value) as JsonMap);
}

// ---- sandbox policy helpers ------------------------------------------------

function defaultTurnSandboxPolicy(workspace: unknown): JsonMap {
  return {
    type: "workspaceWrite",
    writableRoots: [workspace],
    readOnlyAccess: { type: "fullAccess" },
    networkAccess: false,
    excludeTmpdirEnvVar: false,
    excludeSlashTmp: false,
  };
}

function defaultRuntimeTurnSandboxPolicy(
  workspaceRoot: unknown,
  opts: { remote?: boolean },
): Result<JsonMap, unknown> {
  if (typeof workspaceRoot !== "string") {
    return err({
      tag: "unsafe_turn_sandbox_policy",
      reason: { tag: "invalid_workspace_root", value: workspaceRoot },
    });
  }
  if (opts.remote === true) {
    return ok(defaultTurnSandboxPolicy(workspaceRoot));
  }
  const expanded = expandLocalWorkspaceRoot(workspaceRoot);
  const canonical = canonicalize(expanded);
  if (!canonical.ok) {
    return err(canonical.error);
  }
  return ok(defaultTurnSandboxPolicy(canonical.value));
}

function defaultWorkspaceRoot(workspace: unknown, fallback: string): unknown {
  if (typeof workspace === "string") {
    return workspace === "" ? fallback : workspace;
  }
  if (workspace === null || workspace === undefined) {
    return fallback;
  }
  return workspace;
}

function expandLocalWorkspaceRoot(workspaceRoot: unknown): string {
  if (typeof workspaceRoot === "string" && workspaceRoot !== "") {
    return path.resolve(workspaceRoot);
  }
  return path.resolve(DEFAULT_WORKSPACE_ROOT);
}

// ---- generic helpers -------------------------------------------------------

function normalizeKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(normalizeKeys);
  }
  if (isMap(value)) {
    const result: JsonMap = {};
    for (const [key, raw] of Object.entries(value)) {
      result[String(key)] = normalizeKeys(raw);
    }
    return result;
  }
  return value;
}

function dropNilValues(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(dropNilValues);
  }
  if (isMap(value)) {
    const result: JsonMap = {};
    for (const [key, nested] of Object.entries(value)) {
      const normalized = dropNilValues(nested);
      if (normalized !== null && normalized !== undefined) {
        result[key] = normalized;
      }
    }
    return result;
  }
  return value;
}

function formatErrors(errors: FieldError[]): string {
  return errors.map((e) => `${e.path} ${e.message}`).join(", ");
}

function isMap(value: unknown): value is JsonMap {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) {
    return true;
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, i) => deepEqual(item, b[i]));
  }
  if (isMap(a) && isMap(b)) {
    const keysA = Object.keys(a);
    const keysB = Object.keys(b);
    return keysA.length === keysB.length && keysA.every((k) => deepEqual(a[k], b[k]));
  }
  return false;
}
