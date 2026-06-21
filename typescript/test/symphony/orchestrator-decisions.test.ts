import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { newIssue } from "../../src/symphony/linear/issue.ts";
import {
  type RunningTask,
  type State,
  handleRetryIssueLookupForTest,
  newState,
  reconcileBlockedIssueStatesForTest,
  reconcileIssueStatesForTest,
  revalidateIssueForDispatchForTest,
  selectWorkerHostForTest,
  shouldDispatchIssueForTest,
  sortIssuesForDispatchForTest,
} from "../../src/symphony/orchestrator.ts";
import { ok } from "../../src/symphony/result.ts";
import { workflowFilePath } from "../../src/symphony/workflow.ts";
import { setupWorkflow, teardownWorkflow, writeWorkflowFile } from "../support/test-support.ts";

function stoppableTask(): RunningTask & { stopped: boolean } {
  const task = {
    stopped: false,
    stop() {
      task.stopped = true;
    },
  };
  return task;
}

// Translated from the orchestrator decision/reconcile seam cases in
// core_test.exs and workspace_and_config_test.exs.
describe("Orchestrator decisions/reconcile seams", () => {
  let root: string;

  beforeEach(() => {
    ({ root } = setupWorkflow());
  });

  afterEach(() => {
    teardownWorkflow(root);
  });

  test("sorts dispatch by priority then oldest created_at", () => {
    const issues = [
      newIssue({
        id: "issue-old-low",
        identifier: "MT-199",
        title: "x",
        state: "Todo",
        priority: 2,
        createdAt: new Date("2025-12-01T00:00:00Z"),
      }),
      newIssue({
        id: "issue-new-high",
        identifier: "MT-201",
        title: "x",
        state: "Todo",
        priority: 1,
        createdAt: new Date("2026-01-02T00:00:00Z"),
      }),
      newIssue({
        id: "issue-old-high",
        identifier: "MT-200",
        title: "x",
        state: "Todo",
        priority: 1,
        createdAt: new Date("2026-01-01T00:00:00Z"),
      }),
    ];
    expect(sortIssuesForDispatchForTest(issues).map((i) => i.identifier)).toEqual([
      "MT-200",
      "MT-201",
      "MT-199",
    ]);
  });

  test("todo issue with a non-terminal blocker is not dispatch-eligible", () => {
    const state = newState({ max_concurrent_agents: 3 });
    const issue = newIssue({
      id: "blocked-1",
      identifier: "MT-1001",
      title: "Blocked work",
      state: "Todo",
      blockedBy: [{ id: "blocker-1", identifier: "MT-1002", state: "In Progress" }],
    });
    expect(shouldDispatchIssueForTest(issue, state)).toBe(false);
  });

  test("issue assigned to another worker is not dispatch-eligible", () => {
    writeWorkflowFile(workflowFilePath(), { tracker_assignee: "dev@example.com" });
    const state = newState({ max_concurrent_agents: 3 });
    const issue = newIssue({
      id: "assigned-away-1",
      identifier: "MT-1007",
      title: "Owned elsewhere",
      state: "Todo",
      assignedToWorker: false,
    });
    expect(shouldDispatchIssueForTest(issue, state)).toBe(false);
  });

  test("issue without every required label is not dispatch-eligible", () => {
    writeWorkflowFile(workflowFilePath(), { tracker_required_labels: ["symphony", "javascript"] });
    const state = newState({ max_concurrent_agents: 3 });
    const issue = newIssue({
      id: "unlabeled-1",
      identifier: "MT-1008",
      title: "Not opted in",
      state: "Todo",
      labels: ["symphony"],
    });
    expect(shouldDispatchIssueForTest(issue, state)).toBe(false);
    expect(
      shouldDispatchIssueForTest({ ...issue, labels: ["Symphony", "JavaScript"] }, state),
    ).toBe(true);
  });

  test("todo issue with terminal blockers remains dispatch-eligible", () => {
    const state = newState({ max_concurrent_agents: 3 });
    const issue = newIssue({
      id: "ready-1",
      identifier: "MT-1003",
      title: "Ready work",
      state: "Todo",
      blockedBy: [{ id: "blocker-2", identifier: "MT-1004", state: "Closed" }],
    });
    expect(shouldDispatchIssueForTest(issue, state)).toBe(true);
  });

  test("revalidation skips a stale todo issue once a non-terminal blocker appears", async () => {
    const stale = newIssue({
      id: "blocked-2",
      identifier: "MT-1005",
      title: "x",
      state: "Todo",
      blockedBy: [],
    });
    const refreshed = newIssue({
      id: "blocked-2",
      identifier: "MT-1005",
      title: "x",
      state: "Todo",
      blockedBy: [{ id: "blocker-3", identifier: "MT-1006", state: "In Progress" }],
    });
    const outcome = await revalidateIssueForDispatchForTest(stale, () => ok([refreshed]));
    expect(outcome.kind).toBe("skip");
    if (outcome.kind === "skip" && outcome.issue !== "missing") {
      expect(outcome.issue.identifier).toBe("MT-1005");
      expect(outcome.issue.blockedBy).toEqual([
        { id: "blocker-3", identifier: "MT-1006", state: "In Progress" },
      ]);
    }
  });

  test("revalidation skips an issue after a required label is removed", async () => {
    writeWorkflowFile(workflowFilePath(), { tracker_required_labels: ["symphony"] });
    const stale = newIssue({
      id: "unlabeled-2",
      identifier: "MT-1009",
      title: "x",
      state: "Todo",
      labels: ["symphony"],
    });
    const refreshed = { ...stale, labels: [] };
    const outcome = await revalidateIssueForDispatchForTest(stale, () => ok([refreshed]));
    expect(outcome.kind).toBe("skip");
    if (outcome.kind === "skip") {
      expect(outcome.issue).toEqual(refreshed);
    }
  });

  test("reconcile stops a non-active running issue without cleaning the workspace", () => {
    const issueId = "issue-1";
    const task = stoppableTask();
    const workspaceRoot = path.join(root, "ws");
    const workspace = path.join(workspaceRoot, "MT-555");
    fs.mkdirSync(workspace, { recursive: true });
    writeWorkflowFile(workflowFilePath(), { workspace_root: workspaceRoot });

    const state: State = newState({
      running: {
        [issueId]: {
          task,
          ref: null,
          identifier: "MT-555",
          issue: newIssue({ id: issueId, state: "Todo", identifier: "MT-555" }),
          started_at: new Date(),
        },
      },
      claimed: new Set([issueId]),
    });
    const issue = newIssue({
      id: issueId,
      identifier: "MT-555",
      state: "Backlog",
      title: "Queued",
      labels: [],
    });

    const updated = reconcileIssueStatesForTest([issue], state);
    expect(issueId in updated.running).toBe(false);
    expect(updated.claimed.has(issueId)).toBe(false);
    expect(task.stopped).toBe(true);
    expect(fs.existsSync(workspace)).toBe(true);
  });

  test("terminal issue state stops the agent and cleans the workspace", () => {
    const issueId = "issue-2";
    const task = stoppableTask();
    const workspaceRoot = path.join(root, "ws");
    const workspace = path.join(workspaceRoot, "MT-556");
    fs.mkdirSync(workspace, { recursive: true });
    writeWorkflowFile(workflowFilePath(), {
      workspace_root: workspaceRoot,
      tracker_active_states: ["Todo", "In Progress", "In Review"],
      tracker_terminal_states: ["Closed", "Cancelled", "Canceled", "Duplicate"],
    });

    const state: State = newState({
      running: {
        [issueId]: {
          task,
          ref: null,
          identifier: "MT-556",
          issue: newIssue({ id: issueId, state: "In Progress", identifier: "MT-556" }),
          started_at: new Date(),
        },
      },
      claimed: new Set([issueId]),
    });
    const issue = newIssue({
      id: issueId,
      identifier: "MT-556",
      state: "Closed",
      title: "Done",
      labels: [],
    });

    const updated = reconcileIssueStatesForTest([issue], state);
    expect(issueId in updated.running).toBe(false);
    expect(updated.claimed.has(issueId)).toBe(false);
    expect(task.stopped).toBe(true);
    expect(fs.existsSync(workspace)).toBe(false);
  });

  test("reconcile refreshes running issue state for active issues", () => {
    const issueId = "issue-3";
    const task = stoppableTask();
    const state: State = newState({
      running: {
        [issueId]: {
          task,
          ref: null,
          identifier: "MT-557",
          issue: newIssue({ id: issueId, identifier: "MT-557", state: "Todo" }),
          started_at: new Date(),
        },
      },
      claimed: new Set([issueId]),
    });
    const issue = newIssue({
      id: issueId,
      identifier: "MT-557",
      state: "In Progress",
      title: "Active",
      labels: [],
    });

    const updated = reconcileIssueStatesForTest([issue], state);
    expect(issueId in updated.running).toBe(true);
    expect(updated.claimed.has(issueId)).toBe(true);
    expect(updated.running[issueId]?.issue.state).toBe("In Progress");
    expect(task.stopped).toBe(false);
  });

  test("reconcile stops a running issue reassigned away from this worker", () => {
    const issueId = "issue-reassigned";
    const task = stoppableTask();
    const state: State = newState({
      running: {
        [issueId]: {
          task,
          ref: null,
          identifier: "MT-561",
          issue: newIssue({
            id: issueId,
            identifier: "MT-561",
            state: "In Progress",
            assignedToWorker: true,
          }),
          started_at: new Date(),
        },
      },
      claimed: new Set([issueId]),
    });
    const issue = newIssue({
      id: issueId,
      identifier: "MT-561",
      state: "In Progress",
      title: "Reassigned",
      labels: [],
      assignedToWorker: false,
    });

    const updated = reconcileIssueStatesForTest([issue], state);
    expect(issueId in updated.running).toBe(false);
    expect(updated.claimed.has(issueId)).toBe(false);
    expect(task.stopped).toBe(true);
  });

  test("reconcile releases a blocked issue when a required label is removed", () => {
    writeWorkflowFile(workflowFilePath(), { tracker_required_labels: ["symphony"] });
    const issueId = "blocked-unlabeled";
    const state: State = newState({
      blocked: {
        [issueId]: { identifier: "MT-564", error: "operator input required", worker_host: null },
      },
      claimed: new Set([issueId]),
    });
    const issue = newIssue({
      id: issueId,
      identifier: "MT-564",
      title: "Blocked but opted out",
      state: "In Progress",
      labels: [],
    });

    const updated = reconcileBlockedIssueStatesForTest([issue], state);
    expect(issueId in updated.blocked).toBe(false);
    expect(updated.claimed.has(issueId)).toBe(false);
  });

  test("retry lookup releases the claim when a required label is removed", () => {
    writeWorkflowFile(workflowFilePath(), { tracker_required_labels: ["symphony"] });
    const issueId = "retry-unlabeled";
    const state: State = newState({ claimed: new Set([issueId]) });
    const issue = newIssue({
      id: issueId,
      identifier: "MT-565",
      title: "Retry opted out",
      state: "In Progress",
      labels: [],
    });

    const updated = handleRetryIssueLookupForTest(issue, state, issueId, 1, {
      identifier: issue.identifier,
      error: "agent exited",
    });
    expect(updated.claimed.has(issueId)).toBe(false);
    expect(issueId in updated.retry_attempts).toBe(false);
  });

  describe("select_worker_host_for_test", () => {
    test("skips full ssh hosts under the shared per-host cap", () => {
      writeWorkflowFile(workflowFilePath(), {
        worker_ssh_hosts: ["worker-a", "worker-b"],
        worker_max_concurrent_agents_per_host: 1,
      });
      const state = newState({
        running: { "issue-1": { issue: newIssue({}), worker_host: "worker-a" } },
      });
      expect(selectWorkerHostForTest(state, null)).toBe("worker-b");
    });

    test("returns no_worker_capacity when every ssh host is full", () => {
      writeWorkflowFile(workflowFilePath(), {
        worker_ssh_hosts: ["worker-a", "worker-b"],
        worker_max_concurrent_agents_per_host: 1,
      });
      const state = newState({
        running: {
          "issue-1": { issue: newIssue({}), worker_host: "worker-a" },
          "issue-2": { issue: newIssue({}), worker_host: "worker-b" },
        },
      });
      expect(selectWorkerHostForTest(state, null)).toBe("no_worker_capacity");
    });

    test("keeps the preferred ssh host when it still has capacity", () => {
      writeWorkflowFile(workflowFilePath(), {
        worker_ssh_hosts: ["worker-a", "worker-b"],
        worker_max_concurrent_agents_per_host: 2,
      });
      const state = newState({
        running: {
          "issue-1": { issue: newIssue({}), worker_host: "worker-a" },
          "issue-2": { issue: newIssue({}), worker_host: "worker-b" },
        },
      });
      expect(selectWorkerHostForTest(state, "worker-a")).toBe("worker-a");
    });
  });
});
