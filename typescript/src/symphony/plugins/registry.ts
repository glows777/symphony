// Tracker plugin registry. Post-cutover TS-native design (see MIGRATION.md ->
// Post-cutover divergence).
//
// Built-in plugins are registered statically from `plugins/index.ts` (no
// dynamic loading: Bun single-file deploys, type-checking, and auditability
// all favor in-tree plugins). Tests may shadow a kind via the
// `tracker_plugin_overrides` app-env key, mirroring the existing
// `linear_client_module` injection style.

import { getEnv } from "../app-env.ts";
import { type Result, err, ok } from "../result.ts";
import { type TrackerError, type TrackerPlugin, trackerError } from "./types.ts";

const registry = new Map<string, TrackerPlugin>();

export function registerTrackerPlugin(plugin: TrackerPlugin): void {
  registry.set(plugin.id, plugin);
}

export function trackerPlugin(kind: string | null): Result<TrackerPlugin, TrackerError> {
  if (kind === null) {
    return err(
      trackerError("missing_tracker_kind", "missing_config", "Tracker kind missing in WORKFLOW.md"),
    );
  }
  const plugin = trackerPluginOrNull(kind);
  if (plugin === null) {
    return err(
      trackerError(
        "unsupported_tracker_kind",
        "missing_config",
        `unsupported tracker kind ${JSON.stringify(kind)} (registered: ${registeredTrackerKinds().join(", ")})`,
        { value: kind },
      ),
    );
  }
  return ok(plugin);
}

export function trackerPluginOrNull(kind: string | null): TrackerPlugin | null {
  if (kind === null) {
    return null;
  }
  const overrides = getEnv<Record<string, TrackerPlugin>>("tracker_plugin_overrides", {});
  return overrides[kind] ?? registry.get(kind) ?? null;
}

export function registeredTrackerKinds(): string[] {
  return [...registry.keys()];
}
