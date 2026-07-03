import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  type IssueStateFetcher,
  type WorkerUpdate,
  continueWithIssueForTest,
  run,
} from "../../src/symphony/agent-runner.ts";
import { newIssue } from "../../src/symphony/linear/issue.ts";
import { ok } from "../../src/symphony/result.ts";
import { workflowFilePath } from "../../src/symphony/workflow.ts";
import { setupWorkflow, teardownWorkflow, writeWorkflowFile } from "../support/test-support.ts";

// Translated from the agent-runner cases in core_test.exs.
describe("AgentRunner", () => {
  let workflowRoot: string;
  let testRoot: string;

  beforeEach(() => {
    ({ root: workflowRoot } = setupWorkflow());
    testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "symphony-agent-"));
  });

  afterEach(() => {
    teardownWorkflow(workflowRoot);
    fs.rmSync(testRoot, { recursive: true, force: true });
  });

  test("does not continue after a required label is removed", async () => {
    writeWorkflowFile(workflowFilePath(), { tracker_required_labels: ["symphony"] });

    const issue = newIssue({
      id: "issue-label-continuation",
      identifier: "MT-563",
      title: "Stop after opt-out",
      state: "In Progress",
      labels: ["symphony"],
    });
    const refreshed = { ...issue, labels: [] };
    const fetcher: IssueStateFetcher = (ids) => {
      expect(ids).toEqual(["issue-label-continuation"]);
      return ok([refreshed]);
    };

    const outcome = await continueWithIssueForTest(issue, fetcher);
    expect(outcome.kind).toBe("done");
    if (outcome.kind === "done") {
      expect(outcome.issue).toEqual(refreshed);
    }
  });

  test("forwards timestamped codex updates to the recipient", async () => {
    const templateRepo = path.join(testRoot, "source");
    const workspaceRoot = path.join(testRoot, "workspaces");
    const codexBinary = path.join(testRoot, "fake-codex");
    fs.mkdirSync(templateRepo, { recursive: true });
    fs.writeFileSync(path.join(templateRepo, "README.md"), "# test");

    fs.writeFileSync(
      codexBinary,
      `#!/bin/sh
count=0
while IFS= read -r line; do
  count=$((count + 1))
  case "$count" in
    1) printf '%s\\n' '{"id":1,"result":{}}' ;;
    2) printf '%s\\n' '{"id":2,"result":{"thread":{"id":"thread-live"}}}' ;;
    3) printf '%s\\n' '{"id":3,"result":{"turn":{"id":"turn-live"}}}' ;;
    4) printf '%s\\n' '{"method":"turn/completed"}' ;;
    *) ;;
  esac
done
`,
    );
    fs.chmodSync(codexBinary, 0o755);

    writeWorkflowFile(workflowFilePath(), {
      workspace_root: workspaceRoot,
      hook_after_create: `cp ${path.join(templateRepo, "README.md")} README.md`,
      codex_command: `${codexBinary} app-server`,
    });

    const issue = newIssue({
      id: "issue-live-updates",
      identifier: "MT-99",
      title: "Smoke test",
      description: "Capture codex updates",
      state: "In Progress",
      url: "https://example.org/issues/MT-99",
      labels: ["backend"],
    });

    const updates: WorkerUpdate[] = [];
    const recipient = (update: WorkerUpdate): void => {
      updates.push(update);
    };
    const fetcher: IssueStateFetcher = () => ok([{ ...issue, state: "Done" }]);

    await run(issue, recipient, { issueStateFetcher: fetcher });

    const runtimeInfo = updates.find((u) => u.tag === "worker_runtime_info");
    expect(runtimeInfo).toBeDefined();

    const sessionStarted = updates.find(
      (u) => u.tag === "codex_worker_update" && u.message.event === "session_started",
    );
    expect(sessionStarted).toBeDefined();
    if (sessionStarted && sessionStarted.tag === "codex_worker_update") {
      expect(sessionStarted.issueId).toBe("issue-live-updates");
      expect(sessionStarted.message.timestamp).toBeInstanceOf(Date);
      expect(sessionStarted.message.sessionId).toBe("thread-live-turn-live");
    }
  });

  test("aborting the run signal tears down a hung codex turn", async () => {
    const workspaceRoot = path.join(testRoot, "workspaces");
    const codexBinary = path.join(testRoot, "fake-codex-hang");

    // Completes the handshake, then never emits turn/completed: without real
    // cancellation the run would only end at codex.turn_timeout_ms (1h default).
    fs.writeFileSync(
      codexBinary,
      `#!/bin/sh
count=0
while IFS= read -r line; do
  count=$((count + 1))
  case "$count" in
    1) printf '%s\\n' '{"id":1,"result":{}}' ;;
    2) printf '%s\\n' '{"id":2,"result":{"thread":{"id":"thread-hang"}}}' ;;
    3) printf '%s\\n' '{"id":3,"result":{"turn":{"id":"turn-hang"}}}' ;;
    *) ;;
  esac
done
`,
    );
    fs.chmodSync(codexBinary, 0o755);

    writeWorkflowFile(workflowFilePath(), {
      workspace_root: workspaceRoot,
      codex_command: `${codexBinary} app-server`,
    });

    const issue = newIssue({
      id: "issue-abort",
      identifier: "MT-ABORT",
      title: "Abort test",
      state: "In Progress",
    });

    const updates: WorkerUpdate[] = [];
    const recipient = (update: WorkerUpdate): void => {
      updates.push(update);
    };
    const fetcher: IssueStateFetcher = () => ok([issue]);
    const controller = new AbortController();

    const settled = run(issue, recipient, {
      issueStateFetcher: fetcher,
      signal: controller.signal,
    }).then(
      () => "resolved",
      () => "rejected",
    );

    const deadline = Date.now() + 2_000;
    while (
      !updates.some((u) => u.tag === "codex_worker_update" && u.message.event === "session_started")
    ) {
      if (Date.now() >= deadline) {
        throw new Error("timed out waiting for session_started");
      }
      await new Promise((r) => setTimeout(r, 10));
    }

    controller.abort();

    const outcome = await Promise.race([
      settled,
      new Promise<string>((r) => setTimeout(() => r("hung"), 3_000)),
    ]);
    // The killed codex port surfaces as a run failure; the orchestrator's
    // aborted flag suppresses it. What matters is that the run settles promptly
    // instead of holding the workspace until the turn timeout.
    expect(outcome).toBe("rejected");
  });
});
