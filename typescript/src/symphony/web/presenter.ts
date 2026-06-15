// Literal port of `symphony_elixir_web/presenter.ex`.
//
// Shared projections for the observability API and dashboard. The Elixir module
// takes a GenServer name and calls `Orchestrator.snapshot/2` + `request_refresh/1`;
// the TS port takes a `SnapshotProvider` (the live `Orchestrator` satisfies it,
// and tests inject static/slow/unavailable doubles). Atom-keyed Elixir maps
// become string-keyed objects, JSON-encoded unchanged at the controller.

import path from "node:path";
import { settingsBang } from "../config.ts";
import type { RequestRefreshReply, Snapshot, SnapshotRunning } from "../orchestrator.ts";
import { humanizeCodexMessageExport } from "../status-dashboard.ts";

export type SnapshotResult = Snapshot | "timeout" | "unavailable";

export type SnapshotProvider = {
  snapshot(timeoutMs: number): Promise<SnapshotResult>;
  requestRefresh(): Promise<RequestRefreshReply | "unavailable">;
};

type LooseEntry = Record<string, unknown>;
type Json = Record<string, unknown>;

export type IssuePayloadResult =
  | { ok: true; value: Json }
  | { ok: false; error: "issue_not_found" };

export type RefreshPayloadResult = { ok: true; value: Json } | { ok: false; error: "unavailable" };

export async function statePayload(provider: SnapshotProvider, timeoutMs: number): Promise<Json> {
  const generatedAt = nowIso();
  const snapshot = await provider.snapshot(timeoutMs);
  if (snapshot === "timeout") {
    return {
      generated_at: generatedAt,
      error: errorBody("snapshot_timeout", "Snapshot timed out"),
    };
  }
  if (snapshot === "unavailable") {
    return {
      generated_at: generatedAt,
      error: errorBody("snapshot_unavailable", "Snapshot unavailable"),
    };
  }
  const blocked = snapshot.blocked ?? [];
  return {
    generated_at: generatedAt,
    counts: {
      running: snapshot.running.length,
      retrying: snapshot.retrying.length,
      blocked: blocked.length,
    },
    running: snapshot.running.map(runningEntryPayload),
    retrying: snapshot.retrying.map(retryEntryPayload),
    blocked: blocked.map(blockedEntryPayload),
    codex_totals: snapshot.codex_totals,
    rate_limits: snapshot.rate_limits,
  };
}

export async function issuePayload(
  issueIdentifier: string,
  provider: SnapshotProvider,
  timeoutMs: number,
): Promise<IssuePayloadResult> {
  const snapshot = await provider.snapshot(timeoutMs);
  if (typeof snapshot === "string") {
    return { ok: false, error: "issue_not_found" };
  }
  const running = snapshot.running.find((e) => e.identifier === issueIdentifier) ?? null;
  const retry = snapshot.retrying.find((e) => e.identifier === issueIdentifier) ?? null;
  const blocked = (snapshot.blocked ?? []).find((e) => e.identifier === issueIdentifier) ?? null;

  if (running === null && retry === null && blocked === null) {
    return { ok: false, error: "issue_not_found" };
  }
  return { ok: true, value: issuePayloadBody(issueIdentifier, running, retry, blocked) };
}

export async function refreshPayload(provider: SnapshotProvider): Promise<RefreshPayloadResult> {
  const payload = await provider.requestRefresh();
  if (payload === "unavailable") {
    return { ok: false, error: "unavailable" };
  }
  return {
    ok: true,
    value: { ...payload, requested_at: iso8601(payload.requested_at) },
  };
}

// ---- issue payload body ----------------------------------------------------

function issuePayloadBody(
  issueIdentifier: string,
  running: SnapshotRunning | null,
  retry: LooseEntry | null,
  blocked: LooseEntry | null,
): Json {
  return {
    issue_identifier: issueIdentifier,
    issue_id: issueIdFromEntries(running, retry, blocked),
    status: issueStatus(running, retry, blocked),
    workspace: {
      path: workspacePath(issueIdentifier, running, retry, blocked),
      host: workspaceHost(running, retry, blocked),
    },
    attempts: {
      restart_count: restartCount(retry),
      current_retry_attempt: retryAttempt(retry),
    },
    running: running && runningIssuePayload(running),
    retry: retry && retryIssuePayload(retry),
    blocked: blocked && blockedIssuePayload(blocked),
    logs: { codex_session_logs: [] },
    recent_events: recentEventsPayload(running ?? blocked),
    last_error: (blocked && str(blocked, "error")) ?? (retry && str(retry, "error")) ?? null,
    tracked: {},
  };
}

function issueIdFromEntries(
  running: SnapshotRunning | null,
  retry: LooseEntry | null,
  blocked: LooseEntry | null,
): unknown {
  return running?.issue_id ?? retry?.issue_id ?? blocked?.issue_id ?? null;
}

function restartCount(retry: LooseEntry | null): number {
  return Math.max(retryAttempt(retry) - 1, 0);
}

function retryAttempt(retry: LooseEntry | null): number {
  if (retry === null) {
    return 0;
  }
  return typeof retry.attempt === "number" ? retry.attempt : 0;
}

function issueStatus(
  running: SnapshotRunning | null,
  retry: LooseEntry | null,
  _blocked: LooseEntry | null,
): string {
  if (running !== null) {
    return "running";
  }
  if (retry !== null) {
    return "retrying";
  }
  return "blocked";
}

// ---- collection payloads ---------------------------------------------------

function runningEntryPayload(entry: SnapshotRunning): Json {
  return {
    issue_id: entry.issue_id,
    issue_identifier: entry.identifier,
    issue_url: entry.issue_url ?? null,
    state: entry.state,
    worker_host: entry.worker_host ?? null,
    workspace_path: entry.workspace_path ?? null,
    session_id: entry.session_id,
    turn_count: entry.turn_count ?? 0,
    last_event: entry.last_codex_event,
    last_message: summarizeMessage(entry.last_codex_message),
    started_at: iso8601(entry.started_at),
    last_event_at: iso8601(entry.last_codex_timestamp),
    tokens: {
      input_tokens: entry.codex_input_tokens,
      output_tokens: entry.codex_output_tokens,
      total_tokens: entry.codex_total_tokens,
    },
  };
}

function retryEntryPayload(entry: LooseEntry): Json {
  return {
    issue_id: entry.issue_id,
    issue_identifier: entry.identifier,
    issue_url: entry.issue_url ?? null,
    attempt: entry.attempt,
    due_at: dueAtIso8601(entry.due_in_ms),
    error: entry.error,
    worker_host: entry.worker_host ?? null,
    workspace_path: entry.workspace_path ?? null,
  };
}

function blockedEntryPayload(entry: LooseEntry): Json {
  return {
    issue_id: entry.issue_id,
    issue_identifier: entry.identifier,
    issue_url: entry.issue_url ?? null,
    state: entry.state,
    error: entry.error,
    worker_host: entry.worker_host ?? null,
    workspace_path: entry.workspace_path ?? null,
    session_id: entry.session_id,
    blocked_at: iso8601(entry.blocked_at),
    last_event: entry.last_codex_event,
    last_message: summarizeMessage(entry.last_codex_message),
    last_event_at: iso8601(entry.last_codex_timestamp),
  };
}

function runningIssuePayload(running: SnapshotRunning): Json {
  return {
    worker_host: running.worker_host ?? null,
    workspace_path: running.workspace_path ?? null,
    session_id: running.session_id,
    turn_count: running.turn_count ?? 0,
    state: running.state,
    started_at: iso8601(running.started_at),
    last_event: running.last_codex_event,
    last_message: summarizeMessage(running.last_codex_message),
    last_event_at: iso8601(running.last_codex_timestamp),
    tokens: {
      input_tokens: running.codex_input_tokens,
      output_tokens: running.codex_output_tokens,
      total_tokens: running.codex_total_tokens,
    },
  };
}

function retryIssuePayload(retry: LooseEntry): Json {
  return {
    attempt: retry.attempt,
    due_at: dueAtIso8601(retry.due_in_ms),
    error: retry.error,
    worker_host: retry.worker_host ?? null,
    workspace_path: retry.workspace_path ?? null,
  };
}

function blockedIssuePayload(blocked: LooseEntry): Json {
  return {
    worker_host: blocked.worker_host ?? null,
    workspace_path: blocked.workspace_path ?? null,
    session_id: blocked.session_id,
    state: blocked.state,
    error: blocked.error,
    blocked_at: iso8601(blocked.blocked_at),
    last_event: blocked.last_codex_event,
    last_message: summarizeMessage(blocked.last_codex_message),
    last_event_at: iso8601(blocked.last_codex_timestamp),
  };
}

function workspacePath(
  issueIdentifier: string,
  running: SnapshotRunning | null,
  retry: LooseEntry | null,
  blocked: LooseEntry | null,
): string {
  return (
    (running && (running.workspace_path ?? null)) ??
    (retry && str(retry, "workspace_path")) ??
    (blocked && str(blocked, "workspace_path")) ??
    path.join(settingsBang().workspace.root, issueIdentifier)
  );
}

function workspaceHost(
  running: SnapshotRunning | null,
  retry: LooseEntry | null,
  blocked: LooseEntry | null,
): string | null {
  return (
    (running && (running.worker_host ?? null)) ??
    (retry && str(retry, "worker_host")) ??
    (blocked && str(blocked, "worker_host")) ??
    null
  );
}

function recentEventsPayload(entry: SnapshotRunning | LooseEntry | null): Json[] {
  if (entry === null) {
    return [];
  }
  const at = iso8601((entry as LooseEntry).last_codex_timestamp);
  if (at === null) {
    return [];
  }
  return [
    {
      at,
      event: (entry as LooseEntry).last_codex_event,
      message: summarizeMessage((entry as LooseEntry).last_codex_message),
    },
  ];
}

// ---- helpers ---------------------------------------------------------------

function summarizeMessage(message: unknown): string | null {
  if (message === null || message === undefined) {
    return null;
  }
  return humanizeCodexMessageExport(message);
}

function errorBody(code: string, message: string): Json {
  return { code, message };
}

function str(entry: LooseEntry, key: string): string | null {
  const value = entry[key];
  return typeof value === "string" ? value : null;
}

function dueAtIso8601(dueInMs: unknown): string | null {
  if (typeof dueInMs === "number" && Number.isInteger(dueInMs)) {
    return iso8601(new Date(Date.now() + Math.floor(dueInMs / 1000) * 1000));
  }
  return null;
}

function nowIso(): string {
  return iso8601(new Date()) ?? "";
}

function iso8601(value: unknown): string | null {
  if (value instanceof Date) {
    return value.toISOString().replace(/\.\d{3}Z$/, "Z");
  }
  return null;
}
