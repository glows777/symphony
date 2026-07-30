// Typed narrowing over the Gitea plugin's private config section
// (`settings.tracker.plugin`). The endpoint is the Gitea instance URL; an
// optional trailing `/api/v1` is accepted for convenience and removed before
// the client appends API paths.

import type { Settings } from "../../../config/schema.ts";

export type GiteaSettings = {
  endpoint: string | null;
  token: string | null;
  owner: string | null;
  repo: string | null;
  assignee: string | null;
  stateLabels: Record<string, string>;
};

export function giteaSettings(settings: Settings): GiteaSettings {
  const plugin = settings.tracker.plugin;
  return {
    endpoint: stringOrNull(plugin.endpoint),
    token: stringOrNull(plugin.token),
    owner: trimmedOrNull(plugin.owner),
    repo: trimmedOrNull(plugin.repo),
    assignee: trimmedOrNull(plugin.assignee),
    stateLabels: stateLabels(plugin.state_labels),
  };
}

// Returns the instance URL used for both browser links and API requests. The
// API base itself is always `${instance}/api/v1`, matching Gitea's OpenAPI
// paths and avoiding a hard-coded gitea.com host.
export function giteaInstanceUrl(endpoint: string): string | null {
  try {
    const parsed = new URL(endpoint.trim());
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return null;
    }
    if (parsed.username !== "" || parsed.password !== "" || parsed.search !== "") {
      return null;
    }
    let pathname = parsed.pathname.replace(/\/+$/, "");
    if (pathname.toLowerCase().endsWith("/api/v1")) {
      pathname = pathname.slice(0, -"/api/v1".length);
    }
    return `${parsed.origin}${pathname}`;
  } catch {
    return null;
  }
}

export function repositoryUrl(settings: GiteaSettings): string | null {
  if (settings.endpoint === null || settings.owner === null || settings.repo === null) {
    return null;
  }
  const instance = giteaInstanceUrl(settings.endpoint);
  if (instance === null) {
    return null;
  }
  return `${instance}/${encodeURIComponent(settings.owner)}/${encodeURIComponent(settings.repo)}`;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function trimmedOrNull(value: unknown): string | null {
  const string = stringOrNull(value);
  if (string === null) {
    return null;
  }
  const trimmed = string.trim();
  return trimmed === "" ? null : trimmed;
}

function stateLabels(value: unknown): Record<string, string> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return {};
  }
  const labels: Record<string, string> = {};
  for (const [stateName, labelName] of Object.entries(value)) {
    if (typeof labelName !== "string") {
      continue;
    }
    const state = stateName.trim();
    const label = labelName.trim();
    if (state !== "" && label !== "") {
      labels[state] = label;
    }
  }
  return labels;
}
