import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { AgentOutputStore } from "../../../src/symphony/agent-output-store.ts";
import type { RequestRefreshReply, Snapshot } from "../../../src/symphony/orchestrator.ts";
import type { SnapshotProvider, SnapshotResult } from "../../../src/symphony/web/presenter.ts";
import { HttpServer, createRouter } from "../../../src/symphony/web/server.ts";
import { setupWorkflow, teardownWorkflow } from "../../support/test-support.ts";

// Translated from the Phoenix observability API + HttpServer cases in
// extensions_test.exs. Phoenix endpoint/router/Bandit → Bun.serve + router.

function staticSnapshot(): Snapshot {
  return {
    running: [
      {
        issue_id: "issue-http",
        identifier: "MT-HTTP",
        issue_url: "https://example.org/issues/MT-HTTP",
        state: "In Progress",
        worker_host: null,
        workspace_path: null,
        session_id: "thread-http",
        codex_app_server_pid: null,
        codex_input_tokens: 4,
        codex_output_tokens: 8,
        codex_total_tokens: 12,
        turn_count: 7,
        started_at: new Date(),
        last_codex_timestamp: null,
        last_codex_message: "rendered",
        last_codex_event: "notification",
        runtime_seconds: 0,
      },
    ],
    retrying: [
      {
        issue_id: "issue-retry",
        identifier: "MT-RETRY",
        issue_url: "https://example.org/issues/MT-RETRY",
        attempt: 2,
        due_in_ms: 2_000,
        error: "boom",
      },
    ],
    blocked: [
      {
        issue_id: "issue-blocked",
        identifier: "MT-BLOCKED",
        issue_url: "https://example.org/issues/MT-BLOCKED",
        state: "In Progress",
        error: "codex turn requires operator input",
        blocked_reason: "codex turn requires operator input",
        operator_prompt: "Allow GitHub to run tool update_pull_request?",
        raw_blocker_payload: {
          method: "mcpServer/elicitation/request",
          params: { message: "Allow GitHub to run tool update_pull_request?" },
        },
        manual_recovery: {
          action: "provide_required_input_or_approval_then_rerun",
          reason: "codex turn requires operator input",
          prompt: "Allow GitHub to run tool update_pull_request?",
          payload: {
            method: "mcpServer/elicitation/request",
            params: { message: "Allow GitHub to run tool update_pull_request?" },
          },
          session_id: "thread-blocked",
          automatic_retry: false,
          resume_supported: false,
          rerun_supported: true,
        },
        worker_host: "dm-dev2",
        workspace_path: "/workspaces/MT-BLOCKED",
        session_id: "thread-blocked",
        blocked_at: new Date(),
        last_codex_event: "turn_input_required",
        last_codex_message: {
          event: "turn_input_required",
          message: { method: "turn/input_required" },
        },
        last_codex_timestamp: new Date(),
      },
    ],
    codex_totals: { input_tokens: 4, output_tokens: 8, total_tokens: 12, seconds_running: 42.5 },
    rate_limits: { primary: { remaining: 11 } },
  };
}

const refreshReply: RequestRefreshReply = {
  queued: true,
  coalesced: false,
  requested_at: new Date(),
  operations: ["poll", "reconcile"],
};

function provider(
  snapshot: SnapshotResult,
  refresh: RequestRefreshReply | "unavailable",
): SnapshotProvider {
  return {
    snapshot: () => Promise.resolve(snapshot),
    requestRefresh: () => Promise.resolve(refresh),
  };
}

async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve, reject) => {
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => resolve());
  });
  const address = probe.address();
  const port = typeof address === "object" && address !== null ? address.port : null;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  if (port === null) {
    throw new Error("Could not allocate a free port");
  }
  return port;
}

describe("web server / observability API", () => {
  let root: string;

  beforeEach(() => {
    ({ root } = setupWorkflow());
  });

  afterEach(() => {
    teardownWorkflow(root);
  });

  describe("router", () => {
    const route = createRouter(provider(staticSnapshot(), refreshReply), 50);

    async function json(
      path: string,
      init?: RequestInit,
    ): Promise<{ status: number; body: unknown }> {
      const res = await route(new Request(`http://127.0.0.1${path}`, init));
      return { status: res.status, body: await res.json() };
    }

    test("GET /api/v1/state returns the projected snapshot", async () => {
      const { status, body } = await json("/api/v1/state");
      expect(status).toBe(200);
      expect((body as Record<string, unknown>).counts).toEqual({
        running: 1,
        retrying: 1,
        blocked: 1,
      });
    });

    test("GET /api/v1/:id returns the issue body or 404", async () => {
      const found = await json("/api/v1/MT-HTTP");
      expect(found.status).toBe(200);
      expect((found.body as Record<string, unknown>).status).toBe("running");

      const missing = await json("/api/v1/MT-MISSING");
      expect(missing.status).toBe(404);
      expect(missing.body).toEqual({
        error: { code: "issue_not_found", message: "Issue not found" },
      });
    });

    test("GET /api/v1/:id with malformed percent-encoding returns 404, not 500", async () => {
      // `%zz` is not decodable: decodeURIComponent throws a URIError, which
      // used to escape the router as a 500.
      // An undecodable path cannot name an issue at all, so it falls through as
      // an unmatched route rather than a missing issue — either way a 404, and
      // never a URIError escaping as a 500.
      const { status, body } = await json("/api/v1/%zz");
      expect(status).toBe(404);
      expect(body).toEqual({ error: { code: "not_found", message: "Route not found" } });
    });

    test("POST /api/v1/refresh returns 202", async () => {
      const { status, body } = await json("/api/v1/refresh", { method: "POST" });
      expect(status).toBe(202);
      expect(body).toMatchObject({
        queued: true,
        coalesced: false,
        operations: ["poll", "reconcile"],
      });
    });

    test("POST /api/v1/:id/rerun returns explicit blocked rerun outcome", async () => {
      const route = createRouter(
        {
          ...provider(staticSnapshot(), refreshReply),
          rerunBlockedIssue: () =>
            Promise.resolve({
              queued: true as const,
              issue_id: "issue-blocked",
              issue_identifier: "MT-BLOCKED",
              requested_at: new Date(),
              operation: "rerun_blocked" as const,
            }),
        },
        50,
      );
      const res = await route(
        new Request("http://127.0.0.1/api/v1/MT-BLOCKED/rerun", {
          method: "POST",
        }),
      );
      expect(res.status).toBe(202);
      expect(await res.json()).toMatchObject({
        queued: true,
        issue_id: "issue-blocked",
        issue_identifier: "MT-BLOCKED",
        operation: "rerun_blocked",
      });
    });

    test("preserves 405 method-not-allowed behavior", async () => {
      const cases: [string, string][] = [
        ["/api/v1/state", "POST"],
        ["/api/v1/refresh", "GET"],
        ["/", "POST"],
        ["/api/v1/MT-1", "POST"],
        ["/api/v1/MT-1/rerun", "GET"],
      ];
      for (const [path, method] of cases) {
        const { status, body } = await json(path, { method });
        expect(status).toBe(405);
        expect(body).toEqual({
          error: { code: "method_not_allowed", message: "Method not allowed" },
        });
      }
    });

    test("preserves 404 route-not-found behavior", async () => {
      const { status, body } = await json("/unknown");
      expect(status).toBe(404);
      expect(body).toEqual({ error: { code: "not_found", message: "Route not found" } });
    });

    test("routes built frontend fonts through the static asset handler", async () => {
      const route = createRouter(provider(staticSnapshot(), refreshReply), 50, {
        staticAsset: () =>
          new Response("font bytes", {
            headers: { "content-type": "font/woff2" },
          }),
      });

      const response = await route(new Request("http://127.0.0.1/fonts/CascadiaMono.woff2"));
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("font/woff2");
      expect(await response.text()).toBe("font bytes");
    });
  });

  test("reports snapshot unavailable and orchestrator unavailable", async () => {
    const route = createRouter(provider("unavailable", "unavailable"), 5);

    const state = await route(new Request("http://127.0.0.1/api/v1/state"));
    expect(state.status).toBe(200);
    expect(await state.json()).toMatchObject({
      error: { code: "snapshot_unavailable", message: "Snapshot unavailable" },
    });

    const refresh = await route(new Request("http://127.0.0.1/api/v1/refresh", { method: "POST" }));
    expect(refresh.status).toBe(503);
    expect(await refresh.json()).toEqual({
      error: { code: "orchestrator_unavailable", message: "Orchestrator is unavailable" },
    });
  });

  test("reports snapshot timeout", async () => {
    const route = createRouter(provider("timeout", refreshReply), 1);
    const res = await route(new Request("http://127.0.0.1/api/v1/state"));
    expect(await res.json()).toMatchObject({
      error: { code: "snapshot_timeout", message: "Snapshot timed out" },
    });
  });

  test("GET /api/v1/:id/output supports tail and after cursors", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "symphony-api-output-"));
    const outputStore = new AgentOutputStore({ root, mode: "raw" });
    const run = outputStore.startRun({
      issueId: "issue-http",
      issueIdentifier: "MT-HTTP",
      title: "HTTP output",
      backend: "codex",
      workerHost: null,
      runId: "api-run",
    });
    run.record(
      { event: "session_started", timestamp: new Date(), sessionId: "api-session" },
      1,
      "Started",
    );
    run.record(
      { event: "notification", timestamp: new Date(), payload: { step: 1 } },
      1,
      "Step one",
    );
    run.record({ event: "turn_completed", timestamp: new Date() }, 1, "Completed");

    const route = createRouter(provider(staticSnapshot(), refreshReply), 50, {
      agentOutputStore: outputStore,
    });
    try {
      const tail = await route(new Request("http://127.0.0.1/api/v1/MT-HTTP/output?limit=2"));
      expect(tail.status).toBe(200);
      const tailBody = (await tail.json()) as Record<string, unknown>;
      expect((tailBody.events as Array<{ seq: number }>).map((event) => event.seq)).toEqual([3, 4]);
      expect(tailBody.has_more).toBe(true);
      expect(tailBody.before_cursor).toBe(3);
      expect(tailBody.has_before).toBe(true);
      expect(tailBody.backend).toBe("codex");

      const earlier = await route(
        new Request("http://127.0.0.1/api/v1/MT-HTTP/output?limit=2&before=3"),
      );
      const earlierBody = (await earlier.json()) as Record<string, unknown>;
      expect((earlierBody.events as Array<{ seq: number }>).map((event) => event.seq)).toEqual([
        1, 2,
      ]);
      expect(earlierBody.before_cursor).toBe(1);
      expect(earlierBody.has_before).toBe(false);

      const incremental = await route(
        new Request("http://127.0.0.1/api/v1/MT-HTTP/output?limit=2&after=1"),
      );
      const incrementalBody = (await incremental.json()) as Record<string, unknown>;
      expect((incrementalBody.events as Array<{ seq: number }>).map((event) => event.seq)).toEqual([
        2, 3,
      ]);

      const invalid = await route(
        new Request("http://127.0.0.1/api/v1/MT-HTTP/output?after=1&before=3"),
      );
      expect(invalid.status).toBe(400);
      expect(await invalid.json()).toEqual({
        error: { code: "invalid_output_query", message: "after and before cannot be combined" },
      });
    } finally {
      await run.finish("completed");
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("returns all issue runs and selects historical output by run_id", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "symphony-api-run-history-"));
    const outputStore = new AgentOutputStore({ root, mode: "raw" });
    const runCount = 52;
    for (let index = 0; index < runCount; index += 1) {
      const run = outputStore.startRun({
        issueId: "issue-history-runs",
        issueIdentifier: "MT-HISTORY-RUNS",
        title: "Run history",
        backend: "codex",
        workerHost: null,
        runId: `history-run-${index}`,
      });
      run.record(
        { event: "session_started", timestamp: new Date(), sessionId: `history-session-${index}` },
        1,
        `Session ${index}`,
      );
      await run.finish("completed");
    }

    const route = createRouter(provider(staticSnapshot(), refreshReply), 50, {
      agentOutputStore: outputStore,
    });
    try {
      const detail = await route(new Request("http://127.0.0.1/api/v1/MT-HISTORY-RUNS"));
      expect(detail.status).toBe(200);
      const detailBody = (await detail.json()) as {
        logs: {
          agent_runs: Array<{ run_id: string; session_id: string | null }>;
          codex_session_logs: Array<{ run_id: string }>;
          latest_run: { run_id: string };
        };
      };
      expect(detailBody.logs.agent_runs).toHaveLength(runCount);
      expect(detailBody.logs.codex_session_logs).toHaveLength(runCount);
      expect(detailBody.logs.latest_run.run_id).toBe(`history-run-${runCount - 1}`);

      const historical = await route(
        new Request("http://127.0.0.1/api/v1/MT-HISTORY-RUNS/output?run_id=history-run-0&limit=20"),
      );
      expect(historical.status).toBe(200);
      const historicalBody = (await historical.json()) as {
        run: { run_id: string; session_id: string | null };
        events: Array<{ run_id: string; session_id?: string }>;
      };
      expect(historicalBody.run).toMatchObject({
        run_id: "history-run-0",
        session_id: "history-session-0",
      });
      expect(historicalBody.events.every((event) => event.run_id === "history-run-0")).toBe(true);
      expect(historicalBody.events.some((event) => event.session_id === "history-session-0")).toBe(
        true,
      );

      const missingRun = await route(
        new Request("http://127.0.0.1/api/v1/MT-HISTORY-RUNS/output?run_id=missing-run"),
      );
      expect(missingRun.status).toBe(404);
      expect(await missingRun.json()).toEqual({
        error: { code: "run_not_found", message: "Run not found" },
      });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("output route distinguishes unknown issues and missing logs", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "symphony-api-empty-"));
    const outputStore = new AgentOutputStore({ root, mode: "raw" });
    const route = createRouter(provider(staticSnapshot(), refreshReply), 50, {
      agentOutputStore: outputStore,
    });
    try {
      const empty = await route(new Request("http://127.0.0.1/api/v1/MT-HTTP/output"));
      expect(empty.status).toBe(200);
      expect(await empty.json()).toMatchObject({ events: [], run: null, has_more: false });

      const missing = await route(new Request("http://127.0.0.1/api/v1/MT-MISSING/output"));
      expect(missing.status).toBe(404);
      expect(await missing.json()).toEqual({
        error: { code: "issue_not_found", message: "Issue not found" },
      });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("issue detail keeps completed run metadata after the issue leaves the snapshot", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "symphony-api-history-"));
    const outputStore = new AgentOutputStore({ root, mode: "raw" });
    const run = outputStore.startRun({
      issueId: "issue-history",
      issueIdentifier: "MT-HISTORY",
      title: "Historical run",
      backend: "claude_code",
      workerHost: null,
      runId: "history-run",
    });
    run.record(
      { event: "session_started", timestamp: new Date(), sessionId: "history-session" },
      1,
    );
    await run.finish("completed");
    const snapshot = staticSnapshot();
    snapshot.running = [];
    snapshot.retrying = [];
    snapshot.blocked = [];
    const route = createRouter(provider(snapshot, refreshReply), 50, {
      agentOutputStore: outputStore,
    });
    try {
      const response = await route(new Request("http://127.0.0.1/api/v1/MT-HISTORY"));
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        issue_identifier: "MT-HISTORY",
        status: "completed",
        logs: { latest_run: { run_id: "history-run", backend: "claude_code" } },
      });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("output SSE emits agent_output events and closes on run completion", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "symphony-api-sse-"));
    const outputStore = new AgentOutputStore({ root, mode: "raw" });
    const run = outputStore.startRun({
      issueId: "issue-http",
      issueIdentifier: "MT-HTTP",
      backend: "codex",
      workerHost: null,
      runId: "sse-run",
    });
    const route = createRouter(provider(staticSnapshot(), refreshReply), 50, {
      agentOutputStore: outputStore,
    });
    const response = await route(new Request("http://127.0.0.1/api/v1/MT-HTTP/output/stream"));
    expect(response.status).toBe(200);
    const reader = response.body?.getReader();
    expect(reader).toBeDefined();
    if (reader === undefined) {
      fs.rmSync(root, { recursive: true, force: true });
      return;
    }
    try {
      const connected = await reader.read();
      expect(new TextDecoder().decode(connected.value)).toContain(": connected");
      run.record({ event: "notification", timestamp: new Date(), stream: "stderr" }, 1, "stderr");
      const started = await reader.read();
      expect(new TextDecoder().decode(started.value)).toContain('"event":"run_started"');
      const chunk = await reader.read();
      expect(new TextDecoder().decode(chunk.value)).toContain("event: agent_output");
      expect(new TextDecoder().decode(chunk.value)).toContain('"stream":"stderr"');
      await run.finish("completed");
      const terminal = await reader.read();
      expect(new TextDecoder().decode(terminal.value)).toContain('"event":"run_completed"');
      expect((await reader.read()).done).toBe(true);

      const lateResponse = await route(
        new Request("http://127.0.0.1/api/v1/MT-HTTP/output/stream"),
      );
      const lateReader = lateResponse.body?.getReader();
      expect(lateReader).toBeDefined();
      if (lateReader !== undefined) {
        expect(new TextDecoder().decode((await lateReader.read()).value)).toContain(": connected");
        const replay: string[] = [];
        for (let index = 0; index < 4; index += 1) {
          const next = await lateReader.read();
          replay.push(new TextDecoder().decode(next.value));
          if (replay.at(-1)?.includes('"event":"run_completed"')) {
            break;
          }
        }
        expect(replay.join("")).toContain('"event":"run_completed"');
        expect((await lateReader.read()).done).toBe(true);
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("output SSE subscribes before taking the initial snapshot", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "symphony-api-sse-race-"));
    let inject: (() => void) | null = null;
    class RaceStore extends AgentOutputStore {
      override readIssueOutput(
        issueIdentifier: string,
        options: { limit?: number; after?: number | null; before?: number | null } = {},
      ) {
        const result = super.readIssueOutput(issueIdentifier, options);
        inject?.();
        inject = null;
        return result;
      }
    }
    const outputStore = new RaceStore({ root, mode: "raw" });
    const run = outputStore.startRun({
      issueId: "issue-http",
      issueIdentifier: "MT-HTTP",
      backend: "codex",
      workerHost: null,
      runId: "race-run",
    });
    inject = () => run.record({ event: "notification", timestamp: new Date() }, 1, "raced");

    const route = createRouter(provider(staticSnapshot(), refreshReply), 50, {
      agentOutputStore: outputStore,
    });
    const response = await route(new Request("http://127.0.0.1/api/v1/MT-HTTP/output/stream"));
    const reader = response.body?.getReader();
    expect(reader).toBeDefined();
    if (reader === undefined) {
      fs.rmSync(root, { recursive: true, force: true });
      return;
    }
    try {
      const chunks: string[] = [];
      for (let index = 0; index < 3; index += 1) {
        const next = await reader.read();
        chunks.push(new TextDecoder().decode(next.value));
      }
      const text = chunks.join("");
      expect(text).toContain('"event":"run_started"');
      expect(text).toContain('"message":"raced"');
      await run.finish("completed");
    } finally {
      await reader.cancel();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("output SSE ignores events from a newer run", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "symphony-api-sse-run-"));
    const outputStore = new AgentOutputStore({ root, mode: "raw" });
    const first = outputStore.startRun({
      issueId: "issue-http",
      issueIdentifier: "MT-HTTP",
      backend: "codex",
      workerHost: null,
      runId: "first-run",
    });
    const route = createRouter(provider(staticSnapshot(), refreshReply), 50, {
      agentOutputStore: outputStore,
    });
    const response = await route(new Request("http://127.0.0.1/api/v1/MT-HTTP/output/stream"));
    const reader = response.body?.getReader();
    expect(reader).toBeDefined();
    if (reader === undefined) {
      fs.rmSync(root, { recursive: true, force: true });
      return;
    }
    try {
      expect(new TextDecoder().decode((await reader.read()).value)).toContain(": connected");
      const second = outputStore.startRun({
        issueId: "issue-http",
        issueIdentifier: "MT-HTTP",
        backend: "codex",
        workerHost: null,
        runId: "second-run",
      });
      second.record({ event: "notification", timestamp: new Date() }, 1, "new run");
      const next = await Promise.race([
        reader.read(),
        Bun.sleep(25).then(() => ({ timedOut: true as const })),
      ]);
      expect("timedOut" in next).toBe(true);
      await second.finish("completed");
      await first.finish("completed");
    } finally {
      await reader.cancel();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("output SSE selects the requested run_id", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "symphony-api-sse-selected-run-"));
    const outputStore = new AgentOutputStore({ root, mode: "raw" });
    const first = outputStore.startRun({
      issueId: "issue-http",
      issueIdentifier: "MT-HTTP",
      backend: "codex",
      workerHost: null,
      runId: "first-run",
    });
    first.record(
      { event: "session_started", timestamp: new Date(), sessionId: "first-session" },
      1,
      "first",
    );
    await first.finish("completed");
    const second = outputStore.startRun({
      issueId: "issue-http",
      issueIdentifier: "MT-HTTP",
      backend: "codex",
      workerHost: null,
      runId: "second-run",
    });
    second.record(
      { event: "session_started", timestamp: new Date(), sessionId: "second-session" },
      1,
      "second",
    );
    await second.finish("completed");

    const route = createRouter(provider(staticSnapshot(), refreshReply), 50, {
      agentOutputStore: outputStore,
    });
    try {
      const response = await route(
        new Request("http://127.0.0.1/api/v1/MT-HTTP/output/stream?run_id=first-run"),
      );
      expect(response.status).toBe(200);
      const text = await response.text();
      expect(text).toContain('"run_id":"first-run"');
      expect(text).toContain('"session_id":"first-session"');
      expect(text).not.toContain('"run_id":"second-run"');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("HttpServer refuses remote binding without an explicit opt-in", () => {
    const server = new HttpServer();
    const result = server.start({ host: "0.0.0.0", port: 12345 });
    expect(result.kind).toBe("error");
    if (result.kind === "error") {
      expect(String(result.error)).toContain("unsafe_allow_remote");
    }
  });

  test("HttpServer is ignored when no port is configured", () => {
    const server = new HttpServer();
    expect(server.start({ port: null }).kind).toBe("ignore");
    expect(server.boundPort()).toBeNull();
  });

  test("HttpServer binds a port and serves the API", async () => {
    const server = new HttpServer();
    const result = server.start({
      host: "127.0.0.1",
      port: await freePort(),
      orchestrator: provider(staticSnapshot(), refreshReply),
      snapshotTimeoutMs: 50,
    });
    expect(result.kind).toBe("started");
    try {
      const port = server.boundPort();
      expect(typeof port).toBe("number");

      const res = await fetch(`http://127.0.0.1:${port}/api/v1/state`);
      expect(res.status).toBe(200);
      expect(((await res.json()) as Record<string, unknown>).counts).toEqual({
        running: 1,
        retrying: 1,
        blocked: 1,
      });
    } finally {
      server.stop();
    }
    expect(server.boundPort()).toBeNull();
  });

  test("HttpServer reports an error for an unresolvable host", () => {
    const server = new HttpServer();
    const result = server.start({ host: "bad host", port: 0 });
    expect(result.kind).toBe("error");
  });
});
