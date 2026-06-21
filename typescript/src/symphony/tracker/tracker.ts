// Literal port of `symphony_elixir/tracker.ex`.
//
// Adapter boundary for issue tracker reads/writes. Selects the memory or Linear
// adapter from config and delegates.

import { settingsBang } from "../config.ts";
import * as LinearAdapter from "../linear/adapter.ts";
import type { Issue } from "../linear/issue.ts";
import type { Result } from "../result.ts";
import * as Memory from "./memory.ts";

export type TrackerAdapter = {
  fetchCandidateIssues(): Promise<Result<Issue[], unknown>>;
  fetchIssuesByStates(states: string[]): Promise<Result<Issue[], unknown>>;
  fetchIssueStatesByIds(ids: string[]): Promise<Result<Issue[], unknown>>;
  createComment(issueId: string, body: string): Promise<Result<undefined, unknown>>;
  updateIssueState(issueId: string, stateName: string): Promise<Result<undefined, unknown>>;
};

export function adapter(): TrackerAdapter {
  return settingsBang().tracker.kind === "memory" ? Memory : LinearAdapter;
}

export function fetchCandidateIssues(): Promise<Result<Issue[], unknown>> {
  return adapter().fetchCandidateIssues();
}

export function fetchIssuesByStates(states: string[]): Promise<Result<Issue[], unknown>> {
  return adapter().fetchIssuesByStates(states);
}

export function fetchIssueStatesByIds(ids: string[]): Promise<Result<Issue[], unknown>> {
  return adapter().fetchIssueStatesByIds(ids);
}

export function createComment(issueId: string, body: string): Promise<Result<undefined, unknown>> {
  return adapter().createComment(issueId, body);
}

export function updateIssueState(
  issueId: string,
  stateName: string,
): Promise<Result<undefined, unknown>> {
  return adapter().updateIssueState(issueId, stateName);
}
