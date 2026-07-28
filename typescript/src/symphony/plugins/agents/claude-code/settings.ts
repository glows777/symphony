// Typed narrowing over the claude_code backend's private config section
// (`settings.agent.backendConfig`, the top-level `claude_code:` block). The
// plugin's configSchema cast/finalize guarantees the shape, so consumers get
// full types without core Settings depending on claude-code-specific fields
// (mirrors plugins/trackers/lark-task/settings.ts, but keyed off agent.backendConfig).

import type { Settings } from "../../../config/schema.ts";

export const DEFAULT_CLAUDE_COMMAND = "claude";
// Symphony is a non-interactive orchestrator: the codex-style default reject
// policy would block every issue immediately, so claude_code defaults to full
// auto-approval ("bypass" ~= codex approval_policy: never). "default" routes any
// permission denial through the approval_required blocking path (see client.ts).
export const DEFAULT_PERMISSION_MODE = "bypass";
export const DEFAULT_TURN_TIMEOUT_MS = 3_600_000;
// Mirrors the codex read_timeout_ms default; used as the startup/init wait.
export const DEFAULT_READ_TIMEOUT_MS = 5_000;

export type ClaudeCodeSettings = {
  command: string;
  // "bypass" | "default"; validated by configSchema.validate, kept as string here.
  permissionMode: string;
  model: string | null;
  allowedTools: string[] | null;
  disallowedTools: string[] | null;
  turnTimeoutMs: number;
  readTimeoutMs: number;
};

export function claudeCodeSettings(settings: Settings): ClaudeCodeSettings {
  const raw = settings.agent.backendConfig;
  return {
    command: stringOr(raw.command, DEFAULT_CLAUDE_COMMAND),
    permissionMode: stringOr(raw.permission_mode, DEFAULT_PERMISSION_MODE),
    model: stringOrNull(raw.model),
    allowedTools: stringArrayOrNull(raw.allowed_tools),
    disallowedTools: stringArrayOrNull(raw.disallowed_tools),
    turnTimeoutMs: intOr(raw.turn_timeout_ms, DEFAULT_TURN_TIMEOUT_MS),
    readTimeoutMs: intOr(raw.read_timeout_ms, DEFAULT_READ_TIMEOUT_MS),
  };
}

function stringOr(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function stringArrayOrNull(value: unknown): string[] | null {
  if (Array.isArray(value) && value.every((item) => typeof item === "string")) {
    return value as string[];
  }
  return null;
}

function intOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) ? value : fallback;
}
