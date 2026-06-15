import { afterEach, beforeEach, describe, expect, test } from "bun:test";
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

    test("POST /api/v1/refresh returns 202", async () => {
      const { status, body } = await json("/api/v1/refresh", { method: "POST" });
      expect(status).toBe(202);
      expect(body).toMatchObject({
        queued: true,
        coalesced: false,
        operations: ["poll", "reconcile"],
      });
    });

    test("preserves 405 method-not-allowed behavior", async () => {
      const cases: [string, string][] = [
        ["/api/v1/state", "POST"],
        ["/api/v1/refresh", "GET"],
        ["/", "POST"],
        ["/api/v1/MT-1", "POST"],
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

  test("HttpServer is ignored when no port is configured", () => {
    const server = new HttpServer();
    expect(server.start({ port: null }).kind).toBe("ignore");
    expect(server.boundPort()).toBeNull();
  });

  test("HttpServer binds a port and serves the API", async () => {
    const server = new HttpServer();
    const result = server.start({
      host: "127.0.0.1",
      port: 0,
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
