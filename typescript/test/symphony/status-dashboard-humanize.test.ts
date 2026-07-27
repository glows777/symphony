import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { putEnv } from "../../src/symphony/app-env.ts";
import type { AgentBackendPlugin } from "../../src/symphony/plugins/agents/types.ts";
import { err } from "../../src/symphony/result.ts";
import { humanizeCodexMessageExport } from "../../src/symphony/status-dashboard.ts";
import { setupWorkflow, teardownWorkflow } from "../support/test-support.ts";

// P3: the dashboard "last message" summary resolves through the active agent
// backend's ui.humanizeMessage capability, falling back to a generic one-liner
// when a backend omits the hook.

function backendWith(ui: AgentBackendPlugin["ui"]): AgentBackendPlugin {
  const plugin: AgentBackendPlugin = {
    id: "codex",
    displayName: "Synthetic backend",
    sessions: {
      startSession: () => Promise.resolve(err({ tag: "not_implemented" })),
      runTurn: () => Promise.resolve(err({ tag: "not_implemented" })),
      stopSession: () => {},
    },
  };
  if (ui !== undefined) {
    plugin.ui = ui;
  }
  return plugin;
}

describe("StatusDashboard agent humanize seam", () => {
  let root: string;

  beforeEach(() => {
    ({ root } = setupWorkflow());
  });

  afterEach(() => {
    teardownWorkflow(root);
  });

  test("uses the codex backend's humanize hook by default", () => {
    const message = {
      event: "notification",
      message: { method: "turn/started", params: { turn: { id: "turn-1" } } },
    };
    expect(humanizeCodexMessageExport(message)).toBe("turn started (turn-1)");
  });

  test("uses the active backend's humanize hook when overridden", () => {
    putEnv("agent_backend_overrides", {
      codex: backendWith({ humanizeMessage: () => "custom backend copy" }),
    });
    expect(humanizeCodexMessageExport({ event: "whatever" })).toBe("custom backend copy");
  });

  test("falls back to the generic summarizer when the hook returns null", () => {
    putEnv("agent_backend_overrides", {
      codex: backendWith({ humanizeMessage: () => null }),
    });
    expect(humanizeCodexMessageExport({ event: "session_started" })).toBe("session_started");
  });

  test("falls back to the generic summarizer when the backend omits the hook", () => {
    putEnv("agent_backend_overrides", { codex: backendWith(undefined) });
    expect(humanizeCodexMessageExport(null)).toBe("no agent message yet");
  });
});
