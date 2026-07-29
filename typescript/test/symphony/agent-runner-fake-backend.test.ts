import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AgentOutputStore } from "../../src/symphony/agent-output-store.ts";
import { type IssueStateFetcher, type WorkerUpdate, run } from "../../src/symphony/agent-runner.ts";
import { putEnv } from "../../src/symphony/app-env.ts";
import type {
  AgentBackendPlugin,
  AgentSession,
  OnAgentMessage,
  ToolProvider,
  TurnContext,
} from "../../src/symphony/plugins/agents/types.ts";
import { ok } from "../../src/symphony/result.ts";
import type { GitHubRequest, ReviewContext } from "../../src/symphony/review-context.ts";
import { type Issue, newIssue } from "../../src/symphony/work-item.ts";
import { workflowFilePath } from "../../src/symphony/workflow.ts";
import { setupWorkflow, teardownWorkflow, writeWorkflowFile } from "../support/test-support.ts";

// A synthetic backend injected through the `agent_backend_overrides` seam. It is
// the direct proof the AgentBackendPlugin contract can host a second backend:
// the runner drives it with no codex knowledge, and the contract's continuation
// / fresh-session / remote-worker / cumulative-usage semantics all hold.

type TurnRecord = {
  prompt: string;
  turnNumber: number;
  maxTurns: number;
  sessionSeq: number;
  workerHost: string | null;
  hasToolProvider: boolean;
};

type FakeHandle = {
  onMessage: OnAgentMessage | null;
  toolProvider: ToolProvider | null;
  seq: number;
  // Contract: usage is cumulative within ONE session — a fresh session's
  // counters restart at zero (this is what the runner's usage rebasing
  // compensates for; a global accumulator here would hide that seam).
  sessionTokens: number;
};

function fakeBackend(caps: {
  multiTurn?: boolean;
  remote?: boolean;
  backendId?: "codex" | "claude_code";
  // Blocks each turn until resolved, so a test can abort mid-turn.
  turnGate?: () => Promise<void>;
  onTurn?: (session: AgentSession, context: TurnContext) => void | Promise<void>;
}): {
  plugin: AgentBackendPlugin;
  turns: TurnRecord[];
  sessionCount: () => number;
  stopCount: () => number;
} {
  const turns: TurnRecord[] = [];
  let sessions = 0;
  let stops = 0;

  const plugin: AgentBackendPlugin = {
    id: caps.backendId ?? "codex",
    displayName: "Synthetic backend",
    capabilities: {
      multiTurnSessions: caps.multiTurn ?? false,
      remoteWorkers: caps.remote ?? true,
      rateLimitTelemetry: false,
    },
    sessions: {
      startSession: (workspace, opts = {}) => {
        sessions += 1;
        const handle: FakeHandle = {
          onMessage: opts.onMessage ?? null,
          toolProvider: opts.toolProvider ?? null,
          seq: sessions,
          sessionTokens: 0,
        };
        const session: AgentSession = {
          backendId: caps.backendId ?? "codex",
          workspace,
          workerHost: opts.workerHost ?? null,
          runId: `fake-run-${sessions}`,
          handle,
        };
        return Promise.resolve(ok(session));
      },
      runTurn: async (session, prompt, context) => {
        const handle = session.handle as FakeHandle;
        if (caps.turnGate !== undefined) {
          await caps.turnGate();
        }
        turns.push({
          prompt,
          turnNumber: context.turnNumber,
          maxTurns: context.maxTurns,
          sessionSeq: handle.seq,
          workerHost: session.workerHost,
          hasToolProvider: handle.toolProvider !== null,
        });
        await caps.onTurn?.(session, context);
        // Contract: usage MUST be the cumulative absolute total for the session.
        handle.sessionTokens += 25;
        handle.onMessage?.({
          event: "session_started",
          timestamp: new Date(),
          sessionId: `sess-${context.turnNumber}`,
        });
        handle.onMessage?.({
          event: "turn_completed",
          timestamp: new Date(),
          usage: {
            input_tokens: handle.sessionTokens,
            output_tokens: 0,
            total_tokens: handle.sessionTokens,
          },
        });
        return ok({ sessionId: `sess-${context.turnNumber}` });
      },
      stopSession: () => {
        stops += 1;
      },
    },
  };

  return { plugin, turns, sessionCount: () => sessions, stopCount: () => stops };
}

function emptyReviewContext(): ReviewContext {
  return {
    repository: "glows777/symphony",
    pullRequestNumber: 15,
    pullRequestUrl: "https://github.com/glows777/symphony/pull/15",
    headBranch: "symphony/MT-1",
    headSha: "a".repeat(40),
    snapshotId: crypto.createHash("sha256").update("[]").digest("hex"),
    fetchedAt: "2026-07-28T00:00:00Z",
    findings: [],
    submissions: [],
    replyReceipts: {},
  };
}

function emptyReviewRequest(context: ReviewContext): GitHubRequest {
  return async (url, init) => {
    if (init.method === "POST") {
      return ok({
        status: 200,
        body: {
          data: {
            repository: {
              pullRequest: {
                reviewThreads: {
                  nodes: [],
                  pageInfo: { hasNextPage: false, endCursor: null },
                },
              },
            },
          },
        },
      });
    }
    if (url.includes("/pulls?")) {
      return ok({
        status: 200,
        body: [
          {
            number: context.pullRequestNumber,
            html_url: context.pullRequestUrl,
            state: "open",
            head: { ref: context.headBranch, sha: context.headSha },
          },
        ],
      });
    }
    if (url.includes("/issues/15/comments") || url.includes("/pulls/15/reviews")) {
      return ok({ status: 200, body: [] });
    }
    return ok({ status: 404, body: { message: "unexpected test URL" } });
  };
}

function codexUpdates(
  updates: WorkerUpdate[],
): Extract<WorkerUpdate, { tag: "codex_worker_update" }>[] {
  return updates.filter(
    (u): u is Extract<WorkerUpdate, { tag: "codex_worker_update" }> =>
      u.tag === "codex_worker_update",
  );
}

describe("AgentRunner with a synthetic backend", () => {
  let workflowRoot: string;
  let testRoot: string;
  let workspaceRoot: string;
  let issue: Issue;
  // The issue never leaves an active, routable state, so the runner keeps
  // continuing until it reaches max_turns.
  const staysActive: IssueStateFetcher = () => ok([issue]);

  beforeEach(() => {
    ({ root: workflowRoot } = setupWorkflow());
    testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "symphony-fake-backend-"));
    workspaceRoot = path.join(testRoot, "workspaces");
    fs.mkdirSync(workspaceRoot, { recursive: true });
    writeWorkflowFile(workflowFilePath(), { workspace_root: workspaceRoot });
    issue = newIssue({ id: "issue-1", identifier: "MT-1", title: "Task", state: "In Progress" });
  });

  afterEach(() => {
    teardownWorkflow(workflowRoot);
    fs.rmSync(testRoot, { recursive: true, force: true });
  });

  test("multi-turn backend reuses one session and sends continuation guidance", async () => {
    const backend = fakeBackend({ multiTurn: true });
    putEnv("agent_backend_overrides", { codex: backend.plugin });

    await run(issue, null, { maxTurns: 3, issueStateFetcher: staysActive });

    expect(backend.turns.map((t) => t.turnNumber)).toEqual([1, 2, 3]);
    expect(backend.sessionCount()).toBe(1);
    expect(backend.turns.every((t) => t.sessionSeq === 1)).toBe(true);
    expect(backend.turns.every((t) => t.hasToolProvider)).toBe(true);

    expect(backend.turns[0]?.prompt).not.toContain("Continuation guidance");
    expect(backend.turns[1]?.prompt).toContain("Continuation guidance");
    expect(backend.turns[2]?.prompt).toContain("continuation turn #3 of 3");
  });

  test("review runs execute one turn and immediately apply the completion gate", async () => {
    const context = emptyReviewContext();
    const backend = fakeBackend({
      multiTurn: true,
      onTurn: (session) => {
        const handoffDir = path.join(session.workspace, ".symphony");
        fs.mkdirSync(handoffDir, { recursive: true });
        fs.writeFileSync(
          path.join(handoffDir, "review-handoff.json"),
          JSON.stringify({
            version: 2,
            baseline_head_sha: context.headSha,
            snapshot_id: context.snapshotId,
            findings: [],
          }),
        );
      },
    });
    putEnv("agent_backend_overrides", { codex: backend.plugin });
    const events: unknown[] = [];
    putEnv("memory_tracker_recipient", (event: unknown) => events.push(event));
    writeWorkflowFile(workflowFilePath(), {
      tracker_kind: "memory",
      workspace_root: workspaceRoot,
      review_repository: context.repository,
      review_github_token: "test-token",
    });
    issue = newIssue({
      ...issue,
      state: "In Progress",
      labels: ["symphony-review"],
    });

    await run(issue, null, {
      maxTurns: 5,
      issueStateFetcher: staysActive,
      reviewContext: context,
      reviewProviderOptions: { requestFun: emptyReviewRequest(context) },
    });

    expect(backend.turns.map((turn) => turn.turnNumber)).toEqual([1]);
    expect(backend.turns.map((turn) => turn.maxTurns)).toEqual([1]);
    expect(events).toEqual([
      {
        tag: "memory_tracker_state_update",
        issueId: "issue-1",
        stateName: "In Review",
      },
    ]);
  });

  test("an incomplete review handoff is a structured failure after one turn", async () => {
    const context = emptyReviewContext();
    const backend = fakeBackend({ multiTurn: true });
    putEnv("agent_backend_overrides", { codex: backend.plugin });
    writeWorkflowFile(workflowFilePath(), {
      tracker_kind: "memory",
      workspace_root: workspaceRoot,
      review_repository: context.repository,
      review_github_token: "test-token",
    });
    issue = newIssue({
      ...issue,
      state: "In Progress",
      labels: ["symphony-review"],
    });

    let thrown: unknown;
    try {
      await run(issue, null, {
        maxTurns: 5,
        issueStateFetcher: staysActive,
        reviewContext: context,
        reviewProviderOptions: { requestFun: emptyReviewRequest(context) },
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toEqual(expect.objectContaining({ tag: "review_incomplete" }));
    expect(backend.turns.map((turn) => turn.turnNumber)).toEqual([1]);
    expect(backend.turns.map((turn) => turn.maxTurns)).toEqual([1]);
  });

  test("uses the backend session run id for the JSONL file", async () => {
    const outputRoot = path.join(testRoot, "logs");
    const backend = fakeBackend({ multiTurn: true });
    putEnv("agent_backend_overrides", { codex: backend.plugin });
    putEnv("agent_output_root", outputRoot);
    writeWorkflowFile(workflowFilePath(), {
      workspace_root: workspaceRoot,
      observability_agent_output: "raw",
    });

    await run(issue, null, { maxTurns: 1, issueStateFetcher: staysActive });

    const logPath = path.join(outputRoot, "log", "agents", "MT-1", "fake-run-1.jsonl");
    expect(fs.existsSync(logPath)).toBe(true);
    const events = fs
      .readFileSync(logPath, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { run_id: string });
    expect(events.every((event) => event.run_id === "fake-run-1")).toBe(true);
  });

  test("single-turn backend starts a fresh session per turn with the full prompt", async () => {
    const backend = fakeBackend({ multiTurn: false });
    putEnv("agent_backend_overrides", { codex: backend.plugin });

    await run(issue, null, { maxTurns: 3, issueStateFetcher: staysActive });

    expect(backend.turns.map((t) => t.turnNumber)).toEqual([1, 2, 3]);
    expect(backend.sessionCount()).toBe(3);
    // A distinct session per turn, and never continuation guidance.
    expect(backend.turns.map((t) => t.sessionSeq)).toEqual([1, 2, 3]);
    expect(backend.turns.every((t) => !t.prompt.includes("Continuation guidance"))).toBe(true);
  });

  test("forwards the backend's cumulative usage totals through the envelope", async () => {
    const backend = fakeBackend({ multiTurn: true });
    putEnv("agent_backend_overrides", { codex: backend.plugin });

    const updates: WorkerUpdate[] = [];
    await run(issue, (u) => updates.push(u), { maxTurns: 3, issueStateFetcher: staysActive });

    const totals = codexUpdates(updates)
      .filter((u) => u.message.event === "turn_completed")
      .map((u) => (u.message.usage as { total_tokens?: unknown } | undefined)?.total_tokens);
    // Cumulative absolute totals, not repeated per-turn deltas (25/25/25).
    expect(totals).toEqual([25, 50, 75]);
  });

  test("rebases per-session usage to run-cumulative totals across fresh sessions", async () => {
    const backend = fakeBackend({ multiTurn: false });
    putEnv("agent_backend_overrides", { codex: backend.plugin });

    const updates: WorkerUpdate[] = [];
    await run(issue, (u) => updates.push(u), { maxTurns: 3, issueStateFetcher: staysActive });

    const usages = codexUpdates(updates)
      .filter((u) => u.message.event === "turn_completed")
      .map((u) => u.message.usage as { input_tokens?: unknown; total_tokens?: unknown });
    // Each fresh session reports its own session-cumulative 25; the runner
    // rebases so the orchestrator's monotonic last-reported baselines (which
    // swallow totals below the previous session's peak) still count every
    // session's tokens.
    expect(usages.map((u) => u.total_tokens)).toEqual([25, 50, 75]);
    expect(usages.map((u) => u.input_tokens)).toEqual([25, 50, 75]);
  });

  test("aborting the run signal tears the live session down mid-turn", async () => {
    // The orchestrator's RunningTask.stop() aborts this signal. Before the fix
    // it only suppressed the exit message, so the backend session (and its
    // subprocess) kept running until turn_timeout_ms and a retry could dispatch
    // a second agent into the same workspace.
    let releaseTurn: () => void = () => {};
    const turnStarted = Promise.withResolvers<void>();
    const gate = new Promise<void>((resolve) => {
      releaseTurn = resolve;
    });
    const backend = fakeBackend({
      multiTurn: true,
      turnGate: () => {
        turnStarted.resolve();
        return gate;
      },
    });
    putEnv("agent_backend_overrides", { codex: backend.plugin });

    const controller = new AbortController();
    const runPromise = run(issue, null, {
      maxTurns: 3,
      issueStateFetcher: staysActive,
      signal: controller.signal,
    });

    await turnStarted.promise;
    expect(backend.stopCount()).toBe(0);
    controller.abort();
    // The session is stopped as the signal fires, not deferred to the end.
    expect(backend.stopCount()).toBe(1);

    releaseTurn();
    await runPromise;
    // No further turns after the abort, and no double teardown beyond the
    // runner's own finally.
    expect(backend.turns).toHaveLength(1);
  });

  test("a run aborted before it starts never opens a session", async () => {
    const backend = fakeBackend({ multiTurn: true });
    putEnv("agent_backend_overrides", { codex: backend.plugin });

    const controller = new AbortController();
    controller.abort();

    await expect(
      run(issue, null, { maxTurns: 1, issueStateFetcher: staysActive, signal: controller.signal }),
    ).rejects.toThrow("aborted");
    expect(backend.sessionCount()).toBe(0);
  });

  test("a backend without remoteWorkers rejects a remote run", async () => {
    const backend = fakeBackend({ multiTurn: true, remote: false });
    putEnv("agent_backend_overrides", { codex: backend.plugin });

    await expect(
      run(issue, null, { workerHost: "ci-host", maxTurns: 1, issueStateFetcher: staysActive }),
    ).rejects.toThrow("remote_workers_unsupported");
    // Failed before starting any session.
    expect(backend.sessionCount()).toBe(0);
  });

  test("does not start a fresh session when the prompt fails to build", async () => {
    const backend = fakeBackend({ multiTurn: false });
    putEnv("agent_backend_overrides", { codex: backend.plugin });
    // strictVariables: an undefined template variable makes buildPrompt throw.
    writeWorkflowFile(workflowFilePath(), {
      workspace_root: workspaceRoot,
      prompt: "{{ undefined_var }}",
    });

    await expect(
      run(issue, null, { maxTurns: 1, issueStateFetcher: staysActive }),
    ).rejects.toThrow();
    // The prompt is built before startSession, so no session is opened (and
    // therefore none is leaked).
    expect(backend.sessionCount()).toBe(0);
  });

  test("persists fake Codex and Claude Code envelopes to separate JSONL runs", async () => {
    const logRoot = path.join(testRoot, "logs");
    putEnv("agent_output_root", logRoot);
    writeWorkflowFile(workflowFilePath(), {
      workspace_root: workspaceRoot,
      observability_agent_output: "raw",
    });

    for (const backendId of ["codex", "claude_code"] as const) {
      const backend = fakeBackend({ multiTurn: true, backendId });
      putEnv("agent_backend_overrides", { codex: backend.plugin });
      await run(issue, null, { maxTurns: 1, issueStateFetcher: staysActive });

      const store = new AgentOutputStore({ root: logRoot, mode: "raw" });
      const result = store.readIssueOutput("MT-1", { limit: 100 });
      expect(result.run?.backend).toBe(backendId);
      expect(result.events.map((event) => event.event)).toEqual(
        expect.arrayContaining([
          "run_started",
          "session_started",
          "turn_completed",
          "run_completed",
        ]),
      );
    }
  });
});
