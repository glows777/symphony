// Literal port of `symphony_elixir/workspace.ex`.
//
// Creates isolated per-issue workspaces for parallel Codex agents. Local paths
// use node fs; remote paths drive the worker over SSH. Hooks run via
// Bun.spawnSync (System.cmd/Task.yield -> spawnSync with a timeout). The remote
// timeout flows through SSH's timeout extension and is exercised by live e2e.

import fs from "node:fs";
import path from "node:path";
import { settingsBang } from "./config.ts";
import { logger } from "./logger.ts";
import { canonicalize } from "./path-safety.ts";
import type { Issue } from "./plugins/work-item.ts";
import { type Result, err, ok } from "./result.ts";
import * as SSH from "./ssh.ts";

const REMOTE_WORKSPACE_MARKER = "__SYMPHONY_WORKSPACE__";

export type WorkerHost = string | null;

type IssueContext = { issueId: string | null; issueIdentifier: string };

// Local removals return the list of removed paths; root-protection and other
// validation errors carry the distinct 3-element shape from Elixir.
export type RemoveResult =
  | { ok: true; value: string[] }
  | { ok: false; error: unknown; output: string };

export function createForIssue(
  issueOrIdentifier: Issue | string | null,
  workerHost: WorkerHost = null,
): Result<string, unknown> {
  const issueCtx = issueContext(issueOrIdentifier);

  try {
    const safeId = safeIdentifier(issueCtx.issueIdentifier);

    const pathResult = workspacePathForIssue(safeId, workerHost);
    if (!pathResult.ok) {
      return err(pathResult.error);
    }
    const validation = validateWorkspacePath(pathResult.value, workerHost);
    if (!validation.ok) {
      return err(validation.error);
    }
    const ensured = ensureWorkspace(pathResult.value, workerHost);
    if (!ensured.ok) {
      return err(ensured.error);
    }
    const hook = maybeRunAfterCreateHook(
      ensured.value.workspace,
      issueCtx,
      ensured.value.created,
      workerHost,
    );
    if (!hook.ok) {
      return err(hook.error);
    }
    return ok(ensured.value.workspace);
  } catch (error) {
    logger.error(
      `Workspace creation failed ${issueLogContext(issueCtx)} worker_host=${workerHostForLog(workerHost)} error=${(error as Error).message}`,
    );
    return err(error);
  }
}

type EnsureResult = Result<{ workspace: string; created: boolean }, unknown>;

function ensureWorkspace(workspace: string, workerHost: WorkerHost): EnsureResult {
  if (workerHost === null) {
    if (isDir(workspace)) {
      return ok({ workspace, created: false });
    }
    if (fs.existsSync(workspace)) {
      fs.rmSync(workspace, { recursive: true, force: true });
      return createWorkspace(workspace);
    }
    return createWorkspace(workspace);
  }
  return ensureRemoteWorkspace(workspace, workerHost);
}

function ensureRemoteWorkspace(workspace: string, workerHost: string): EnsureResult {
  const script = [
    "set -eu",
    remoteShellAssign("workspace", workspace),
    'if [ -d "$workspace" ]; then',
    "  created=0",
    'elif [ -e "$workspace" ]; then',
    '  rm -rf "$workspace"',
    '  mkdir -p "$workspace"',
    "  created=1",
    "else",
    '  mkdir -p "$workspace"',
    "  created=1",
    "fi",
    'cd "$workspace"',
    `printf '%s\\t%s\\t%s\\n' '${REMOTE_WORKSPACE_MARKER}' "$created" "$(pwd -P)"`,
  ]
    .filter((line) => line !== "")
    .join("\n");

  const result = runRemoteCommand(workerHost, script, settingsBang().hooks.timeoutMs);
  if (!result.ok) {
    return err(result.error);
  }
  const [output, status] = result.value;
  if (status === 0) {
    return parseRemoteWorkspaceOutput(output);
  }
  return err({ tag: "workspace_prepare_failed", workerHost, status, output });
}

function createWorkspace(workspace: string): EnsureResult {
  fs.rmSync(workspace, { recursive: true, force: true });
  fs.mkdirSync(workspace, { recursive: true });
  return ok({ workspace, created: true });
}

export function remove(workspace: string, workerHost: WorkerHost = null): RemoveResult {
  if (workerHost === null) {
    if (fs.existsSync(workspace)) {
      const validation = validateWorkspacePath(workspace, null);
      if (!validation.ok) {
        return { ok: false, error: validation.error, output: "" };
      }
      maybeRunBeforeRemoveHook(workspace, null);
      return removeLocal(workspace);
    }
    return removeLocal(workspace);
  }

  maybeRunBeforeRemoveHook(workspace, workerHost);
  const script = [remoteShellAssign("workspace", workspace), 'rm -rf "$workspace"'].join("\n");
  const result = runRemoteCommand(workerHost, script, settingsBang().hooks.timeoutMs);
  if (!result.ok) {
    return { ok: false, error: result.error, output: "" };
  }
  const [output, status] = result.value;
  if (status === 0) {
    return { ok: true, value: [] };
  }
  return {
    ok: false,
    error: { tag: "workspace_remove_failed", workerHost, status, output },
    output: "",
  };
}

// `File.rm_rf/1` — returns the removed paths (best-effort list) on success.
function removeLocal(workspace: string): RemoveResult {
  const removed = fs.existsSync(workspace) ? [workspace] : [];
  fs.rmSync(workspace, { recursive: true, force: true });
  return { ok: true, value: removed };
}

export function removeIssueWorkspaces(identifier: unknown, workerHost: WorkerHost = null): void {
  if (typeof identifier === "string" && typeof workerHost === "string") {
    const safeId = safeIdentifier(identifier);
    const pathResult = workspacePathForIssue(safeId, workerHost);
    if (pathResult.ok) {
      remove(pathResult.value, workerHost);
    }
    return;
  }

  if (typeof identifier === "string" && workerHost === null) {
    const safeId = safeIdentifier(identifier);
    const sshHosts = settingsBang().worker.sshHosts;
    if (sshHosts.length === 0) {
      const pathResult = workspacePathForIssue(safeId, null);
      if (pathResult.ok) {
        remove(pathResult.value, null);
      }
    } else {
      for (const host of sshHosts) {
        removeIssueWorkspaces(identifier, host);
      }
    }
    return;
  }
}

export function runBeforeRunHook(
  workspace: string,
  issueOrIdentifier: Issue | string | null,
  workerHost: WorkerHost = null,
): Result<undefined, unknown> {
  const issueCtx = issueContext(issueOrIdentifier);
  const hooks = settingsBang().hooks;
  if (hooks.beforeRun === null) {
    return ok(undefined);
  }
  return runHook(hooks.beforeRun, workspace, issueCtx, "before_run", workerHost);
}

export function runAfterRunHook(
  workspace: string,
  issueOrIdentifier: Issue | string | null,
  workerHost: WorkerHost = null,
): Result<undefined, unknown> {
  const issueCtx = issueContext(issueOrIdentifier);
  const hooks = settingsBang().hooks;
  if (hooks.afterRun === null) {
    return ok(undefined);
  }
  return ignoreHookFailure(runHook(hooks.afterRun, workspace, issueCtx, "after_run", workerHost));
}

function workspacePathForIssue(safeId: string, workerHost: WorkerHost): Result<string, unknown> {
  const root = settingsBang().workspace.root;
  if (workerHost === null) {
    return canonicalize(path.join(root, safeId));
  }
  return ok(path.join(root, safeId));
}

function safeIdentifier(identifier: string | null): string {
  return (identifier ?? "issue").replace(/[^a-zA-Z0-9._-]/g, "_");
}

function maybeRunAfterCreateHook(
  workspace: string,
  issueCtx: IssueContext,
  created: boolean,
  workerHost: WorkerHost,
): Result<undefined, unknown> {
  if (!created) {
    return ok(undefined);
  }
  const hooks = settingsBang().hooks;
  if (hooks.afterCreate === null) {
    return ok(undefined);
  }
  return runHook(hooks.afterCreate, workspace, issueCtx, "after_create", workerHost);
}

function maybeRunBeforeRemoveHook(workspace: string, workerHost: WorkerHost): void {
  const hooks = settingsBang().hooks;

  if (workerHost === null) {
    if (!isDir(workspace) || hooks.beforeRemove === null) {
      return;
    }
    ignoreHookFailure(
      runHook(
        hooks.beforeRemove,
        workspace,
        { issueId: null, issueIdentifier: path.basename(workspace) },
        "before_remove",
        null,
      ),
    );
    return;
  }

  if (hooks.beforeRemove === null) {
    return;
  }
  const command = hooks.beforeRemove;
  const script = [
    remoteShellAssign("workspace", workspace),
    'if [ -d "$workspace" ]; then',
    '  cd "$workspace"',
    `  ${command}`,
    "fi",
  ].join("\n");

  const result = runRemoteCommand(workerHost, script, settingsBang().hooks.timeoutMs);
  if (result.ok) {
    const [output, status] = result.value;
    ignoreHookFailure(
      handleHookCommandResult(
        [output, status],
        workspace,
        { issueId: null, issueIdentifier: path.basename(workspace) },
        "before_remove",
      ),
    );
  }
  // Remote errors (including timeout) are ignored, matching ignore_hook_failure.
}

function ignoreHookFailure(_result: Result<undefined, unknown>): Result<undefined, unknown> {
  return ok(undefined);
}

function runHook(
  command: string,
  workspace: string,
  issueCtx: IssueContext,
  hookName: string,
  workerHost: WorkerHost,
): Result<undefined, unknown> {
  const timeoutMs = settingsBang().hooks.timeoutMs;

  if (workerHost === null) {
    logger.info(
      `Running workspace hook hook=${hookName} ${issueLogContext(issueCtx)} workspace=${workspace} worker_host=local`,
    );
    const proc = Bun.spawnSync(["sh", "-lc", command], { cwd: workspace, timeout: timeoutMs });
    if (proc.exitedDueToTimeout) {
      logger.warning(
        `Workspace hook timed out hook=${hookName} ${issueLogContext(issueCtx)} workspace=${workspace} worker_host=local timeout_ms=${timeoutMs}`,
      );
      return err({ tag: "workspace_hook_timeout", hookName, timeoutMs });
    }
    const output = (proc.stdout?.toString() ?? "") + (proc.stderr?.toString() ?? "");
    return handleHookCommandResult([output, proc.exitCode], workspace, issueCtx, hookName);
  }

  logger.info(
    `Running workspace hook hook=${hookName} ${issueLogContext(issueCtx)} workspace=${workspace} worker_host=${workerHost}`,
  );
  const result = runRemoteCommand(
    workerHost,
    `cd ${shellEscape(workspace)} && ${command}`,
    timeoutMs,
  );
  if (!result.ok) {
    return err(result.error);
  }
  return handleHookCommandResult(result.value, workspace, issueCtx, hookName);
}

function handleHookCommandResult(
  [output, status]: [string, number],
  workspace: string,
  issueCtx: IssueContext,
  hookName: string,
): Result<undefined, unknown> {
  if (status === 0) {
    return ok(undefined);
  }
  const sanitized = sanitizeHookOutputForLog(output);
  logger.warning(
    `Workspace hook failed hook=${hookName} ${issueLogContext(issueCtx)} workspace=${workspace} status=${status} output=${JSON.stringify(sanitized)}`,
  );
  return err({ tag: "workspace_hook_failed", hookName, status, output });
}

function sanitizeHookOutputForLog(output: string, maxBytes = 2_048): string {
  if (Buffer.byteLength(output, "utf8") <= maxBytes) {
    return output;
  }
  return `${Buffer.from(output, "utf8").subarray(0, maxBytes).toString("utf8")}... (truncated)`;
}

function validateWorkspacePath(
  workspace: string,
  workerHost: WorkerHost,
): Result<undefined, unknown> {
  if (workerHost === null) {
    const expandedWorkspace = path.resolve(workspace);
    const expandedRoot = path.resolve(settingsBang().workspace.root);
    const expandedRootPrefix = `${expandedRoot}/`;

    const canonicalWorkspace = canonicalize(expandedWorkspace);
    const canonicalRoot = canonicalize(expandedRoot);
    if (!canonicalWorkspace.ok) {
      const e = canonicalWorkspace.error;
      return err({ tag: "workspace_path_unreadable", path: e.expandedPath, reason: e.reason });
    }
    if (!canonicalRoot.ok) {
      const e = canonicalRoot.error;
      return err({ tag: "workspace_path_unreadable", path: e.expandedPath, reason: e.reason });
    }
    const canonicalRootPrefix = `${canonicalRoot.value}/`;

    if (canonicalWorkspace.value === canonicalRoot.value) {
      return err({
        tag: "workspace_equals_root",
        workspace: canonicalWorkspace.value,
        root: canonicalRoot.value,
      });
    }
    if (`${canonicalWorkspace.value}/`.startsWith(canonicalRootPrefix)) {
      return ok(undefined);
    }
    if (`${expandedWorkspace}/`.startsWith(expandedRootPrefix)) {
      return err({
        tag: "workspace_symlink_escape",
        workspace: expandedWorkspace,
        root: canonicalRoot.value,
      });
    }
    return err({
      tag: "workspace_outside_root",
      workspace: canonicalWorkspace.value,
      root: canonicalRoot.value,
    });
  }

  if (workspace.trim() === "") {
    return err({ tag: "workspace_path_unreadable", path: workspace, reason: "empty" });
  }
  if (/[\n\r\0]/.test(workspace)) {
    return err({ tag: "workspace_path_unreadable", path: workspace, reason: "invalid_characters" });
  }
  return ok(undefined);
}

function remoteShellAssign(variableName: string, rawPath: string): string {
  return [
    `${variableName}=${shellEscape(rawPath)}`,
    `case "$${variableName}" in`,
    `  '~') ${variableName}="$HOME" ;;`,
    `  '~/'*) ${variableName}="$HOME/\${${variableName}#~/}" ;;`,
    "esac",
  ].join("\n");
}

function parseRemoteWorkspaceOutput(output: string): EnsureResult {
  const lines = output.split("\n").filter((line) => line !== "");
  for (const line of lines) {
    const parts = splitN(line, "\t", 3);
    const [marker, created, p] = parts;
    if (
      marker === REMOTE_WORKSPACE_MARKER &&
      (created === "0" || created === "1") &&
      p &&
      p !== ""
    ) {
      return ok({ workspace: p, created: created === "1" });
    }
  }
  return err({ tag: "workspace_prepare_failed", reason: "invalid_output", output });
}

function runRemoteCommand(
  workerHost: string,
  script: string,
  timeoutMs: number,
): Result<[string, number], unknown> {
  const result = SSH.run(workerHost, script, { stderrToStdout: true, timeout: timeoutMs });
  if (!result.ok) {
    if (isTagged(result.error, "ssh_timeout")) {
      return err({ tag: "workspace_hook_timeout", hookName: "remote_command", timeoutMs });
    }
    return err(result.error);
  }
  return ok(result.value);
}

function shellEscape(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function workerHostForLog(workerHost: WorkerHost): string {
  return workerHost === null ? "local" : workerHost;
}

function issueContext(value: Issue | string | null): IssueContext {
  if (value !== null && typeof value === "object" && "identifier" in value && "id" in value) {
    return { issueId: value.id ?? null, issueIdentifier: value.identifier || "issue" };
  }
  if (typeof value === "string") {
    return { issueId: null, issueIdentifier: value };
  }
  return { issueId: null, issueIdentifier: "issue" };
}

function issueLogContext(ctx: IssueContext): string {
  return `issue_id=${ctx.issueId ?? "n/a"} issue_identifier=${ctx.issueIdentifier || "issue"}`;
}

// ---- helpers ---------------------------------------------------------------

function isDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function isTagged(value: unknown, tag: string): boolean {
  return typeof value === "object" && value !== null && (value as { tag?: string }).tag === tag;
}

function splitN(value: string, separator: string, n: number): string[] {
  const parts = value.split(separator);
  if (parts.length <= n) {
    return parts;
  }
  return [...parts.slice(0, n - 1), parts.slice(n - 1).join(separator)];
}
