// Claude Code CLI agent backend plugin. Drives a long-lived
//   claude -p --input-format stream-json --output-format stream-json --verbose
// subprocess (NOT the Agent SDK) behind the AgentBackendPlugin contract; the
// stream-json client lives in client.ts, the tool bridge in mcp-server.ts.
//
// Module evaluation only builds an object literal (no process spawn, no
// Bun.serve), keeping the config <-> plugins <-> client ESM cycle side-effect
// free (same discipline as the codex plugin).
//
// ---- Empirical CLI facts (verified live against claude CLI 2.1.218) ----------
// The CLI is the version-sensitive surface; the following was confirmed by a
// manual stream-json round-trip and is frozen into the fake-claude test script:
//   * Flags: -p, --input-format/--output-format stream-json, --verbose (needed
//     for the streaming events), --model, --allowedTools/--disallowedTools,
//     --permission-mode, --mcp-config (accepts an INLINE JSON string),
//     --strict-mcp-config. There is NO --permission-prompt-tool in this version.
//   * Messages: { type:"system", subtype:"init", session_id } starts the
//     session; { type:"result", subtype:"success"|"error_*", usage,
//     permission_denials, ... } ends a turn; assistant/user/other lines stream
//     in between.
//   * usage is PER-TURN (input_tokens/output_tokens snake_case, no total_tokens),
//     NOT session-cumulative — this corrects the P1–P4 §9 guess. The contract
//     (§3.2) needs cumulative absolute totals, so client.ts accumulates per-turn
//     usage itself and derives total_tokens = input + output.
//   * session_id is constant across turns, so client.ts derives a per-turn id
//     `${session_id}-${turnNumber}` (the orchestrator only counts a turn when
//     the sessionId changes).
//
// ---- Approval semantics (lock the semantics, not the mechanism) --------------
// permission_mode "bypass"  -> CLI --permission-mode bypassPermissions (~ codex
//   approval_policy: never): tools auto-approved, no approval events.
// permission_mode "default" -> omit --permission-mode (CLI default prompting;
//   headless can't prompt, so a needed permission is denied and recorded in
//   result.permission_denials). Since this CLI version has no
//   --permission-prompt-tool, the plugin detects a non-empty permission_denials
//   in the result and emits approval_required + fails the turn (client.ts).
//
// ---- v1 capabilities ---------------------------------------------------------
// multiTurnSessions: same process continues the conversation. remoteWorkers is
// omitted (local-only: the tool bridge is MCP-over-HTTP back to this process;
// remote SSH reachability is a separate concern — the runner's fail-fast
// remote_workers_unsupported guard covers it). rateLimitTelemetry and replay are
// omitted (no CLI rate-limit analog; the differential oracle stays codex-only).

import type { JsonMap } from "../../../config/schema.ts";
import { type Result, err, ok } from "../../../result.ts";
import { castPluginString, resolveEnvValue } from "../../shared/config-helpers.ts";
import type { PluginConfigError, PluginFieldError } from "../../shared/types.ts";
import type { AgentBackendPlugin } from "../types.ts";
import { runTurn, startSession, stopSession } from "./client.ts";
import { humanizeClaudeMessage } from "./humanize.ts";
import {
  DEFAULT_CLAUDE_COMMAND,
  DEFAULT_PERMISSION_MODE,
  DEFAULT_READ_TIMEOUT_MS,
  DEFAULT_TURN_TIMEOUT_MS,
  claudeCodeSettings,
} from "./settings.ts";

export const ClaudeCodePlugin: AgentBackendPlugin = {
  id: "claude_code",
  displayName: "Claude Code CLI",

  configSchema: {
    cast(raw: JsonMap, section: string): { value: JsonMap; errors: PluginFieldError[] } {
      const errors: PluginFieldError[] = [];
      const value: JsonMap = {
        command:
          castPluginString(raw, "command", section, DEFAULT_CLAUDE_COMMAND, errors) ??
          DEFAULT_CLAUDE_COMMAND,
        permission_mode:
          castPluginString(raw, "permission_mode", section, DEFAULT_PERMISSION_MODE, errors) ??
          DEFAULT_PERMISSION_MODE,
        model: castPluginString(raw, "model", section, null, errors),
        allowed_tools: castStringArray(raw, "allowed_tools", section, errors),
        disallowed_tools: castStringArray(raw, "disallowed_tools", section, errors),
        turn_timeout_ms: castInteger(
          raw,
          "turn_timeout_ms",
          section,
          DEFAULT_TURN_TIMEOUT_MS,
          errors,
          0,
        ),
        read_timeout_ms: castInteger(
          raw,
          "read_timeout_ms",
          section,
          DEFAULT_READ_TIMEOUT_MS,
          errors,
          0,
        ),
      };
      return { value, errors };
    },

    // Resolves `$VAR` references in the passthrough string fields (config-helpers
    // convention); the empty/undefined env cases fall back sensibly.
    finalize(value: JsonMap): JsonMap {
      return {
        ...value,
        command: resolveCommand(value.command),
        model: resolveModel(value.model),
      };
    },

    validate(settings): Result<undefined, PluginConfigError> {
      const cc = claudeCodeSettings(settings);
      if (cc.permissionMode !== "bypass" && cc.permissionMode !== "default") {
        return err({
          tag: "invalid_claude_code_permission_mode",
          message: `claude_code.permission_mode must be "bypass" or "default" (got ${JSON.stringify(cc.permissionMode)})`,
        });
      }
      return ok(undefined);
    },
  },

  sessions: {
    startSession,
    runTurn,
    stopSession,
  },

  capabilities: {
    multiTurnSessions: true,
  },

  ui: {
    humanizeMessage: (message) => humanizeClaudeMessage(message),
  },
};

// ---- cast/finalize helpers -------------------------------------------------

function castInteger(
  raw: JsonMap,
  key: string,
  section: string,
  fallback: number,
  errors: PluginFieldError[],
  minExclusive: number | null = null,
): number {
  if (!(key in raw)) {
    return fallback;
  }
  const value = raw[key];
  if (typeof value !== "number" || !Number.isInteger(value)) {
    errors.push({ path: `${section}.${key}`, message: "is invalid" });
    return fallback;
  }
  // Mirrors codex's validateGreaterThan for the timeout fields: a zero/negative
  // budget makes setTimeout fire immediately, failing every turn.
  if (minExclusive !== null && value <= minExclusive) {
    errors.push({ path: `${section}.${key}`, message: `must be greater than ${minExclusive}` });
    return fallback;
  }
  return value;
}

function castStringArray(
  raw: JsonMap,
  key: string,
  section: string,
  errors: PluginFieldError[],
): string[] | null {
  if (!(key in raw)) {
    return null;
  }
  const value = raw[key];
  if (Array.isArray(value) && value.every((item) => typeof item === "string")) {
    return value as string[];
  }
  errors.push({ path: `${section}.${key}`, message: "is invalid" });
  return null;
}

function resolveCommand(value: unknown): string {
  if (typeof value !== "string") {
    return DEFAULT_CLAUDE_COMMAND;
  }
  return resolveEnvValue(value, DEFAULT_CLAUDE_COMMAND) ?? DEFAULT_CLAUDE_COMMAND;
}

function resolveModel(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  return resolveEnvValue(value, null);
}
