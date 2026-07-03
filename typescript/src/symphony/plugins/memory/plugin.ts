// In-memory tracker plugin for tests/local dev. Wraps the memory adapter,
// whose issues come from app-env injection (`memory_tracker_issues`) or the
// WORKFLOW.md `tracker.seed_issues` extension; write-backs are replayed to the
// injected `memory_tracker_recipient` callback. It implements every optional
// capability so it can stand in for a full-featured tracker in tests.

import * as Memory from "../../tracker/memory.ts";
import type { TrackerPlugin } from "../types.ts";

export const MemoryPlugin: TrackerPlugin = {
  id: "memory",
  displayName: "In-memory (testing)",

  fetchCandidateIssues: Memory.fetchCandidateIssues,
  fetchIssuesByStates: Memory.fetchIssuesByStates,
  fetchIssueStatesByIds: Memory.fetchIssueStatesByIds,

  comments: { createComment: Memory.createComment },
  stateUpdates: { updateIssueState: Memory.updateIssueState },
};
