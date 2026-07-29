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
import { type Result, err, ok } from "./result.ts";
import * as SSH from "./ssh.ts";
import type { Issue } from "./work-item.ts";
import { type WorkspaceGuardViolation, guardWorkspacePath } from "./workspace-guard.ts";

const REMOTE_WORKSPACE_MARKER = "__SYMPHONY_WORKSPACE__";

export type WorkerHost = string | null;

type IssueContext = { issueId: string | null; issueIdentifier: string };

// Local removals return the list of removed paths; root-protection and other
// validation errors carry the distinct 3-element shape from Elixir.
export type RemoveResult =
  | { ok: true; value: string[] }
  | { ok: false; error: unknown; output: string };

export type CreateWorkspaceOptions = {
  rework?: boolean;
};

export function createForIssue(
  issueOrIdentifier: Issue | string | null,
  workerHost: WorkerHost = null,
  options: CreateWorkspaceOptions = {},
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
    if (options.rework === true && !ensured.value.created) {
      const reset = resetForRework(ensured.value.workspace, issueOrIdentifier, workerHost);
      if (!reset.ok) {
        return err(reset.error);
      }
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

// Rework is a deliberate lifecycle boundary from the official workflow: close
// the old PR, discard the previous checkout, and recreate the issue branch from
// origin/main before the next agent run. A failed cleanup stops the run so an
// old PR or dirty branch cannot be mistaken for a fresh rework attempt.
export function resetForRework(
  workspace: string,
  issueOrIdentifier: Issue | string | null,
  workerHost: WorkerHost = null,
): Result<undefined, unknown> {
  const issueCtx = issueContext(issueOrIdentifier);
  const validation = validateWorkspacePath(workspace, workerHost);
  if (!validation.ok) {
    return err(validation.error);
  }

  const beforeRemove = runBeforeRemoveHook(workspace, issueOrIdentifier, workerHost);
  if (!beforeRemove.ok) {
    return err({ tag: "rework_before_remove_failed", reason: beforeRemove.error });
  }

  const branchResult = runCommand(workspace, "git branch --show-current", workerHost);
  if (!branchResult.ok) {
    return err({ tag: "rework_branch_lookup_failed", reason: branchResult.error });
  }
  const [branchOutput, branchStatus] = branchResult.value;
  const branch = branchOutput.trim();
  if (branchStatus !== 0 || branch === "" || branch === "HEAD" || /^(main|master)$/.test(branch)) {
    return err({ tag: "rework_branch_invalid", branch, status: branchStatus });
  }

  for (const command of ["git reset --hard HEAD", "git clean -fdx", "git fetch --prune origin"]) {
    const result = runCommand(workspace, command, workerHost);
    if (!result.ok) {
      return err({ tag: "rework_reset_failed", command, reason: result.error });
    }
    const [, status] = result.value;
    if (status !== 0) {
      return err({ tag: "rework_reset_failed", command, status });
    }
  }

  const recreate = runCommand(
    workspace,
    `git switch -C ${shellEscape(branch)} origin/main`,
    workerHost,
  );
  if (!recreate.ok) {
    return err({ tag: "rework_branch_recreate_failed", reason: recreate.error });
  }
  const [, recreateStatus] = recreate.value;
  if (recreateStatus !== 0) {
    return err({ tag: "rework_branch_recreate_failed", status: recreateStatus });
  }

  const cleaned = runCommand(workspace, "git clean -fdx", workerHost);
  if (!cleaned.ok) {
    return err({ tag: "rework_cleanup_failed", reason: cleaned.error });
  }
  const [, cleanStatus] = cleaned.value;
  if (cleanStatus !== 0) {
    return err({ tag: "rework_cleanup_failed", status: cleanStatus });
  }

  logger.info(`Reset workspace for rework ${issueLogContext(issueCtx)} branch=${branch}`);
  return ok(undefined);
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

export function runBeforeRemoveHook(
  workspace: string,
  issueOrIdentifier: Issue | string | null,
  workerHost: WorkerHost = null,
): Result<undefined, unknown> {
  const issueCtx = issueContext(issueOrIdentifier);
  const hooks = settingsBang().hooks;
  if (hooks.beforeRemove === null) {
    return ok(undefined);
  }
  return runHook(hooks.beforeRemove, workspace, issueCtx, "before_remove", workerHost);
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

export function runCommand(
  workspace: string,
  command: string,
  workerHost: WorkerHost = null,
  timeoutMs = settingsBang().hooks.timeoutMs,
): Result<[string, number], unknown> {
  const validation = validateWorkspacePath(workspace, workerHost);
  if (!validation.ok) {
    return err(validation.error);
  }
  if (workerHost === null) {
    const proc = Bun.spawnSync(["sh", "-lc", command], { cwd: workspace, timeout: timeoutMs });
    if (proc.exitedDueToTimeout) {
      return err({ tag: "workspace_command_timeout", timeoutMs });
    }
    const output = (proc.stdout?.toString() ?? "") + (proc.stderr?.toString() ?? "");
    return ok([output, proc.exitCode]);
  }
  return runRemoteCommand(workerHost, `cd ${shellEscape(workspace)} && ${command}`, timeoutMs);
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
    ignoreHookFailure(runBeforeRemoveHook(workspace, path.basename(workspace), null));
    return;
  }

  if (hooks.beforeRemove === null) {
    return;
  }
  ignoreHookFailure(runBeforeRemoveHook(workspace, path.basename(workspace), workerHost));
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

// Delegates to the shared workspace guard (workspace-guard.ts) and maps each
// violation back to this module's frozen `workspace_*` error family (tests and
// logs consume the exact tags/shapes below).
function validateWorkspacePath(
  workspace: string,
  workerHost: WorkerHost,
): Result<undefined, unknown> {
  const guard = guardWorkspacePath(workspace, settingsBang().workspace.root, workerHost);
  if (guard.ok) {
    return ok(undefined);
  }
  return err(workspacePathError(guard.error));
}

function workspacePathError(v: WorkspaceGuardViolation): Record<string, unknown> {
  switch (v.kind) {
    case "path_unreadable":
      return { tag: "workspace_path_unreadable", path: v.path, reason: v.reason };
    case "equals_root":
      return {
        tag: "workspace_equals_root",
        workspace: v.canonicalWorkspace,
        root: v.canonicalRoot,
      };
    case "symlink_escape":
      return {
        tag: "workspace_symlink_escape",
        workspace: v.expandedWorkspace,
        root: v.canonicalRoot,
      };
    case "outside_root":
      return {
        tag: "workspace_outside_root",
        workspace: v.canonicalWorkspace,
        root: v.canonicalRoot,
      };
    case "empty_remote":
      return { tag: "workspace_path_unreadable", path: v.workspace, reason: "empty" };
    case "invalid_remote_characters":
      return { tag: "workspace_path_unreadable", path: v.workspace, reason: "invalid_characters" };
  }
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
