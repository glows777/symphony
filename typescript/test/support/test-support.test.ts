import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { fetchEnv } from "../../src/symphony/app-env.ts";
import { setupWorkflow, teardownWorkflow } from "./test-support.ts";

describe("test workflow support", () => {
  test("sets an isolated agent output root under the workflow temp root", () => {
    let root = "";
    let agentOutputRoot = "";

    try {
      ({ root, agentOutputRoot } = setupWorkflow());
      expect(fetchEnv<string>("agent_output_root")).toBe(agentOutputRoot);
      expect(path.dirname(agentOutputRoot)).toBe(root);
      writeFakeAgentLog(agentOutputRoot);
    } finally {
      if (root !== "") {
        teardownWorkflow(root);
      }
    }

    expect(fetchEnv<string>("agent_output_root")).toBeUndefined();
    expect(fs.existsSync(agentOutputRoot)).toBe(false);
    expect(fs.existsSync(root)).toBe(false);
  });

  test("teardown removes isolated agent output after an interrupted test body", () => {
    let root = "";
    let agentOutputRoot = "";

    const interruptedBody = (): void => {
      ({ root, agentOutputRoot } = setupWorkflow());
      writeFakeAgentLog(agentOutputRoot);
      throw new Error("simulated failure");
    };

    try {
      expect(interruptedBody).toThrow("simulated failure");
    } finally {
      if (root !== "") {
        teardownWorkflow(root);
      }
    }

    expect(fetchEnv<string>("agent_output_root")).toBeUndefined();
    expect(fs.existsSync(agentOutputRoot)).toBe(false);
    expect(fs.existsSync(root)).toBe(false);
  });
});

function writeFakeAgentLog(agentOutputRoot: string): void {
  const logPath = path.join(agentOutputRoot, "log", "agents", "MT-CLEAN", "run.jsonl");
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  fs.writeFileSync(logPath, "{}\n");
}
