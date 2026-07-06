// Lark (Feishu) Bitable client seam. The full HTTP client — tenant token
// cache, record search/batch_get/update, normalization into WorkItems — lands
// with the read operations; this module establishes the injectable-module
// shape used by the `lark_client_module` app-env seam (mirroring
// `linear_client_module`).

import { type Result, err } from "../../result.ts";
import { type TrackerError, trackerError } from "../types.ts";
import type { Issue } from "../work-item.ts";

export type LarkClientModule = {
  fetchCandidateIssues(): Promise<Result<Issue[], TrackerError>>;
  fetchIssuesByStates(states: string[]): Promise<Result<Issue[], TrackerError>>;
  fetchIssueStatesByIds(ids: string[]): Promise<Result<Issue[], TrackerError>>;
};

function notImplemented(): Promise<Result<never, TrackerError>> {
  return Promise.resolve(
    err(
      trackerError(
        "lark_client_not_implemented",
        "unknown",
        "the Lark Bitable client is not implemented yet",
      ),
    ),
  );
}

// Default client module; replaced by the real Bitable HTTP client.
export const Client: LarkClientModule = {
  fetchCandidateIssues: notImplemented,
  fetchIssuesByStates: notImplemented,
  fetchIssueStatesByIds: notImplemented,
};
