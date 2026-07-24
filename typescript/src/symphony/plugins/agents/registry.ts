// Agent backend plugin registry. Post-cutover TS-native design (see
// MIGRATION.md -> Post-cutover divergence).
//
// Line-for-line the tracker registry (plugins/registry.ts): built-in backends
// register statically from `plugins/agents/index.ts` (no dynamic loading), and
// tests shadow a kind via the `agent_backend_overrides` app-env key, mirroring
// the `tracker_plugin_overrides` injection style. Unlike the tracker registry
// the active backend is resolved once per agent run and pinned (sessions are
// stateful; swapping backends mid-run would tear a session apart).

import { getEnv } from "../../app-env.ts";
import { type Result, err, ok } from "../../result.ts";
import type { AgentBackendError, AgentBackendPlugin } from "./types.ts";

const registry = new Map<string, AgentBackendPlugin>();

export function registerAgentBackend(plugin: AgentBackendPlugin): void {
  registry.set(plugin.id, plugin);
}

export function agentBackend(kind: string | null): Result<AgentBackendPlugin, AgentBackendError> {
  if (kind === null) {
    return err({
      tag: "missing_agent_backend",
      message: "Agent backend missing in WORKFLOW.md",
    });
  }
  const plugin = agentBackendOrNull(kind);
  if (plugin === null) {
    return err({
      tag: "unsupported_agent_backend",
      message: `unsupported agent backend ${JSON.stringify(kind)} (registered: ${registeredAgentBackendKinds().join(", ")})`,
      detail: { value: kind },
    });
  }
  return ok(plugin);
}

export function agentBackendOrNull(kind: string | null): AgentBackendPlugin | null {
  if (kind === null) {
    return null;
  }
  const overrides = getEnv<Record<string, AgentBackendPlugin>>("agent_backend_overrides", {});
  return overrides[kind] ?? registry.get(kind) ?? null;
}

export function registeredAgentBackendKinds(): string[] {
  return [...registry.keys()];
}
