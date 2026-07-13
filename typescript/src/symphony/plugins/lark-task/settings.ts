// Typed narrowing over the lark-task plugin's private config section
// (`settings.tracker.plugin`), mirroring plugins/lark/settings.ts. The
// plugin's configSchema cast guarantees the shape, so consumers get full
// types without the core Settings depending on Lark-specific fields.
//
// Work items come from one task-center tasklist (one tasklist = one board):
// `tasklist_guid` selects it. State is modeled on tasklist sections (one
// section = one board column), so unlike the Bitable plugin there are no
// field-name mappings to configure — the state vocabulary is the tasklist's
// section names, and workflow authors set `active_states`/`terminal_states`
// to match them.

import type { Settings } from "../../config/schema.ts";

export const DEFAULT_LARK_TASK_ENDPOINT = "https://open.feishu.cn";

export type LarkTaskSettings = {
  endpoint: string;
  appId: string | null;
  appSecret: string | null;
  tasklistGuid: string | null;
  // Optional routing filter: a Lark open_id matched against the task's
  // assignee members. The app identity has no viewer concept, so (unlike
  // Linear) `"me"` is not supported.
  assignee: string | null;
};

export function larkTaskSettings(settings: Settings): LarkTaskSettings {
  const plugin = settings.tracker.plugin;
  return {
    endpoint: stringOr(plugin.endpoint, DEFAULT_LARK_TASK_ENDPOINT),
    appId: stringOrNull(plugin.app_id),
    appSecret: stringOrNull(plugin.app_secret),
    tasklistGuid: stringOrNull(plugin.tasklist_guid),
    assignee: stringOrNull(plugin.assignee),
  };
}

function stringOr(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}
