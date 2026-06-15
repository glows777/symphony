// Literal port of `symphony_elixir/tracker/memory.ex`.
//
// In-memory tracker adapter for tests/local dev. Issues and an optional event
// recipient are injected via app-env. The Elixir version `send/2`s tuples to a
// pid; the TS port invokes a recipient callback with tagged messages.

import { getEnv } from "../app-env.ts";
import { type Issue, isIssue } from "../linear/issue.ts";
import { type Result, ok } from "../result.ts";

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
  return configuredIssues().filter(isIssue);
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
