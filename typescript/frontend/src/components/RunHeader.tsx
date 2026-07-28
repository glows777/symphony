import type { IssueDetail, RunItem, RunMetadata } from "../lib/api";

type RunHeaderProps = {
  identifier: string | null;
  detail: IssueDetail | null;
  run: RunItem | RunMetadata | null;
  loading: boolean;
};

export function RunHeader({ identifier, detail, run, loading }: RunHeaderProps) {
  const snapshotRun = detail?.running ?? detail?.retry ?? detail?.blocked ?? null;
  const backend = run?.backend ?? detail?.logs?.latest_run?.backend ?? "agent";
  const status = detail?.status ?? run?.status ?? "waiting";
  const title = detail?.title ?? run?.title ?? identifier ?? "Select a run";
  const workspace =
    detail?.workspace?.path ??
    snapshotRun?.workspace_path ??
    (run !== null && "workspace_path" in run ? run.workspace_path : null) ??
    "Not assigned";
  const session =
    snapshotRun?.session_id ??
    run?.session_id ??
    detail?.logs?.latest_run?.session_id ??
    "Not started";
  const turn = snapshotRun?.turn_count ?? "n/a";
  const tokens = snapshotRun?.tokens?.total_tokens ?? null;
  const startedAt = snapshotRun?.started_at ?? run?.started_at ?? null;
  const endedAt = run?.ended_at ?? null;

  return (
    <header className="run-header">
      <div className="run-header-topline">
        <div className="run-breadcrumb">
          <span>Observability</span>
          <span className="breadcrumb-slash">/</span>
          <span>{identifier ?? "Run workspace"}</span>
        </div>
        <span className={`state-pill state-pill-${statusTone(status)}`}>
          <span className="state-pill-dot" />
          {statusLabel(status)}
        </span>
      </div>
      <div className="run-title-row">
        <div>
          <p className="run-eyebrow">Selected issue</p>
          <h1>{loading ? "Loading run details" : title}</h1>
          <p className="run-subtitle">
            {identifier ?? "Choose a run from the sidebar"}
            <span className="subtitle-divider">·</span>
            <span className="backend-badge">{backendLabel(backend)}</span>
          </p>
        </div>
        <div className="read-only-stamp">
          <span className="read-only-icon">⊙</span>
          <span>Read only</span>
        </div>
      </div>
      <div className="run-facts" aria-label="Run summary">
        <Fact label="Workspace" value={workspace} mono />
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
