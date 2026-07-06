// Typed narrowing over the Lark plugin's private config section
// (`settings.tracker.plugin`), mirroring plugins/linear/settings.ts. The
// plugin's configSchema cast guarantees the shape, so consumers get full types
// without the core Settings depending on Lark-specific fields.
//
// Work items come from one Bitable table (one table = one board): `app_token`
// + `table_id` select it, and the `field_*` keys name the columns that map
// onto the WorkItem model (defaults below, all overridable in WORKFLOW.md).

import type { Settings } from "../../config/schema.ts";

export const DEFAULT_LARK_ENDPOINT = "https://open.feishu.cn";

export const DEFAULT_LARK_STATE_FIELD = "Status";
export const DEFAULT_LARK_TITLE_FIELD = "Title";
export const DEFAULT_LARK_DESCRIPTION_FIELD = "Description";
export const DEFAULT_LARK_LABELS_FIELD = "Labels";
export const DEFAULT_LARK_ASSIGNEE_FIELD = "Assignee";

export type LarkSettings = {
  endpoint: string;
  appId: string | null;
  appSecret: string | null;
  appToken: string | null;
  tableId: string | null;
  // Optional routing filter: a Lark open_id. The app identity has no viewer
  // concept, so (unlike Linear) `"me"` is not supported.
  assignee: string | null;
  fieldState: string;
  fieldTitle: string;
  fieldDescription: string;
  fieldLabels: string;
  fieldAssignee: string;
  // null -> identifier falls back to the record_id.
  fieldIdentifier: string | null;
  // null -> priority is not mapped.
  fieldPriority: string | null;
};

export function larkSettings(settings: Settings): LarkSettings {
  const plugin = settings.tracker.plugin;
  return {
    endpoint: stringOr(plugin.endpoint, DEFAULT_LARK_ENDPOINT),
    appId: stringOrNull(plugin.app_id),
    appSecret: stringOrNull(plugin.app_secret),
    appToken: stringOrNull(plugin.app_token),
    tableId: stringOrNull(plugin.table_id),
    assignee: stringOrNull(plugin.assignee),
    fieldState: stringOr(plugin.field_state, DEFAULT_LARK_STATE_FIELD),
    fieldTitle: stringOr(plugin.field_title, DEFAULT_LARK_TITLE_FIELD),
    fieldDescription: stringOr(plugin.field_description, DEFAULT_LARK_DESCRIPTION_FIELD),
    fieldLabels: stringOr(plugin.field_labels, DEFAULT_LARK_LABELS_FIELD),
    fieldAssignee: stringOr(plugin.field_assignee, DEFAULT_LARK_ASSIGNEE_FIELD),
    fieldIdentifier: stringOrNull(plugin.field_identifier),
    fieldPriority: stringOrNull(plugin.field_priority),
  };
}

function stringOr(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}
