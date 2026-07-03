// Linear tracker plugin. Aggregates the Linear GraphQL adapter (reads +
// mutation write-backs) behind the TrackerPlugin contract. The underlying
// client/adapter modules keep their existing test seams (`linear_client_module`
// app-env injection).

import * as Adapter from "../../linear/adapter.ts";
import type { TrackerPlugin } from "../types.ts";

export const LinearPlugin: TrackerPlugin = {
  id: "linear",
  displayName: "Linear",

  fetchCandidateIssues: Adapter.fetchCandidateIssues,
  fetchIssuesByStates: Adapter.fetchIssuesByStates,
  fetchIssueStatesByIds: Adapter.fetchIssueStatesByIds,

  comments: { createComment: Adapter.createComment },
  stateUpdates: { updateIssueState: Adapter.updateIssueState },
};
