// In-memory tracker plugin for tests/local dev. Wraps the memory adapter,
// whose issues come from app-env injection (`memory_tracker_issues`) or the
// WORKFLOW.md `tracker.seed_issues` extension; write-backs are replayed to the
// injected `memory_tracker_recipient` callback. It implements every optional
// capability so it can stand in for a full-featured tracker in tests.

import type { JsonMap } from "../../config/schema.ts";
import { ok } from "../../result.ts";
import * as Memory from "../../tracker/memory.ts";
import type { PluginFieldError, TrackerPlugin } from "../types.ts";

export const MemoryPlugin: TrackerPlugin = {
  id: "memory",
  displayName: "In-memory (testing)",

  configSchema: {
    // Permissive by design: seed entries stay exactly as authored and the
    // memory tracker skips malformed ones at read time, matching the
    // pre-plugin behavior where the schema ignored this key entirely.
    cast(raw: JsonMap, _section: string): { value: JsonMap; errors: PluginFieldError[] } {
      const value: JsonMap = {};
      if (Array.isArray(raw.seed_issues)) {
        value.seed_issues = raw.seed_issues;
      }
      return { value, errors: [] };
    },

    finalize(value: JsonMap): JsonMap {
      return value;
    },

    validate() {
      return ok(undefined);
    },
  },

  fetchCandidateIssues: Memory.fetchCandidateIssues,
  fetchIssuesByStates: Memory.fetchIssuesByStates,
  fetchIssueStatesByIds: Memory.fetchIssueStatesByIds,

  comments: { createComment: Memory.createComment },
  stateUpdates: { updateIssueState: Memory.updateIssueState },
};
