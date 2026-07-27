// Claude Code stream-json process client. Drives a long-lived
//   <command> -p --input-format stream-json --output-format stream-json --verbose
// subprocess (line-framed JSON, structurally identical to the codex transport,
// so it reuses the shared ProcessTransport). One process per session; each
// runTurn writes one user message and reads the stream to the `result` line.
//
// Empirically verified against claude CLI 2.1.218 (see plugin.ts header):
//   - system/init         -> session_started (carries the session_id)
//   - assistant/user/etc. -> notification (raw payload passthrough)
//   - result subtype=success -> turn_completed; subtype=error_* / is_error -> turn_failed
//   - result.usage is PER-TURN (input_tokens/output_tokens, snake_case, no
//     total_tokens), so this client ACCUMULATES it into the cumulative absolute
//     totals the contract's envelope requires (§3.2), deriving total itself.
//   - the CLI session_id is constant across turns, so the derived per-turn id
//     `${session_id}-${turnNumber}` (mirroring codex `${threadId}-${turnId}`)
//     keeps the orchestrator's turn counter advancing (orchestrator turnCountForUpdate).

import { settingsBang } from "../../../config.ts";
import { logger } from "../../../logger.ts";
import { type Result, err, ok } from "../../../result.ts";
import { type WorkspaceGuardViolation, guardWorkspacePath } from "../../../workspace-guard.ts";
import { ProcessTransport, type Transport } from "../transport.ts";
import type {
  AgentMessage,
  AgentSession,
  OnAgentMessage,
  StartSessionOpts,
  TurnContext,
  TurnResult,
} from "../types.ts";
import { type McpBridge, startToolBridge } from "./mcp-server.ts";
import { type ClaudeCodeSettings, claudeCodeSettings } from "./settings.ts";

const MAX_STREAM_LOG_BYTES = 1_000;

type ClaudeHandle = {
  transport: Transport;
  bridge: McpBridge | null;
  onMessage: OnAgentMessage;
  config: ClaudeCodeSettings;
  metadata: { backendPid?: string };
  // The raw CLI session_id (constant across turns), captured from system/init.
  rawSessionId: string | null;
  // Per-turn usage is accumulated here into cumulative absolute totals.
  cumulativeInput: number;
  cumulativeOutput: number;
};

export async function startSession(
  workspace: string,
  opts: StartSessionOpts = {},
): Promise<Result<AgentSession, unknown>> {
  const workerHost = opts.workerHost ?? null;
  const config = claudeCodeSettings(settingsBang());

  // Same shared guard the codex backend uses (SPEC §17); emit the
  // invalid_workspace_cwd family so the failure looks identical across backends.
  const guard = guardWorkspacePath(workspace, settingsBang().workspace.root, workerHost);
  if (!guard.ok) {
    return err(invalidWorkspaceCwd(guard.error, workerHost));
  }
  const cwd = guard.value;
  const onMessage = opts.onMessage ?? noop;

  // Start the tool bridge first so its URL can be handed to the CLI.
  const bridge =
    opts.toolProvider !== undefined ? startToolBridge(opts.toolProvider, onMessage) : null;

  const transportResult = startProcess(config, cwd, bridge);
  if (!transportResult.ok) {
    bridge?.close();
    return err(transportResult.error);
  }
  const transport = transportResult.value;
  const pid = transport.osPid();

  const handle: ClaudeHandle = {
    transport,
    bridge,
    onMessage,
    config,
    metadata: pid !== undefined ? { backendPid: pid } : {},
    rawSessionId: null,
    cumulativeInput: 0,
    cumulativeOutput: 0,
  };
  const session: AgentSession = { backendId: "claude_code", workspace: cwd, workerHost, handle };
  if (pid !== undefined) {
    session.backendPid = pid;
  }
  return ok(session);
}

export async function runTurn(
  session: AgentSession,
  prompt: string,
  context: TurnContext,
): Promise<Result<TurnResult, unknown>> {
  const handle = session.handle as ClaudeHandle;
  const { turnNumber } = context;
  let sessionStarted = false;

  handle.transport.send(userMessage(prompt));

  // Continuation turn: the CLI emits system/init only once per process, so for
  // turns after the first we synthesize session_started from the stored id
  // (contract §3.3 requires it every turn).
  if (handle.rawSessionId !== null) {
    emitSessionStarted(handle, turnNumber, null);
    sessionStarted = true;
  }

  for (;;) {
    // read_timeout_ms bounds the init wait (turn 1); turn_timeout_ms bounds the
    // content stream. Both surface as turn_timeout on expiry.
    const timeoutMs =
      handle.rawSessionId === null ? handle.config.readTimeoutMs : handle.config.turnTimeoutMs;
    const event = await handle.transport.next(timeoutMs);
    if (event.type === "timeout") {
      return endWithError(handle, turnNumber, { tag: "turn_timeout" });
    }
    if (event.type === "exit") {
      return endWithError(handle, turnNumber, { tag: "port_exit", status: event.status });
    }

    const line = event.data;
    if (line.trim() === "") {
      continue;
    }
    const decoded = tryParse(line);
    if (!decoded.ok) {
      logNonJsonLine(line);
      if (protocolMessageCandidate(line)) {
        emit(handle, "malformed", { payload: line, raw: line });
      }
      continue;
    }
    const msg = decoded.value;
    if (!isObject(msg)) {
      emit(handle, "notification", { payload: msg, raw: line });
      continue;
    }

    if (msg.type === "system" && msg.subtype === "init") {
      if (typeof msg.session_id === "string") {
        handle.rawSessionId = msg.session_id;
      }
      emitSessionStarted(handle, turnNumber, { payload: msg, raw: line });
      sessionStarted = true;
      continue;
    }

    if (msg.type === "result") {
      if (!sessionStarted) {
        // No init this turn (broken stream): derive from result.session_id.
        if (handle.rawSessionId === null && typeof msg.session_id === "string") {
          handle.rawSessionId = msg.session_id;
        }
        emitSessionStarted(handle, turnNumber, null);
        sessionStarted = true;
      }
      return finishTurn(handle, msg, line, turnNumber);
    }

    // assistant / user / rate_limit_event / other system events: raw passthrough
    // (MUST NOT drop — the dashboard renders it).
    emit(handle, "notification", { payload: msg, raw: line });
  }
}

export function stopSession(session: AgentSession): void {
  const handle = session.handle as ClaudeHandle;
  handle.bridge?.close();
  handle.transport.close();
}

// Transport-level failures (turn_timeout, port_exit) have no CLI message to map,
// so — mirroring codex's runTurn error path — emit a terminal
// `turn_ended_with_error` before returning, so the orchestrator/dashboard record
// the failure as the run's final event instead of a stale in-progress
// notification.
function endWithError(
  handle: ClaudeHandle,
  turnNumber: number,
  error: Record<string, unknown>,
): Result<TurnResult, unknown> {
  emit(handle, "turn_ended_with_error", {
    sessionId: derivedSessionId(handle.rawSessionId, turnNumber),
    reason: error,
  });
  return err(error);
}

function finishTurn(
  handle: ClaudeHandle,
  msg: Record<string, unknown>,
  line: string,
  turnNumber: number,
): Result<TurnResult, unknown> {
  const sessionId = derivedSessionId(handle.rawSessionId, turnNumber);
  const subtype = typeof msg.subtype === "string" ? msg.subtype : "";
  const succeeded = subtype === "success" && msg.is_error !== true;

  // Billable usage arrives on every result message — error and
  // permission-denied results included — so accumulate before branching and
  // attach the cumulative map to whichever terminal event fires: the
  // orchestrator only reads the flat envelope `usage` for this backend (its
  // codex payload sniffing does not recognize a claude result's shape).
  const usage = accumulateUsage(handle, msg.usage);

  if (!succeeded) {
    emit(handle, "turn_failed", { sessionId, usage, payload: msg, raw: line });
    return err({ tag: "turn_failed", payload: msg });
  }

  // Approval (permission_mode: default): a non-empty permission_denials means a
  // tool was denied (headless can't prompt). Lock the semantics — emit
  // approval_required and fail the turn — independent of CLI mechanism. This
  // CLI version (2.1.218) has no --permission-prompt-tool, so result-detection
  // is the chosen path (see plugin.ts header).
  if (handle.config.permissionMode !== "bypass" && hasPermissionDenials(msg)) {
    emit(handle, "approval_required", { sessionId, usage, payload: msg, raw: line });
    return err({ tag: "approval_required", payload: msg });
  }

  emit(handle, "turn_completed", { sessionId, usage, payload: msg, raw: line });
  return ok({ sessionId });
}

function accumulateUsage(handle: ClaudeHandle, rawUsage: unknown): AgentMessage["usage"] {
  if (isObject(rawUsage)) {
    handle.cumulativeInput += intOr0(rawUsage.input_tokens);
    handle.cumulativeOutput += intOr0(rawUsage.output_tokens);
  }
  return {
    input_tokens: handle.cumulativeInput,
    output_tokens: handle.cumulativeOutput,
    total_tokens: handle.cumulativeInput + handle.cumulativeOutput,
  };
}

function hasPermissionDenials(msg: Record<string, unknown>): boolean {
  return Array.isArray(msg.permission_denials) && msg.permission_denials.length > 0;
}

function emitSessionStarted(
  handle: ClaudeHandle,
  turnNumber: number,
  extra: { payload: unknown; raw: string } | null,
): void {
  const details: Record<string, unknown> = {
    sessionId: derivedSessionId(handle.rawSessionId, turnNumber),
    claudeSessionId: handle.rawSessionId,
  };
  if (extra !== null) {
    details.payload = extra.payload;
    details.raw = extra.raw;
  }
  emit(handle, "session_started", details);
}

function emit(
  handle: ClaudeHandle,
  event: AgentMessage["event"],
  details: Record<string, unknown>,
): void {
  handle.onMessage({ ...handle.metadata, ...details, event, timestamp: new Date() });
}

// Per-turn unique id mirroring codex `${threadId}-${turnId}`.
function derivedSessionId(rawSessionId: string | null, turnNumber: number): string {
  return `${rawSessionId ?? "claude"}-${turnNumber}`;
}

function userMessage(prompt: string): Record<string, unknown> {
  return { type: "user", message: { role: "user", content: [{ type: "text", text: prompt }] } };
}

// ---- process launch --------------------------------------------------------

function startProcess(
  config: ClaudeCodeSettings,
  cwd: string,
  bridge: McpBridge | null,
): Result<Transport, unknown> {
  const executable = Bun.which("bash", { PATH: process.env.PATH ?? "" });
  if (executable === null) {
    return err({ tag: "bash_not_found" });
  }
  const proc = Bun.spawn([executable, "-lc", buildCommand(config, bridge)], {
    cwd,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  }) as Bun.Subprocess<"pipe", "pipe", "pipe">;
  return ok(new ProcessTransport(proc));
}

// Assembles the shell command. config.command is inserted verbatim (mirrors
// codex, which allows "codex app-server"); the flags below are the only
// CLI-version-sensitive surface (see plugin.ts header for the empirical basis).
function buildCommand(config: ClaudeCodeSettings, bridge: McpBridge | null): string {
  const parts: string[] = [
    config.command,
    "-p",
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--verbose",
  ];
  if (config.model !== null) {
    parts.push("--model", shellEscape(config.model));
  }
  if (config.allowedTools !== null && config.allowedTools.length > 0) {
    parts.push("--allowedTools", ...config.allowedTools.map(shellEscape));
  }
  if (config.disallowedTools !== null && config.disallowedTools.length > 0) {
    parts.push("--disallowedTools", ...config.disallowedTools.map(shellEscape));
  }
  // "bypass" -> CLI bypassPermissions (~ codex approval_policy: never). "default"
  // omits the flag (CLI default prompting; headless denials -> approval_required).
  if (config.permissionMode === "bypass") {
    parts.push("--permission-mode", "bypassPermissions");
  }
  if (bridge !== null) {
    parts.push("--mcp-config", shellEscape(mcpConfigJson(bridge.url)), "--strict-mcp-config");
  }
  return parts.join(" ");
}

function mcpConfigJson(url: string): string {
  return JSON.stringify({ mcpServers: { symphony: { type: "http", url } } });
}

// ---- workspace error mapping -----------------------------------------------

// Maps a shared workspace guard violation to codex's frozen invalid_workspace_cwd
// family, so a bad workspace fails identically to the codex backend.
function invalidWorkspaceCwd(
  v: WorkspaceGuardViolation,
  workerHost: string | null,
): Record<string, unknown> {
  switch (v.kind) {
    case "path_unreadable":
      return {
        tag: "invalid_workspace_cwd",
        reason: "path_unreadable",
        path: v.path,
        detail: v.reason,
      };
    case "equals_root":
      return { tag: "invalid_workspace_cwd", reason: "workspace_root", path: v.canonicalWorkspace };
    case "symlink_escape":
      return {
        tag: "invalid_workspace_cwd",
        reason: "symlink_escape",
        path: v.expandedWorkspace,
        root: v.canonicalRoot,
      };
    case "outside_root":
      return {
        tag: "invalid_workspace_cwd",
        reason: "outside_workspace_root",
        path: v.canonicalWorkspace,
        root: v.canonicalRoot,
      };
    case "empty_remote":
      return { tag: "invalid_workspace_cwd", reason: "empty_remote_workspace", workerHost };
    case "invalid_remote_characters":
      return {
        tag: "invalid_workspace_cwd",
        reason: "invalid_remote_workspace",
        workerHost,
        workspace: v.workspace,
      };
  }
}

// ---- helpers ---------------------------------------------------------------

function tryParse(line: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(line) };
  } catch {
    return { ok: false };
  }
}

function protocolMessageCandidate(data: string): boolean {
  return data.replace(/^\s+/, "").startsWith("{");
}

function logNonJsonLine(data: string): void {
  const text = data.trim().slice(0, MAX_STREAM_LOG_BYTES);
  if (text === "") {
    return;
  }
  if (/\b(error|warn|warning|failed|fatal|panic|exception)\b/i.test(text)) {
    logger.warning(`claude_code stream output: ${text}`);
  } else {
    logger.debug(`claude_code stream output: ${text}`);
  }
}

function shellEscape(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function intOr0(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function noop(): void {}
