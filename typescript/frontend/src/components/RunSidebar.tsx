import type { RunItem } from "../lib/api";

type RunSidebarProps = {
  running: RunItem[];
  retrying: RunItem[];
  blocked: RunItem[];
  completed: RunItem[];
  selected: string | null;
  onSelect: (identifier: string) => void;
};

export function RunSidebar({
  running,
  retrying,
  blocked,
  completed,
  selected,
  onSelect,
}: RunSidebarProps) {
  const activeRuns = [
    ...running,
    ...retrying.map((item) => ({
      ...item,
      title: item.title ?? "Retry scheduled",
      status: "retrying",
    })),
  ];
  const groups = [
    { label: "Running", tone: "running", items: activeRuns },
    { label: "Blocked", tone: "blocked", items: blocked },
    { label: "Completed", tone: "completed", items: completed },
  ] as const;

  return (
    <>
      <aside className="run-sidebar" aria-label="Agent runs">
        <div className="sidebar-masthead">
          <div className="brand-mark" aria-hidden="true">
            S
          </div>
          <div>
            <p className="sidebar-kicker">Symphony</p>
            <p className="sidebar-title">Observability</p>
          </div>
          <span className="live-chip">
            <span className="live-chip-dot" /> live
          </span>
        </div>
        <div className="sidebar-rule" />
        <div className="sidebar-heading-row">
          <p className="sidebar-heading">Runs</p>
          <span className="sidebar-count">
            {activeRuns.length + blocked.length + completed.length}
          </span>
        </div>
        <nav className="run-groups">
          {groups.map((group) => (
            <section className="run-group" key={group.label}>
              <div className="run-group-label">
                <span className={`status-dot status-dot-${group.tone}`} />
                <span>{group.label}</span>
                <span className="run-group-count">{group.items.length}</span>
              </div>
              {group.items.length === 0 ? (
                <p className="sidebar-empty">No {group.label.toLowerCase()} runs</p>
              ) : (
                <div className="run-list">
                  {group.items.map((item) => (
                    <RunButton
                      key={`${item.issue_identifier}-${item.run_id ?? item.session_id ?? group.label}`}
                      item={item}
                      active={item.issue_identifier === selected}
                      tone={group.tone}
                      onSelect={onSelect}
                    />
                  ))}
                </div>
              )}
            </section>
          ))}
        </nav>
        <div className="sidebar-footer">
          <span className="sidebar-footer-rule" />
          <p>Local runtime · read only</p>
        </div>
      </aside>

      <label className="mobile-run-picker">
        <span className="mobile-picker-label">Selected run</span>
        <select
          value={selected ?? ""}
          onChange={(event) => onSelect(event.target.value)}
          aria-label="Select a run"
        >
          <option value="">Choose a run</option>
          {[...activeRuns, ...blocked, ...completed].map((item) => (
            <option
              key={`${item.issue_identifier}-${item.run_id ?? item.session_id ?? "run"}`}
              value={item.issue_identifier}
            >
              {item.issue_identifier} · {item.backend ?? "agent"}
            </option>
          ))}
        </select>
      </label>
    </>
  );
}

function RunButton({
  item,
  active,
  tone,
  onSelect,
}: {
  item: RunItem;
  active: boolean;
  tone: "running" | "blocked" | "completed";
  onSelect: (identifier: string) => void;
}) {
  return (
    <button
      className={`run-button${active ? " run-button-active" : ""}`}
      type="button"
      aria-current={active ? "true" : undefined}
      onClick={() => onSelect(item.issue_identifier)}
    >
      <span className={`status-dot status-dot-${tone}`} />
      <span className="run-button-copy">
        <span className="run-button-id">{item.issue_identifier}</span>
        <span className="run-button-title">{item.title ?? "Untitled run"}</span>
      </span>
      <span className="run-button-meta">
        <span className="backend-chip">{backendLabel(item.backend)}</span>
        <span>{relativeTime(item.updated_at ?? item.last_event_at ?? item.started_at)}</span>
      </span>
    </button>
  );
}

function backendLabel(backend: string | null | undefined): string {
  return backend === "claude_code"
    ? "Claude"
    : backend === "codex"
      ? "Codex"
      : (backend ?? "Agent");
}

function relativeTime(value: string | null | undefined): string {
  if (!value) {
    return "n/a";
  }
  const delta = Math.max(0, Date.now() - new Date(value).getTime());
  if (!Number.isFinite(delta)) {
    return "n/a";
  }
  const seconds = Math.floor(delta / 1000);
  if (seconds < 60) {
    return `${seconds}s`;
  }
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m`;
}
