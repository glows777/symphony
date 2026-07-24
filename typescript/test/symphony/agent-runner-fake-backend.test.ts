import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { type IssueStateFetcher, type WorkerUpdate, run } from "../../src/symphony/agent-runner.ts";
import { putEnv } from "../../src/symphony/app-env.ts";
import type {
  AgentBackendPlugin,
  AgentSession,
  OnAgentMessage,
  ToolProvider,
} from "../../src/symphony/plugins/agents/types.ts";
import { type Issue, newIssue } from "../../src/symphony/plugins/work-item.ts";
import { ok } from "../../src/symphony/result.ts";
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
};

function fakeBackend(caps: { multiTurn?: boolean; remote?: boolean }): {
  plugin: AgentBackendPlugin;
  turns: TurnRecord[];
  sessionCount: () => number;
} {
  const turns: TurnRecord[] = [];
  let sessions = 0;
  let cumulativeTokens = 0;

  const plugin: AgentBackendPlugin = {
    id: "codex",
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
        };
        const session: AgentSession = {
          backendId: "codex",
          workspace,
          workerHost: opts.workerHost ?? null,
          handle,
        };
        return Promise.resolve(ok(session));
      },
      runTurn: (session, prompt, context) => {
        const handle = session.handle as FakeHandle;
        turns.push({
          prompt,
          turnNumber: context.turnNumber,
          maxTurns: context.maxTurns,
          sessionSeq: handle.seq,
          workerHost: session.workerHost,
          hasToolProvider: handle.toolProvider !== null,
        });
        // Contract: usage MUST be the cumulative absolute total for the session.
        cumulativeTokens += 25;
        handle.onMessage?.({
          event: "session_started",
          timestamp: new Date(),
          sessionId: `sess-${context.turnNumber}`,
        });
        handle.onMessage?.({
          event: "turn_completed",
          timestamp: new Date(),
          usage: {
            input_tokens: cumulativeTokens,
            output_tokens: 0,
            total_tokens: cumulativeTokens,
          },
        });
        return Promise.resolve(ok({ sessionId: `sess-${context.turnNumber}` }));
      },
      stopSession: () => {},
    },
  };

  return { plugin, turns, sessionCount: () => sessions };
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
});
