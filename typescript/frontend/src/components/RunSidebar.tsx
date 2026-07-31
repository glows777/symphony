import { ChevronRight, Circle, Folder, LoaderCircle } from "lucide-react";
import { useState } from "react";
import type { RunItem, RunKind, RunMetadata } from "../lib/api";

type RunSidebarProps = {
  running: RunItem[];
  retrying: RunItem[];
  blocked: RunItem[];
  completed: RunItem[];
  selected: string | null;
  selectedRunId: string | null;
  onSelect: (identifier: string, runId?: string | null) => void;
};

type SessionEntry = {
  key: string;
  runId: string | null;
  sessionId: string | null;
  displayName: string | null;
  runKind: RunKind;
  status: string;
  backend: string | null | undefined;
  startedAt: string | null | undefined;
  endedAt: string | null | undefined;
  updatedAt: string | null | undefined;
  current: boolean;
};

export type IssueRunGroup = {
  identifier: string;
  title: string;
  status: string;
  sessions: SessionEntry[];
};

export function RunSidebar({
  running,
  retrying,
  blocked,
  completed,
  selected,
  selectedRunId,
  onSelect,
}: RunSidebarProps) {
  const [collapsedIssues, setCollapsedIssues] = useState<Set<string>>(new Set());
  const groups = groupRunsByIssue([
    ...running,
    ...retrying.map((item) => ({
      ...item,
      status: "retrying",
    })),
    ...blocked,
    ...completed,
  ]);
  const orderedGroups = [...groups].sort((left, right) => {
    const leftSelected = left.identifier === selected;
    const rightSelected = right.identifier === selected;
    if (leftSelected !== rightSelected) {
      return leftSelected ? -1 : 1;
    }
    return statusPriority(right.status) - statusPriority(left.status);
  });

  return (
    <>
      <aside className="run-sidebar" aria-label="Symphony projects">
        <div className="sidebar-masthead">
          <h2 className="sidebar-title">Symphony</h2>
        </div>

        <section className="sidebar-section sidebar-projects" aria-labelledby="projects-heading">
          <div className="sidebar-section-heading">
            <p id="projects-heading">Projects</p>
          </div>
          <nav className="issue-projects" aria-label="Projects with issues">
            {groups.length === 0 ? (
              <p className="sidebar-empty">No issues with runs</p>
            ) : (
              orderedGroups.map((group) => (
                <section className="issue-project" key={group.identifier}>
                  <button
                    className="issue-project-button"
                    type="button"
                    aria-expanded={!collapsedIssues.has(group.identifier)}
                    aria-controls={issueSessionsId(group.identifier)}
                    onClick={() => {
                      setCollapsedIssues((current) => {
                        const next = new Set(current);
                        if (next.has(group.identifier)) {
                          next.delete(group.identifier);
                        } else {
                          next.add(group.identifier);
                        }
                        return next;
                      });
                      onSelect(group.identifier, group.sessions[0]?.runId ?? null);
                    }}
                  >
                    <ChevronRight
                      className={`project-chevron${collapsedIssues.has(group.identifier) ? "" : " project-chevron-open"}`}
                      size={15}
                      strokeWidth={1.7}
                      aria-hidden="true"
                    />
                    <Folder
                      className="project-folder"
                      size={19}
                      strokeWidth={1.7}
                      aria-hidden="true"
                    />
                    <span
                      className={`issue-project-status issue-project-status-${statusTone(group.status)}`}
                      aria-hidden="true"
                    />
                    <span className="issue-project-copy">
                      <span className="issue-project-id">{group.identifier}</span>
                      <span className="issue-project-title" title={group.title}>
                        {group.title}
                      </span>
                    </span>
                    <span className="issue-project-count">{group.sessions.length}</span>
                  </button>
                  {!collapsedIssues.has(group.identifier) ? (
                    <div className="session-list" id={issueSessionsId(group.identifier)}>
                      {group.sessions.map((session, index) => (
                        <SessionButton
                          key={`${group.identifier}:${session.key}`}
                          session={session}
                          label={sessionName(session, index)}
                          index={index}
                          active={
                            selected === group.identifier &&
                            (selectedRunId !== null
                              ? session.runId === selectedRunId
                              : session === group.sessions[0])
                          }
                          onSelect={() => onSelect(group.identifier, session.runId)}
                        />
                      ))}
                    </div>
                  ) : null}
                </section>
              ))
            )}
          </nav>
        </section>

        <div className="sidebar-footer">
          <p>Runtime output · read only</p>
        </div>
      </aside>

      <label className="mobile-run-picker">
        <span className="mobile-picker-label">Selected session</span>
        <select
          value={mobileSelectionValue(groups, selected, selectedRunId)}
          onChange={(event) => {
            const selection = parseSelectionValue(event.target.value);
            if (selection !== null) {
              onSelect(selection.identifier, selection.runId);
            }
          }}
          aria-label="Select a session"
        >
          <option value="">Choose a session</option>
          {groups.map((group) => (
            <optgroup key={group.identifier} label={`${group.identifier} · ${group.title}`}>
              {group.sessions.map((session, index) => (
                <option key={session.key} value={selectionValue(group.identifier, session.runId)}>
                  {group.identifier} · {sessionLabel(session, index)}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
      </label>
    </>
  );
}

function SessionButton({
  session,
  label,
  index,
  active,
  onSelect,
}: {
  session: SessionEntry;
  label?: string;
  index: number;
  active: boolean;
  onSelect: () => void;
}) {
  const working = statusTone(session.status) === "running";

  return (
    <button
      className={`session-button${active ? " session-button-active" : ""}${working ? " session-button-working" : ""}`}
      type="button"
      aria-current={active ? "true" : undefined}
      onClick={onSelect}
    >
      <span className="session-button-copy">
        <span className="session-button-label">{label ?? sessionName(session, index)}</span>
        <span className="session-button-meta">
          <Circle
            className={`session-status-dot session-status-${statusTone(session.status)}`}
            size={6}
            strokeWidth={0}
            fill="currentColor"
            aria-hidden="true"
          />
          <span>{sessionNameMeta(session, index)}</span>
          <span className="session-button-time">
            {relativeTime(session.updatedAt ?? session.endedAt ?? session.startedAt)}
          </span>
          {working ? (
            <LoaderCircle
              className="session-working-indicator"
              size={15}
              strokeWidth={1.7}
              role="img"
              aria-label="Working"
            />
          ) : null}
        </span>
      </span>
    </button>
  );
}

export function groupRunsByIssue(items: RunItem[]): IssueRunGroup[] {
  const groups = new Map<string, IssueRunGroup>();

  for (const item of items) {
    const identifier = item.issue_identifier;
    const group = groups.get(identifier) ?? {
      identifier,
      title: item.title ?? identifier,
      status: item.status ?? "completed",
      sessions: [],
    };
    if (group.title === group.identifier && item.title) {
      group.title = item.title;
    }
    if (statusPriority(item.status) > statusPriority(group.status)) {
      group.status = item.status ?? group.status;
    }

    for (const history of item.history ?? []) {
      addSession(group, sessionFromMetadata(history));
    }

    if (!hasSessionForItem(group.sessions, item)) {
      addSession(group, sessionFromItem(item));
    }
    groups.set(identifier, group);
  }

  return [...groups.values()];
}

function sessionFromMetadata(run: RunMetadata): SessionEntry {
  return {
    key: sessionKey(run.run_id, run.session_id, run.issue_identifier),
    runId: run.run_id,
    sessionId: run.session_id,
    displayName: run.display_name ?? null,
    runKind: normalizeRunKind(run.run_kind),
    status: run.status,
    backend: run.backend,
    startedAt: run.started_at,
    endedAt: run.ended_at,
    updatedAt: run.ended_at ?? run.started_at,
    current: run.status === "running",
  };
}

function sessionFromItem(item: RunItem): SessionEntry {
  return {
    key: sessionKey(item.run_id ?? null, item.session_id ?? null, item.issue_identifier),
    runId: item.run_id ?? null,
    sessionId: item.session_id ?? null,
    displayName: item.display_name ?? null,
    runKind: normalizeRunKind(item.run_kind),
    status: item.status ?? "completed",
    backend: item.backend,
    startedAt: item.started_at,
    endedAt: item.ended_at,
    updatedAt: item.updated_at ?? item.last_event_at ?? item.started_at,
    current: item.status === "running" || item.status === "retrying",
  };
}

function addSession(group: IssueRunGroup, session: SessionEntry): void {
  const existingIndex = group.sessions.findIndex(
    (current) =>
      (session.runId !== null && current.runId === session.runId) ||
      (session.sessionId !== null && current.sessionId === session.sessionId),
  );
  if (existingIndex === -1) {
    group.sessions.push(session);
    return;
  }
  const existing = group.sessions[existingIndex];
  if (existing !== undefined && session.current && !existing.current) {
    group.sessions[existingIndex] = session;
  }
}

function hasSessionForItem(sessions: SessionEntry[], item: RunItem): boolean {
  const matchesIdentity = sessions.some(
    (session) =>
      (item.run_id !== null && item.run_id !== undefined && session.runId === item.run_id) ||
      (item.session_id !== null &&
        item.session_id !== undefined &&
        session.sessionId === item.session_id),
  );
  if (matchesIdentity) {
    return true;
  }

  // The running projection can briefly have neither ID while its history
  // already contains the same in-progress run. Do not add a placeholder row
  // for that startup window.
  return (
    item.status === "running" &&
    (item.run_id === null || item.run_id === undefined) &&
    (item.session_id === null || item.session_id === undefined) &&
    sessions.some((session) => session.current)
  );
}

function sessionKey(runId: string | null, sessionId: string | null, identifier: string): string {
  return runId !== null
    ? `run:${runId}`
    : sessionId !== null
      ? `session:${sessionId}`
      : `snapshot:${identifier}`;
}

function sessionLabel(session: SessionEntry, index: number): string {
  const name =
    session.displayName ?? (session.current ? "Current session" : `Session ${index + 1}`);
  return `${name} · ${runKindLabel(session.runKind)}`;
}

function sessionName(session: SessionEntry, index: number): string {
  return session.displayName ?? (session.current ? "Current session" : `Session ${index + 1}`);
}

function sessionNameMeta(session: SessionEntry, index: number): string {
  const name = sessionName(session, index);
  if (name !== "Current session" && name !== `Session ${index + 1}`) {
    return `${backendLabel(session.backend)} · ${runKindLabel(session.runKind)}`;
  }
  return session.sessionId === null && session.runId === null
    ? "No session id"
    : `${backendLabel(session.backend)} · ${runKindLabel(session.runKind)}`;
}

function normalizeRunKind(value: RunKind | null | undefined): RunKind {
  return value === "review" ? "review" : "normal";
}

function runKindLabel(value: RunKind): string {
  return value === "review" ? "Review" : "Normal";
}

function statusPriority(status: string | null | undefined): number {
  const tone = statusTone(status);
  return tone === "running" ? 4 : tone === "retrying" || tone === "blocked" ? 3 : 1;
}

function statusTone(
  status: string | null | undefined,
): "running" | "retrying" | "blocked" | "completed" {
  const value = (status ?? "completed").toLowerCase();
  if (value.includes("block") || value.includes("fail") || value.includes("error")) {
    return "blocked";
  }
  if (value.includes("retry")) {
    return "retrying";
  }
  if (value.includes("run") || value.includes("progress")) {
    return "running";
  }
  return "completed";
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

function selectionValue(identifier: string, runId: string | null): string {
  return JSON.stringify([identifier, runId]);
}

function issueSessionsId(identifier: string): string {
  return `issue-sessions-${identifier.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
}

function mobileSelectionValue(
  groups: IssueRunGroup[],
  selected: string | null,
  selectedRunId: string | null,
): string {
  if (selected === null) {
    return "";
  }
  const group = groups.find((item) => item.identifier === selected);
  const runId = selectedRunId ?? group?.sessions[0]?.runId ?? null;
  return group === undefined ? "" : selectionValue(selected, runId);
}

function parseSelectionValue(value: string): { identifier: string; runId: string | null } | null {
  if (value === "") {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(value);
    if (
      Array.isArray(parsed) &&
      typeof parsed[0] === "string" &&
      (typeof parsed[1] === "string" || parsed[1] === null)
    ) {
      return { identifier: parsed[0], runId: parsed[1] };
    }
  } catch {
    return null;
  }
  return null;
}
