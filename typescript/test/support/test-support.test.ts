import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import {
  type AgentOutputRunMetadata,
  getAgentOutputStore,
} from "../../src/symphony/agent-output-store.ts";
import { fetchEnv } from "../../src/symphony/app-env.ts";
import type { AgentMessage } from "../../src/symphony/plugins/agents/types.ts";
import { setupWorkflow, teardownWorkflow } from "./test-support.ts";

describe("test workflow support", () => {
  test("sets an isolated agent output root and removes persisted output on teardown", async () => {
    let root = "";
    let agentOutputRoot = "";
    let metadata: AgentOutputRunMetadata | null = null;

    try {
      ({ root, agentOutputRoot } = setupWorkflow());

      expect(fetchEnv<string>("agent_output_root")).toBe(agentOutputRoot);
      expect(path.dirname(agentOutputRoot)).toBe(root);

      const run = getAgentOutputStore().startRun({
        issueId: "issue-clean",
        issueIdentifier: "MT-CLEAN",
        backend: "codex",
        workerHost: null,
        runId: "clean-run",
      });
      run.record(message(), 1, "Started");
      await run.finish("completed");
      metadata = run.metadata();

      expect(
        metadata.path.startsWith(`${path.join(agentOutputRoot, "log", "agents")}${path.sep}`),
      ).toBe(true);
      expect(fs.existsSync(metadata.path)).toBe(true);
    } finally {
      if (root !== "") {
        teardownWorkflow(root);
      }
    }

    expect(fetchEnv<string>("agent_output_root")).toBeUndefined();
    expect(fs.existsSync(agentOutputRoot)).toBe(false);
    expect(fs.existsSync(root)).toBe(false);
    expect(metadata === null || fs.existsSync(metadata.path)).toBe(false);
  });

  test("teardown cancels unflushed AgentOutputRun writes before removing the temp root", async () => {
    let root = "";
    let agentOutputRoot = "";
    let metadata: AgentOutputRunMetadata | null = null;

    try {
      ({ root, agentOutputRoot } = setupWorkflow());

      const run = getAgentOutputStore().startRun({
        issueId: "issue-pending",
        issueIdentifier: "MT-PENDING",
        backend: "codex",
        workerHost: null,
        runId: "pending-run",
      });
      run.record(message(), 1, "Queued but unfinished");
      metadata = run.metadata();

      expect(fs.existsSync(metadata.path)).toBe(false);
    } finally {
      if (root !== "") {
        teardownWorkflow(root);
      }
    }

    await Bun.sleep(30);

    expect(fetchEnv<string>("agent_output_root")).toBeUndefined();
    expect(fs.existsSync(agentOutputRoot)).toBe(false);
    expect(fs.existsSync(root)).toBe(false);
    expect(metadata === null || fs.existsSync(metadata.path)).toBe(false);
  });
});

function message(): AgentMessage {
  return {
    event: "notification",
    timestamp: new Date("2026-07-30T00:00:00.000Z"),
    stream: "stdout",
    payload: { message: "testing output cleanup" },
    raw: '{"message":"testing output cleanup"}',
  };
}
