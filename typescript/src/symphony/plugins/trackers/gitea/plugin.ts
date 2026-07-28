// Gitea tracker plugin. Provider-specific REST paths, state projection, and
// write-backs stay in the Gitea client; this module only owns registry-facing
// configuration, capability wiring, and the injectable client seam.

import { getEnv } from "../../../app-env.ts";
import { settingsBang } from "../../../config.ts";
import type { JsonMap } from "../../../config/schema.ts";
import { type Result, err, ok } from "../../../result.ts";
import type { Issue } from "../../../work-item.ts";
import { castPluginString, envOrNull, resolveSecretSetting } from "../../shared/config-helpers.ts";
import {
  type PluginFieldError,
  type TrackerError,
  type TrackerPlugin,
  toTrackerError,
  trackerError,
} from "../types.ts";
import {
  GITEA_API_TOOL,
  type GiteaApiRepository,
  executeGiteaApiWith,
  giteaApiToolSpec,
} from "./api-tool.ts";
import { Client, type GiteaClientModule, request } from "./client.ts";
import { giteaInstanceUrl, giteaSettings, repositoryUrl } from "./settings.ts";

function clientModule(): GiteaClientModule {
  return getEnv<GiteaClientModule>("gitea_client_module", Client);
}

export const GiteaPlugin: TrackerPlugin = {
  id: "gitea",
  displayName: "Gitea",

  configSchema: {
    cast(raw: JsonMap, section: string): { value: JsonMap; errors: PluginFieldError[] } {
      const errors: PluginFieldError[] = [];
      const endpoint = castPluginString(raw, "endpoint", section, null, errors);
      const token = castAliasString(raw, "token", ["api_token"], section, errors);
      const owner = castAliasString(raw, "owner", ["user", "repository_owner"], section, errors);
      const repo = castAliasString(raw, "repo", ["repository", "repository_name"], section, errors);
      return {
        value: {
          endpoint,
          token,
          owner,
          repo,
          assignee: castPluginString(raw, "assignee", section, null, errors),
        },
        errors,
      };
    },

    finalize(value: JsonMap): JsonMap {
      return {
        ...value,
        token: resolveSecretSetting(stringOrNull(value.token), envOrNull("GITEA_API_TOKEN")),
      };
    },

    validate(settings): Result<undefined, TrackerError> {
      const gitea = giteaSettings(settings);
      if (gitea.endpoint === null) {
        return err(
          trackerError(
            "missing_gitea_endpoint",
            "missing_config",
            "Gitea endpoint missing in WORKFLOW.md",
          ),
        );
      }
      if (giteaInstanceUrl(gitea.endpoint) === null) {
        return err(
          trackerError(
            "invalid_gitea_endpoint",
            "missing_config",
            "Gitea endpoint must be an http(s) URL without query credentials",
            { endpoint: gitea.endpoint },
          ),
        );
      }
      if (gitea.token === null) {
        return err(
          trackerError(
            "missing_gitea_api_token",
            "missing_credentials",
            "Gitea API token missing in WORKFLOW.md",
          ),
        );
      }
      if (gitea.owner === null) {
        return err(
          trackerError(
            "missing_gitea_owner",
            "missing_config",
            "Gitea repository owner missing in WORKFLOW.md",
          ),
        );
      }
      if (gitea.repo === null) {
        return err(
          trackerError(
            "missing_gitea_repository",
            "missing_config",
            "Gitea repository name missing in WORKFLOW.md",
          ),
        );
      }
      return ok(undefined);
    },
  },

  fetchCandidateIssues(): Promise<Result<Issue[], TrackerError>> {
    return normalizeReadCall(() => clientModule().fetchCandidateIssues());
  },
  fetchIssuesByStates(states: string[]): Promise<Result<Issue[], TrackerError>> {
    return normalizeReadCall(() => clientModule().fetchIssuesByStates(states));
  },
  fetchIssueStatesByIds(ids: string[]): Promise<Result<Issue[], TrackerError>> {
    return normalizeReadCall(() => clientModule().fetchIssueStatesByIds(ids));
  },

  comments: {
    createComment: async (issueId, body): Promise<Result<undefined, TrackerError>> => {
      try {
        return normalizeWriteResult(await clientModule().createComment(issueId, body));
      } catch (error) {
        return err(toTrackerError(error));
      }
    },
  },

  stateUpdates: {
    updateIssueState: async (issueId, stateName): Promise<Result<undefined, TrackerError>> => {
      try {
        return normalizeWriteResult(await clientModule().updateIssueState(issueId, stateName));
      } catch (error) {
        return err(toTrackerError(error));
      }
    },
  },

  agentTools: {
    listAgentTools: () => [giteaApiToolSpec],
    executeAgentTool: (tool, args, opts) => {
      if (tool !== GITEA_API_TOOL) {
        return Promise.resolve({
          success: false,
          payload: { error: { message: `Unsupported dynamic tool: ${JSON.stringify(tool)}.` } },
        });
      }
      const gitea = giteaSettings(settingsBang());
      const repository: GiteaApiRepository | null =
        gitea.owner !== null && gitea.repo !== null
          ? { owner: gitea.owner, repo: gitea.repo }
          : null;
      return executeGiteaApiWith(
        (method, path, body) => request(method, path, body),
        args,
        repository,
        opts,
      );
    },
  },

  ui: {
    projectUrl: (settings) => repositoryUrl(giteaSettings(settings)),
    workItemNoun: "Gitea issue",
  },
};

async function normalizeReadCall(operation: () => unknown): Promise<Result<Issue[], TrackerError>> {
  try {
    return await normalizeReadResult(operation());
  } catch (error) {
    return err(toTrackerError(error));
  }
}

function castAliasString(
  raw: JsonMap,
  primary: string,
  aliases: string[],
  section: string,
  errors: PluginFieldError[],
): string | null {
  const primaryValue = castPluginString(raw, primary, section, null, errors);
  if (primaryValue !== null || primary in raw) {
    return primaryValue;
  }
  for (const alias of aliases) {
    const value = castPluginString(raw, alias, section, null, errors);
    if (value !== null || alias in raw) {
      return value;
    }
  }
  return null;
}

async function normalizeReadResult(response: unknown): Promise<Result<Issue[], TrackerError>> {
  try {
    const resolved = await response;
    if (isOkResult(resolved)) {
      if (Array.isArray(resolved.value)) {
        return ok(resolved.value as Issue[]);
      }
      return err(
        trackerError(
          "gitea_invalid_client_result",
          "invalid_payload",
          "Gitea client returned a non-list read payload",
          resolved.value,
        ),
      );
    }
    if (isErrResult(resolved)) {
      return err(toTrackerError(resolved.error));
    }
    return err(toTrackerError(resolved));
  } catch (error) {
    return err(toTrackerError(error));
  }
}

function normalizeWriteResult(response: unknown): Result<undefined, TrackerError> {
  if (isOkResult(response)) {
    return ok(undefined);
  }
  if (isErrResult(response)) {
    return err(toTrackerError(response.error));
  }
  return err(toTrackerError(response));
}

function isOkResult(value: unknown): value is { ok: true; value: unknown } {
  return typeof value === "object" && value !== null && (value as { ok?: unknown }).ok === true;
}

function isErrResult(value: unknown): value is { ok: false; error: unknown } {
  return typeof value === "object" && value !== null && (value as { ok?: unknown }).ok === false;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}
