// Adapter boundary for issue tracker reads/writes. Originally a literal port
// of `symphony_elixir/tracker.ex` (memory/linear hardcoded two-way switch);
// now resolves the active tracker plugin from the registry by
// `settings.tracker.kind` and delegates. Write operations are optional plugin
// capabilities — when the active plugin does not provide one, the facade
// returns a structured `unsupported_operation` error instead of a silent
// no-op, so callers can detect and degrade.

// Side-effect import: guarantees built-in plugins are registered before any
// facade call resolves a kind.
import "../plugins/index.ts";

import { settingsBang } from "../config.ts";
import type { Issue } from "../linear/issue.ts";
import { trackerPlugin } from "../plugins/registry.ts";
import { type TrackerError, type TrackerPlugin, trackerError } from "../plugins/types.ts";
import { type Result, err } from "../result.ts";

// Resolves the active plugin from the current WORKFLOW.md config. Fails with
// `missing_tracker_kind` / `unsupported_tracker_kind` (same tags config
// validation uses) when the kind cannot be resolved.
export function activePlugin(): Result<TrackerPlugin, TrackerError> {
  return trackerPlugin(settingsBang().tracker.kind);
}

// Identity accessor kept for tests and introspection; throws when the
// configured kind is not registered.
export function adapter(): TrackerPlugin {
  const plugin = activePlugin();
  if (!plugin.ok) {
    throw new Error(plugin.error.message);
  }
  return plugin.value;
}

export function fetchCandidateIssues(): Promise<Result<Issue[], unknown>> {
  const plugin = activePlugin();
  if (!plugin.ok) {
    return Promise.resolve(err(plugin.error));
  }
  return plugin.value.fetchCandidateIssues();
}

export function fetchIssuesByStates(states: string[]): Promise<Result<Issue[], unknown>> {
  const plugin = activePlugin();
  if (!plugin.ok) {
    return Promise.resolve(err(plugin.error));
  }
  return plugin.value.fetchIssuesByStates(states);
}

export function fetchIssueStatesByIds(ids: string[]): Promise<Result<Issue[], unknown>> {
  const plugin = activePlugin();
  if (!plugin.ok) {
    return Promise.resolve(err(plugin.error));
  }
  return plugin.value.fetchIssueStatesByIds(ids);
}

export function createComment(issueId: string, body: string): Promise<Result<undefined, unknown>> {
  const plugin = activePlugin();
  if (!plugin.ok) {
    return Promise.resolve(err(plugin.error));
  }
  const capability = plugin.value.comments;
  if (capability === undefined) {
    return Promise.resolve(err(unsupportedCapability(plugin.value, "comments")));
  }
  return capability.createComment(issueId, body);
}

export function updateIssueState(
  issueId: string,
  stateName: string,
): Promise<Result<undefined, unknown>> {
  const plugin = activePlugin();
  if (!plugin.ok) {
    return Promise.resolve(err(plugin.error));
  }
  const capability = plugin.value.stateUpdates;
  if (capability === undefined) {
    return Promise.resolve(err(unsupportedCapability(plugin.value, "state updates")));
  }
  return capability.updateIssueState(issueId, stateName);
}

function unsupportedCapability(plugin: TrackerPlugin, capability: string): TrackerError {
  return trackerError(
    "tracker_capability_unsupported",
    "unsupported_operation",
    `tracker '${plugin.id}' does not support ${capability}`,
  );
}
