// Lark (Feishu) tracker plugin. Work items live in one Bitable table (one
// table = one board); reads delegate to the configured client module
// (overridable via the `lark_client_module` app-env, default Client). The
// `comments` capability is deliberately omitted: Bitable records have no
// public record-comment open API, and the tracker facade's structured
// `unsupported_operation` error is the honest degradation path.

import { getEnv } from "../../app-env.ts";
import type { JsonMap } from "../../config/schema.ts";
import { type Result, err, ok } from "../../result.ts";
import { castPluginString, envOrNull, resolveSecretSetting } from "../config-helpers.ts";
import {
  type PluginFieldError,
  type TrackerError,
  type TrackerPlugin,
  toTrackerError,
  trackerError,
} from "../types.ts";
import type { Issue } from "../work-item.ts";
import { Client, type LarkClientModule, tableUrl } from "./client.ts";
import {
  DEFAULT_LARK_ASSIGNEE_FIELD,
  DEFAULT_LARK_DESCRIPTION_FIELD,
  DEFAULT_LARK_ENDPOINT,
  DEFAULT_LARK_LABELS_FIELD,
  DEFAULT_LARK_STATE_FIELD,
  DEFAULT_LARK_TITLE_FIELD,
  larkSettings,
} from "./settings.ts";

function clientModule(): LarkClientModule {
  return getEnv<LarkClientModule>("lark_client_module", Client);
}

export const LarkPlugin: TrackerPlugin = {
  id: "lark",
  displayName: "Lark (Feishu)",

  configSchema: {
    cast(raw: JsonMap, section: string): { value: JsonMap; errors: PluginFieldError[] } {
      const errors: PluginFieldError[] = [];
      const value: JsonMap = {
        endpoint:
          castPluginString(raw, "endpoint", section, DEFAULT_LARK_ENDPOINT, errors) ??
          DEFAULT_LARK_ENDPOINT,
        app_id: castPluginString(raw, "app_id", section, null, errors),
        app_secret: castPluginString(raw, "app_secret", section, null, errors),
        app_token: castPluginString(raw, "app_token", section, null, errors),
        table_id: castPluginString(raw, "table_id", section, null, errors),
        assignee: castPluginString(raw, "assignee", section, null, errors),
        field_state:
          castPluginString(raw, "field_state", section, DEFAULT_LARK_STATE_FIELD, errors) ??
          DEFAULT_LARK_STATE_FIELD,
        field_title:
          castPluginString(raw, "field_title", section, DEFAULT_LARK_TITLE_FIELD, errors) ??
          DEFAULT_LARK_TITLE_FIELD,
        field_description:
          castPluginString(
            raw,
            "field_description",
            section,
            DEFAULT_LARK_DESCRIPTION_FIELD,
            errors,
          ) ?? DEFAULT_LARK_DESCRIPTION_FIELD,
        field_labels:
          castPluginString(raw, "field_labels", section, DEFAULT_LARK_LABELS_FIELD, errors) ??
          DEFAULT_LARK_LABELS_FIELD,
        field_assignee:
          castPluginString(raw, "field_assignee", section, DEFAULT_LARK_ASSIGNEE_FIELD, errors) ??
          DEFAULT_LARK_ASSIGNEE_FIELD,
        field_identifier: castPluginString(raw, "field_identifier", section, null, errors),
        field_priority: castPluginString(raw, "field_priority", section, null, errors),
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
      const lark = larkSettings(settings);
      if (lark.appId === null || lark.appSecret === null) {
        return err(
          trackerError(
            "missing_lark_app_credentials",
            "missing_credentials",
            "Lark app credentials (app_id/app_secret) missing in WORKFLOW.md",
          ),
        );
      }
      if (lark.appToken === null) {
        return err(
          trackerError(
            "missing_lark_app_token",
            "missing_config",
            "Lark Bitable app_token missing in WORKFLOW.md",
          ),
        );
      }
      if (lark.tableId === null) {
        return err(
          trackerError(
            "missing_lark_table_id",
            "missing_config",
            "Lark Bitable table_id missing in WORKFLOW.md",
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

  stateUpdates: {
    // The injected client module is an untyped seam, so foreign errors are
    // normalized at this boundary.
    updateIssueState: async (issueId, stateName): Promise<Result<undefined, TrackerError>> => {
      const response = await clientModule().updateRecordState(issueId, stateName);
      if (isOkResult(response)) {
        return ok(undefined);
      }
      if (isErrResult(response)) {
        return err(toTrackerError(response.error));
      }
      return err(toTrackerError(response));
    },
  },

  ui: {
    projectUrl: (settings) => tableUrl(larkSettings(settings)),
    workItemNoun: "Lark record",
  },
};

function isOkResult(value: unknown): value is { ok: true; value: unknown } {
  return typeof value === "object" && value !== null && (value as { ok?: unknown }).ok === true;
}

function isErrResult(value: unknown): value is { ok: false; error: unknown } {
  return typeof value === "object" && value !== null && (value as { ok?: unknown }).ok === false;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}
