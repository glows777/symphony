// Lark (Feishu) task-center tracker plugin. Work items live in one Task v2
// tasklist (one tasklist = one board) and state is modeled on the tasklist's
// sections (one section = one column); reads delegate to the configured
// client module (overridable via the `lark_task_client_module` app-env,
// default Client). Unlike the Bitable plugin, the task center has a native
// comment API, so this plugin implements every optional capability.

import { getEnv } from "../../app-env.ts";
import type { JsonMap } from "../../config/schema.ts";
import { type Result, err, ok } from "../../result.ts";
import { castPluginString, envOrNull, resolveSecretSetting } from "../config-helpers.ts";
import { LARK_API_TOOL, executeLarkApiWith, larkApiToolSpec } from "../lark-common/api-tool.ts";
import {
  type PluginFieldError,
  type TrackerError,
  type TrackerPlugin,
  toTrackerError,
  trackerError,
} from "../types.ts";
import type { Issue } from "../work-item.ts";
import { Client, type LarkTaskClientModule, request, tasklistUrl } from "./client.ts";
import { DEFAULT_LARK_TASK_ENDPOINT, larkTaskSettings } from "./settings.ts";

function clientModule(): LarkTaskClientModule {
  return getEnv<LarkTaskClientModule>("lark_task_client_module", Client);
}

export const LarkTaskPlugin: TrackerPlugin = {
  id: "lark-task",
  displayName: "Lark (Feishu) Tasks",

  configSchema: {
    cast(raw: JsonMap, section: string): { value: JsonMap; errors: PluginFieldError[] } {
      const errors: PluginFieldError[] = [];
      const value: JsonMap = {
        endpoint:
          castPluginString(raw, "endpoint", section, DEFAULT_LARK_TASK_ENDPOINT, errors) ??
          DEFAULT_LARK_TASK_ENDPOINT,
        app_id: castPluginString(raw, "app_id", section, null, errors),
        app_secret: castPluginString(raw, "app_secret", section, null, errors),
        tasklist_guid: castPluginString(raw, "tasklist_guid", section, null, errors),
        assignee: castPluginString(raw, "assignee", section, null, errors),
      };
      return { value, errors };
    },

    finalize(value: JsonMap): JsonMap {
      return {
        ...value,
        app_secret: resolveSecretSetting(
          stringOrNull(value.app_secret),
          envOrNull("LARK_APP_SECRET"),
        ),
      };
    },

    validate(settings): Result<undefined, TrackerError> {
      const lark = larkTaskSettings(settings);
      if (lark.appId === null || lark.appSecret === null) {
        return err(
          trackerError(
            "missing_lark_task_credentials",
            "missing_credentials",
            "Lark app credentials (app_id/app_secret) missing in WORKFLOW.md",
          ),
        );
      }
      if (lark.tasklistGuid === null) {
        return err(
          trackerError(
            "missing_lark_task_tasklist",
            "missing_config",
            "Lark task-center tasklist_guid missing in WORKFLOW.md",
          ),
        );
      }
      return ok(undefined);
    },
  },

  fetchCandidateIssues(): Promise<Result<Issue[], TrackerError>> {
    return Promise.resolve(clientModule().fetchCandidateIssues());
  },
  fetchIssuesByStates(states: string[]): Promise<Result<Issue[], TrackerError>> {
    return Promise.resolve(clientModule().fetchIssuesByStates(states));
  },
  fetchIssueStatesByIds(ids: string[]): Promise<Result<Issue[], TrackerError>> {
    return Promise.resolve(clientModule().fetchIssueStatesByIds(ids));
  },

  comments: {
    // The injected client module is an untyped seam, so foreign errors are
    // normalized at this boundary.
    createComment: async (issueId, body): Promise<Result<undefined, TrackerError>> => {
      return normalizeWriteResult(await clientModule().createTaskComment(issueId, body));
    },
  },

  stateUpdates: {
    updateIssueState: async (issueId, stateName): Promise<Result<undefined, TrackerError>> => {
      return normalizeWriteResult(await clientModule().updateTaskState(issueId, stateName));
    },
  },

  agentTools: {
    listAgentTools: () => [larkApiToolSpec],
    executeAgentTool: (tool, args, opts) => {
      if (tool !== LARK_API_TOOL) {
        return Promise.resolve({
          success: false,
          payload: { error: { message: `Unsupported dynamic tool: ${JSON.stringify(tool)}.` } },
        });
      }
      return executeLarkApiWith((method, path, body) => request(method, path, body), args, opts);
    },
  },

  ui: {
    projectUrl: (settings) => tasklistUrl(larkTaskSettings(settings)),
    workItemNoun: "Lark task",
  },
};

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
