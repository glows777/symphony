// Typed narrowing over the Linear plugin's private config section
// (`settings.tracker.plugin`). The plugin's configSchema cast guarantees the
// shape, so consumers get full types without the core Settings depending on
// Linear-specific fields.

import type { Settings } from "../../config/schema.ts";

export const DEFAULT_LINEAR_ENDPOINT = "https://api.linear.app/graphql";

export type LinearSettings = {
  endpoint: string;
  apiKey: string | null;
  projectSlug: string | null;
  assignee: string | null;
};

export function linearSettings(settings: Settings): LinearSettings {
  const plugin = settings.tracker.plugin;
  return {
    endpoint: typeof plugin.endpoint === "string" ? plugin.endpoint : DEFAULT_LINEAR_ENDPOINT,
    apiKey: stringOrNull(plugin.api_key),
    projectSlug: stringOrNull(plugin.project_slug),
    assignee: stringOrNull(plugin.assignee),
  };
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}
