// Linear tracker plugin. Aggregates the Linear GraphQL adapter (reads +
// mutation write-backs) behind the TrackerPlugin contract. The underlying
// client/adapter modules keep their existing test seams (`linear_client_module`
// app-env injection).

import type { JsonMap } from "../../config/schema.ts";
import * as Adapter from "../../linear/adapter.ts";
import { type Result, err, ok } from "../../result.ts";
import { castPluginString, envOrNull, resolveSecretSetting } from "../config-helpers.ts";
import {
  type PluginFieldError,
  type TrackerError,
  type TrackerPlugin,
  trackerError,
} from "../types.ts";
import {
  LINEAR_GRAPHQL_TOOL,
  executeLinearGraphql,
  linearGraphqlToolSpec,
} from "./graphql-tool.ts";
import { DEFAULT_LINEAR_ENDPOINT, linearSettings } from "./settings.ts";

export const LinearPlugin: TrackerPlugin = {
  id: "linear",
  displayName: "Linear",

  configSchema: {
    cast(raw: JsonMap, section: string): { value: JsonMap; errors: PluginFieldError[] } {
      const errors: PluginFieldError[] = [];
      const value: JsonMap = {
        endpoint:
          castPluginString(raw, "endpoint", section, DEFAULT_LINEAR_ENDPOINT, errors) ??
          DEFAULT_LINEAR_ENDPOINT,
        api_key: castPluginString(raw, "api_key", section, null, errors),
        project_slug: castPluginString(raw, "project_slug", section, null, errors),
        assignee: castPluginString(raw, "assignee", section, null, errors),
      };
      return { value, errors };
    },

    finalize(value: JsonMap): JsonMap {
      return {
        ...value,
        api_key: resolveSecretSetting(stringOrNull(value.api_key), envOrNull("LINEAR_API_KEY")),
        assignee: resolveSecretSetting(stringOrNull(value.assignee), envOrNull("LINEAR_ASSIGNEE")),
      };
    },

    validate(settings): Result<undefined, TrackerError> {
      const linear = linearSettings(settings);
      if (linear.apiKey === null) {
        return err(
          trackerError(
            "missing_linear_api_token",
            "missing_credentials",
            "Linear API token missing in WORKFLOW.md",
          ),
        );
      }
      if (linear.projectSlug === null) {
        return err(
          trackerError(
            "missing_linear_project_slug",
            "missing_config",
            "Linear project slug missing in WORKFLOW.md",
          ),
        );
      }
      return ok(undefined);
    },
  },

  fetchCandidateIssues: Adapter.fetchCandidateIssues,
  fetchIssuesByStates: Adapter.fetchIssuesByStates,
  fetchIssueStatesByIds: Adapter.fetchIssueStatesByIds,

  comments: { createComment: Adapter.createComment },
  stateUpdates: { updateIssueState: Adapter.updateIssueState },

  agentTools: {
    listAgentTools: () => [linearGraphqlToolSpec],
    executeAgentTool: (tool, args, opts) => {
      if (tool !== LINEAR_GRAPHQL_TOOL) {
        return Promise.resolve({
          success: false,
          payload: { error: { message: `Unsupported dynamic tool: ${JSON.stringify(tool)}.` } },
        });
      }
      return executeLinearGraphql(args, opts);
    },
  },
};

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}
