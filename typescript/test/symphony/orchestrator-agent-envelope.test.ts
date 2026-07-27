import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  Orchestrator,
  type RunningEntry,
  type RunningTask,
  type Snapshot,
} from "../../src/symphony/orchestrator.ts";
import { newIssue } from "../../src/symphony/plugins/work-item.ts";
import { setupWorkflow, teardownWorkflow } from "../support/test-support.ts";

// P3: the orchestrator consumes the normalized agent-backend envelope. It reads
// the neutral `backendPid` alias and a flat cumulative `usage` map first, while
// keeping the codex-specific payload sniffing (pid nesting, deep token paths,
// rate-limit shapes) as a fallback. The `codex_*` snapshot/state keys stay
// frozen.

function stoppableTask(): RunningTask & { stopped: boolean } {
  const task = {
    stopped: false,
    stop() {
      task.stopped = true;
    },
  };
  return task;
}

describe("Orchestrator agent envelope consumption", () => {
  let root: string;
  let orchestrators: Orchestrator[];

  beforeEach(() => {
    ({ root } = setupWorkflow());
    orchestrators = [];
  });

  afterEach(() => {
    for (const orch of orchestrators) {
      orch.stop();
    }
    teardownWorkflow(root);
  });

  function makeOrchestrator(): Orchestrator {
    const orch = new Orchestrator();
    orchestrators.push(orch);
    return orch;
  }

  async function snap(orch: Orchestrator): Promise<Snapshot> {
    const result = await orch.snapshot(1_000);
    if (typeof result === "string") {
      throw new Error(`snapshot returned ${result}`);
    }
    return result;
  }

  function runningEntry(overrides: Partial<RunningEntry>): RunningEntry {
    return {
      task: stoppableTask(),
      ref: Symbol("ref"),
      identifier: "MT-0",
      issue: newIssue({}),
      session_id: null,
      turn_count: 0,
      last_codex_message: null,
      last_codex_timestamp: null,
      last_codex_event: null,
      codex_input_tokens: 0,
      codex_output_tokens: 0,
      codex_total_tokens: 0,
      codex_last_reported_input_tokens: 0,
      codex_last_reported_output_tokens: 0,
      codex_last_reported_total_tokens: 0,
      started_at: new Date(),
      ...overrides,
    };
  }

  function injectRunning(orch: Orchestrator, issueId: string, entry: RunningEntry): void {
    orch.replaceState((state) => ({
      ...state,
      running: { [issueId]: entry },
      claimed: new Set(state.claimed).add(issueId),
    }));
  }

  test("adopts the neutral backendPid alias for the frozen codex_app_server_pid key", async () => {
    const orch = makeOrchestrator();
    const issueId = "issue-backend-pid";
    const issue = newIssue({ id: issueId, identifier: "MT-301", state: "In Progress" });
    injectRunning(orch, issueId, runningEntry({ identifier: issue.identifier, issue }));

    await orch.cast({
      tag: "codex_worker_update",
      issueId,
      update: { event: "session_started", backendPid: "9999", timestamp: new Date() },
    });

    const snapshot = await snap(orch);
    expect(snapshot.running[0]?.codex_app_server_pid).toBe("9999");
  });

  test("adopts a flat cumulative usage map from the envelope", async () => {
    const orch = makeOrchestrator();
    const issueId = "issue-flat-usage";
    const issue = newIssue({ id: issueId, identifier: "MT-302", state: "In Progress" });
    injectRunning(orch, issueId, runningEntry({ identifier: issue.identifier, issue }));

    await orch.cast({
      tag: "codex_worker_update",
      issueId,
      update: {
        event: "turn_completed",
        usage: { input_tokens: 200, output_tokens: 100, total_tokens: 300 },
        timestamp: new Date(),
      },
    });

    const snapshot = await snap(orch);
    const entry = snapshot.running[0];
    expect(entry?.codex_input_tokens).toBe(200);
    expect(entry?.codex_output_tokens).toBe(100);
    expect(entry?.codex_total_tokens).toBe(300);
  });

  test("adopts rate limits carried directly on the envelope", async () => {
    const orch = makeOrchestrator();
    const issueId = "issue-envelope-rate-limits";
    const issue = newIssue({ id: issueId, identifier: "MT-303", state: "In Progress" });
    injectRunning(orch, issueId, runningEntry({ identifier: issue.identifier, issue }));

    const rateLimits = {
      limit_id: "gpt-5",
      primary: { remaining: 90, limit: 100 },
      secondary: null,
      credits: { has_credits: true },
    };
    await orch.cast({
      tag: "codex_worker_update",
      issueId,
      update: { event: "notification", rate_limits: rateLimits, timestamp: new Date() },
    });

    const snapshot = await snap(orch);
    expect(snapshot.rate_limits).toEqual(rateLimits);
  });

  test("still sniffs rate limits from the codex payload when the envelope omits them", async () => {
    const orch = makeOrchestrator();
    const issueId = "issue-sniff-rate-limits";
    const issue = newIssue({ id: issueId, identifier: "MT-304", state: "In Progress" });
    injectRunning(orch, issueId, runningEntry({ identifier: issue.identifier, issue }));

    const rateLimits = {
      limit_id: "gpt-5",
      primary: { remaining: 12, limit: 100 },
      secondary: null,
      credits: { has_credits: false },
    };
    await orch.cast({
      tag: "codex_worker_update",
      issueId,
      update: {
        event: "notification",
        payload: {
          method: "codex/event/token_count",
          params: {
            msg: { type: "event_msg", payload: { type: "token_count", rate_limits: rateLimits } },
          },
        },
        timestamp: new Date(),
      },
    });

    const snapshot = await snap(orch);
    expect(snapshot.rate_limits).toEqual(rateLimits);
  });
});
