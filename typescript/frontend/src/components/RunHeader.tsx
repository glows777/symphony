import { ChevronDown, Circle } from "lucide-react";
import type { IssueDetail, RunItem, RunKind, RunMetadata } from "../lib/api";

type RunHeaderProps = {
  identifier: string | null;
  detail: IssueDetail | null;
  run: RunItem | RunMetadata | null;
  onRerunBlocked: (identifier: string) => void;
  rerunning: boolean;
};

export function RunHeader({ identifier, detail, run, onRerunBlocked, rerunning }: RunHeaderProps) {
  const metadataRun = run !== null && "event_count" in run;
  const snapshotRun = metadataRun
    ? null
    : (detail?.running ?? detail?.retry ?? detail?.blocked ?? null);
  const backend = run?.backend ?? detail?.logs?.latest_run?.backend ?? "agent";
  const runKind = normalizeRunKind(
    run?.run_kind ?? snapshotRun?.run_kind ?? detail?.logs?.latest_run?.run_kind,
  );
  const status = run?.status ?? detail?.status ?? "waiting";
  const workspace =
    detail?.workspace?.path ??
    snapshotRun?.workspace_path ??
    (run !== null && "workspace_path" in run ? run.workspace_path : null) ??
    "Not assigned";
  const session =
    run?.session_id ??
    snapshotRun?.session_id ??
    detail?.logs?.latest_run?.session_id ??
    "Not started";
  const runId = run?.run_id ?? detail?.logs?.latest_run?.run_id ?? "Not started";
  const turn = metadataRun ? "n/a" : (snapshotRun?.turn_count ?? "n/a");
  const tokens = metadataRun ? null : (snapshotRun?.tokens?.total_tokens ?? null);
  const startedAt = snapshotRun?.started_at ?? run?.started_at ?? null;
  const endedAt = run?.ended_at ?? null;
  const blocked = detail?.blocked ?? null;
  const recovery = blocked?.manual_recovery ?? null;
  const canRerun =
    identifier !== null && detail?.status === "blocked" && recovery?.rerun_supported !== false;
  const blockedReason = blocked?.blocked_reason ?? blocked?.error ?? detail?.last_error ?? null;
  const operatorPrompt = blocked?.operator_prompt ?? recovery?.prompt ?? null;
  const hasVisibleRecovery = canRerun || (detail?.status === "blocked" && blockedReason !== null);

  if (!hasVisibleRecovery) {
    return null;
  }

  return (
    <header className="run-header">
      <div className="run-context" aria-label="Selected run status">
        <span className={`run-context-status run-context-status-${statusTone(status)}`}>
          <Circle
            className="run-context-dot"
            size={6}
            strokeWidth={0}
            fill="currentColor"
            aria-hidden="true"
          />
          {statusLabel(status)}
        </span>
        <span className="run-context-id">{identifier ?? "Choose a run from the sidebar"}</span>
        <span className="run-context-backend">{backendLabel(backend)}</span>
        <span className="run-context-kind">{runKindLabel(runKind)}</span>
        {canRerun ? (
          <button
            type="button"
            className="rerun-button"
            disabled={rerunning}
            onClick={() => {
              if (
                identifier !== null &&
                window.confirm(
                  `Rerun blocked agent for ${identifier}? This may execute tools or modify external tracker and repository state.`,
                )
              ) {
                onRerunBlocked(identifier);
              }
            }}
          >
            {rerunning ? "Rerunning" : "Rerun"}
          </button>
        ) : null}
      </div>
      {detail?.status === "blocked" && blockedReason !== null ? (
        <div className="blocked-callout">
          <span className="blocked-callout-label">Blocked</span>
          <span className="blocked-callout-reason">{blockedReason}</span>
          {operatorPrompt ? <span className="blocked-callout-prompt">{operatorPrompt}</span> : null}
        </div>
      ) : null}
      <details className="run-details">
        <summary>
          <span>Run details</span>
          <ChevronDown
            className="run-details-chevron"
            size={14}
            strokeWidth={1.7}
            aria-hidden="true"
          />
        </summary>
        <div className="run-facts" aria-label="Run summary">
          <Fact label="Workspace" value={workspace} mono />
          <Fact label="Run" value={compactId(runId)} mono />
          <Fact label="Session" value={compactId(session)} mono />
          <Fact label="Turn" value={String(turn)} numeric />
          <Fact label="Runtime" value={formatRuntime(startedAt, endedAt)} numeric />
          <Fact
            label="Tokens"
            value={tokens === null || tokens === undefined ? "n/a" : formatInt(tokens)}
            numeric
          />
          <Fact label="Worker" value={snapshotRun?.worker_host ?? run?.worker_host ?? "local"} />
        </div>
      </details>
    </header>
  );
}

function Fact({
  label,
  value,
  mono = false,
  numeric = false,
}: {
  label: string;
  value: string;
  mono?: boolean;
  numeric?: boolean;
}) {
  return (
    <div className="run-fact">
      <span className="run-fact-label">{label}</span>
      <span
        className={`run-fact-value${mono ? " run-fact-mono" : ""}${numeric ? " numeric" : ""}`}
        title={value}
      >
        {value}
      </span>
    </div>
  );
}

function backendLabel(backend: string): string {
  return backend === "claude_code" ? "Claude Code" : backend === "codex" ? "Codex" : backend;
}

function normalizeRunKind(value: RunKind | null | undefined): RunKind {
  return value === "review" ? "review" : "normal";
}

function runKindLabel(value: RunKind): string {
  return value === "review" ? "Review agent" : "Normal run";
}

function statusTone(status: string): string {
  const value = status.toLowerCase();
  if (value.includes("block") || value.includes("fail") || value.includes("error")) {
    return "blocked";
  }
  if (value.includes("complete") || value.includes("done")) {
    return "completed";
  }
  return "running";
}

function statusLabel(status: string): string {
  if (status === "running") {
    return "Running";
  }
  if (status === "retrying") {
    return "Retrying";
  }
  if (status === "blocked") {
    return "Blocked";
  }
  if (status === "completed") {
    return "Completed";
  }
  return status;
}

function compactId(value: string): string {
  return value.length > 30 ? `${value.slice(0, 12)}…${value.slice(-10)}` : value;
}

function formatInt(value: number): string {
  return Math.trunc(value).toLocaleString("en-US");
}

function formatRuntime(startedAt: string | null | undefined, endedAt: string | null): string {
  if (startedAt === null || startedAt === undefined) {
    return "n/a";
  }
  const started = Date.parse(startedAt);
  if (!Number.isFinite(started)) {
    return "n/a";
  }
  const ended = endedAt === null ? Date.now() : Date.parse(endedAt);
  if (!Number.isFinite(ended)) {
    return "n/a";
  }
  const seconds = Math.max(0, Math.floor((ended - started) / 1000));
  if (seconds < 60) {
    return `${seconds}s`;
  }
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  if (minutes < 60) {
    return `${minutes}m ${remainder}s`;
  }
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}
