// Originally a literal port of `symphony_elixir/tracker/memory.ex`; moved into
// plugins/memory for the tracker plugin architecture (see MIGRATION.md ->
// Post-cutover divergence).
//
// In-memory tracker adapter for tests/local dev. Issues and an optional event
// recipient are injected via app-env. The Elixir version `send/2`s tuples to a
// pid; the TS port invokes a recipient callback with tagged messages.
//
// TS-only addition (not in the Elixir reference): issues may also be declared
// directly in WORKFLOW.md under `tracker.seed_issues`. This makes the in-memory
// tracker self-contained from a single file, so a freshly-booted process (e.g.
// `bun run verify`'s child CLI) can run a real dispatch loop without any
// in-process app-env injection. App-env issues still win and are listed first;
// behavior is unchanged when no `seed_issues` key is present.

import { getEnv } from "../../app-env.ts";
import { settings } from "../../config.ts";
import type { JsonMap } from "../../config/schema.ts";
import { type Result, ok } from "../../result.ts";
import { type Issue, isIssue, newIssue } from "../work-item.ts";

export type MemoryEvent =
  | { tag: "memory_tracker_comment"; issueId: string; body: string }
  | { tag: "memory_tracker_state_update"; issueId: string; stateName: string };

export function fetchCandidateIssues(): Promise<Result<Issue[], unknown>> {
  return Promise.resolve(ok(issueEntries()));
}

export function fetchIssuesByStates(stateNames: unknown[]): Promise<Result<Issue[], unknown>> {
  const normalizedStates = new Set(stateNames.map(normalizeState));
  const issues = issueEntries().filter((issue) =>
    normalizedStates.has(normalizeState(issue.state)),
  );
  return Promise.resolve(ok(issues));
}

export function fetchIssueStatesByIds(issueIds: string[]): Promise<Result<Issue[], unknown>> {
  const wantedIds = new Set(issueIds);
  const issues = issueEntries().filter((issue) => issue.id !== null && wantedIds.has(issue.id));
  return Promise.resolve(ok(issues));
}

export function createComment(issueId: string, body: string): Promise<Result<undefined, unknown>> {
  sendEvent({ tag: "memory_tracker_comment", issueId, body });
  return Promise.resolve(ok(undefined));
}

export function updateIssueState(
  issueId: string,
  stateName: string,
): Promise<Result<undefined, unknown>> {
  sendEvent({ tag: "memory_tracker_state_update", issueId, stateName });
  return Promise.resolve(ok(undefined));
}

function configuredIssues(): unknown[] {
  return getEnv<unknown[]>("memory_tracker_issues", []);
}

function issueEntries(): Issue[] {
  return [...configuredIssues().filter(isIssue), ...seededIssues()];
}

// Reads `tracker.seed_issues` from the memory plugin's config section
// (claimed by its configSchema cast; entries keep their raw snake_cased
// shape) and brands each entry as an `Issue`. Unknown/blank entries are
// skipped.
function seededIssues(): Issue[] {
  const config = settings();
  if (!config.ok) {
    return [];
  }
  const seeds = config.value.tracker.plugin.seed_issues;
  if (!Array.isArray(seeds)) {
    return [];
  }
  return seeds.filter(isMap).map(issueFromConfig);
}

function issueFromConfig(map: JsonMap): Issue {
  return newIssue({
    id: stringOrNull(map.id),
    identifier: stringOrNull(map.identifier),
    title: stringOrNull(map.title),
    description: stringOrNull(map.description),
    priority: typeof map.priority === "number" ? map.priority : null,
    state: stringOrNull(map.state),
    branchName: stringOrNull(map.branch_name),
    url: stringOrNull(map.url),
    assigneeId: stringOrNull(map.assignee_id),
    labels: stringArray(map.labels),
    assignedToWorker: typeof map.assigned_to_worker === "boolean" ? map.assigned_to_worker : true,
  });
}

function isMap(value: unknown): value is JsonMap {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function sendEvent(message: MemoryEvent): void {
  const recipient = getEnv<((event: MemoryEvent) => void) | null>("memory_tracker_recipient", null);
  if (typeof recipient === "function") {
    recipient(message);
  }
}

function normalizeState(state: unknown): string {
  return typeof state === "string" ? state.trim().toLowerCase() : "";
}
