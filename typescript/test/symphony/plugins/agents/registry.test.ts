import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { putEnv } from "../../../../src/symphony/app-env.ts";
import { CodexPlugin } from "../../../../src/symphony/plugins/agents/codex/plugin.ts";
// Side-effect import mirrors production entry points: built-ins registered.
import "../../../../src/symphony/plugins/agents/index.ts";
import {
  agentBackend,
  agentBackendOrNull,
  registeredAgentBackendKinds,
} from "../../../../src/symphony/plugins/agents/registry.ts";
import type { AgentBackendPlugin } from "../../../../src/symphony/plugins/agents/types.ts";
import { err, ok } from "../../../../src/symphony/result.ts";
import { setupWorkflow, teardownWorkflow } from "../../../support/test-support.ts";

// A synthetic backend that never actually runs a session — enough to exercise
// registry resolution and the override seam.
const fakeBackend: AgentBackendPlugin = {
  id: "codex",
  displayName: "Synthetic backend",
  sessions: {
    startSession: () => Promise.resolve(err({ tag: "not_implemented" })),
    runTurn: () => Promise.resolve(err({ tag: "not_implemented" })),
    stopSession: () => {},
  },
};

describe("Plugins.Agents.Registry", () => {
  test("resolves the built-in codex backend by kind", () => {
    expect(agentBackend("codex")).toEqual(ok(CodexPlugin));
    expect(registeredAgentBackendKinds()).toEqual(["codex"]);
  });

  test("reports missing and unsupported kinds with stable tags", () => {
    const missing = agentBackend(null);
    expect(missing.ok).toBe(false);
    if (!missing.ok) {
      expect(missing.error.tag).toBe("missing_agent_backend");
      expect(missing.error.message).toBe("Agent backend missing in WORKFLOW.md");
    }

    const unsupported = agentBackend("claude_code");
    expect(unsupported.ok).toBe(false);
    if (!unsupported.ok) {
      expect(unsupported.error.tag).toBe("unsupported_agent_backend");
      expect(unsupported.error.message).toContain('"claude_code"');
      expect(unsupported.error.message).toContain("codex");
      expect(unsupported.error.detail).toEqual({ value: "claude_code" });
    }

    expect(agentBackendOrNull("claude_code")).toBeNull();
    expect(agentBackendOrNull(null)).toBeNull();
  });

  describe("override seam", () => {
    let root: string;

    beforeEach(() => {
      ({ root } = setupWorkflow());
    });

    afterEach(() => {
      teardownWorkflow(root);
    });

    test("agent_backend_overrides shadows a registered kind", () => {
      putEnv("agent_backend_overrides", { codex: fakeBackend });

      expect(agentBackendOrNull("codex")).toBe(fakeBackend);
      expect(agentBackend("codex")).toEqual(ok(fakeBackend));
    });

    test("registered backends resolve once the override is cleared", () => {
      putEnv("agent_backend_overrides", { codex: fakeBackend });
      expect(agentBackendOrNull("codex")).toBe(fakeBackend);
      teardownWorkflow(root);
      ({ root } = setupWorkflow());
      expect(agentBackendOrNull("codex")).toBe(CodexPlugin);
    });
  });
});
