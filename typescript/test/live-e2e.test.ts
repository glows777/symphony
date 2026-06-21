import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { type AppHandle, startApp, stopApp } from "../src/app.ts";
import { putEnv } from "../src/symphony/app-env.ts";
import { newIssue } from "../src/symphony/linear/issue.ts";
import { workflowFilePath } from "../src/symphony/workflow.ts";
import { setupWorkflow, teardownWorkflow, writeWorkflowFile } from "./support/test-support.ts";

// Phase 7 — in-process live e2e (the sandbox-runnable slice; see MIGRATION.md).
//
// Drives the real `startApp()` wiring (Orchestrator + AgentRunner + Codex
// AppServer + HttpServer) against the in-memory tracker and a fake-codex
// subprocess, with local dispatch (no SSH hosts). Asserts a candidate issue
// flows dispatch → completion and that the bound observability API reflects it.
// The full Docker/Linear/Codex e2e remains env-gated (SYMPHONY_RUN_LIVE_E2E=1).

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// A fake `codex app-server` that drives one successful turn: initialize (read
// 1), thread start (read 2), turn start + turn/completed (read 3).
const FAKE_CODEX = `#!/bin/sh
count=0
while IFS= read -r line; do
  count=$((count + 1))
  case "$count" in
    1)
      printf '%s\\n' '{"id":1,"result":{}}'
      ;;
    2)
      printf '%s\\n' '{"id":2,"result":{"thread":{"id":"thread-e2e"}}}'
      ;;
    3)
      printf '%s\\n' '{"id":3,"result":{"turn":{"id":"turn-e2e"}}}'
      printf '%s\\n' '{"method":"turn/completed"}'
      ;;
    *)
      exit 0
      ;;
  esac
done
`;

describe("live e2e (in-process)", () => {
  let workflowRoot: string;
  let testRoot: string;
  let handle: AppHandle | null;

  beforeEach(() => {
    ({ root: workflowRoot } = setupWorkflow());
    testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "symphony-e2e-"));
    handle = null;
  });

  afterEach(() => {
    if (handle) {
      stopApp(handle);
    }
    teardownWorkflow(workflowRoot);
    fs.rmSync(testRoot, { recursive: true, force: true });
  });

  test("dispatches a candidate issue through codex to completion and serves it over the API", async () => {
    const codexBinary = path.join(testRoot, "fake-codex");
    fs.writeFileSync(codexBinary, FAKE_CODEX);
    fs.chmodSync(codexBinary, 0o755);
    const workspaceRoot = path.join(testRoot, "workspaces");
    fs.mkdirSync(workspaceRoot, { recursive: true });

    const issue = newIssue({
      id: "issue-e2e",
      identifier: "MT-E2E",
      title: "End to end",
      description: "Run me",
      state: "In Progress",
      url: "https://example.org/issues/MT-E2E",
    });
    putEnv("memory_tracker_issues", [issue]);

    writeWorkflowFile(workflowFilePath(), {
      tracker_kind: "memory",
      workspace_root: workspaceRoot,
      worker_ssh_hosts: [],
      codex_command: `${codexBinary} app-server`,
      max_turns: 1,
      max_concurrent_agents: 1,
      poll_interval_ms: 50,
      codex_stall_timeout_ms: 0,
      server_port: 0,
    });

    const started = await startApp();
    expect(started.ok).toBe(true);
    if (!started.ok) {
      return;
    }
    handle = started.value;

    // Wait for the issue to flow all the way to completion.
    const deadline = Date.now() + 8_000;
    while (!handle.orchestrator.getState().completed.has("issue-e2e")) {
      if (Date.now() >= deadline) {
        throw new Error("timed out waiting for issue-e2e to complete");
      }
      await sleep(20);
    }
    expect(handle.orchestrator.getState().completed.has("issue-e2e")).toBe(true);

    // The agent created the issue's workspace under the configured root.
    expect(fs.existsSync(path.join(workspaceRoot, "MT-E2E"))).toBe(true);

    // The bound observability API answers with a well-formed snapshot.
    const port = handle.server.boundPort();
    expect(typeof port).toBe("number");
    const res = await fetch(`http://127.0.0.1:${port}/api/v1/state`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { counts: Record<string, number> };
    expect(body.counts).toBeDefined();
  }, 15_000);
});
