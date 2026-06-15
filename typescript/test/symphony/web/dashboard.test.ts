import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { RequestRefreshReply, Snapshot } from "../../../src/symphony/orchestrator.ts";
import {
  broadcastUpdate,
  makeDashboardHandler,
  makeEventsHandler,
} from "../../../src/symphony/web/dashboard.ts";
import { resetForTest } from "../../../src/symphony/web/observability-pubsub.ts";
import type { SnapshotProvider, SnapshotResult } from "../../../src/symphony/web/presenter.ts";
import { setupWorkflow, teardownWorkflow } from "../../support/test-support.ts";

// Translated from the DashboardLive render/refresh cases in extensions_test.exs.
// Phoenix LiveView → SSR HTML + SSE: the render assertions become SSR-output
// assertions, and the pubsub-driven `render(view)` refresh becomes an SSE event.

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
  operations: ["poll"],
};

function provider(snapshot: SnapshotResult): SnapshotProvider {
  return {
    snapshot: () => Promise.resolve(snapshot),
    requestRefresh: () => Promise.resolve(refreshReply),
  };
}

describe("dashboard SSR + SSE", () => {
  let root: string;

  beforeEach(() => {
    ({ root } = setupWorkflow());
    resetForTest();
  });

  afterEach(() => {
    resetForTest();
    teardownWorkflow(root);
  });

  async function renderHtml(snapshot: SnapshotResult): Promise<string> {
    const handler = makeDashboardHandler(provider(snapshot), 50);
    const res = await handler(new Request("http://127.0.0.1/"));
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
    return res.text();
  }

  test("renders the operations dashboard from the snapshot", async () => {
    const html = await renderHtml(staticSnapshot());

    expect(html).toContain("Operations Dashboard");
    for (const id of ["MT-HTTP", "MT-RETRY", "MT-BLOCKED"]) {
      expect(html).toContain(id);
      expect(html).toContain(`href="https://example.org/issues/${id}"`);
    }
    expect(html).toContain('aria-label="Open MT-HTTP in the issue tracker"');
    expect(html).toContain("rendered");
    expect(html).toContain("turn blocked: waiting for user input");
    expect(html).toContain("Runtime");
    expect(html).toContain("Live");
    expect(html).toContain("Offline");
    expect(html).toContain("Copy ID");
    expect(html).toContain("Codex update");
    expect(html).toContain("status-badge-live");
    expect(html).toContain("status-badge-offline");

    // Links to the embedded assets.
    expect(html).toMatch(/href="\/dashboard\.css\?v=[0-9a-f]{12}"/);
    expect(html).toMatch(/href="\/favicon\.png\?v=[0-9a-f]{12}"/);

    // SSE design omits the LiveView runtime-clock / refresh affordances.
    expect(html).not.toContain("data-runtime-clock=");
    expect(html).not.toContain("setInterval(refreshRuntimeClocks");
    expect(html).not.toContain("Refresh now");
    expect(html).not.toContain("Transport");
  });

  test("rejects non-http issue URLs to avoid script injection", async () => {
    const snapshot = staticSnapshot();
    snapshot.running[0] = {
      ...snapshot.running[0],
      issue_url: "javascript:alert('nope')",
    } as never;
    const html = await renderHtml(snapshot);
    expect(html).not.toContain("javascript:alert");
    // Identifier still renders, as a plain span.
    expect(html).toContain("MT-HTTP");
  });

  test("renders an unavailable state without crashing", async () => {
    const html = await renderHtml("unavailable");
    expect(html).toContain("Snapshot unavailable");
    expect(html).toContain("snapshot_unavailable");
  });

  test("streams a re-rendered dashboard section over SSE on broadcast", async () => {
    const handler = makeEventsHandler(provider(staticSnapshot()), 50);
    const res = await handler(new Request("http://127.0.0.1/events"));
    expect(res.headers.get("content-type")).toBe("text/event-stream");

    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    async function readUntil(substr: string): Promise<void> {
      while (!buffer.includes(substr)) {
        const { value, done } = await reader.read();
        if (done) {
          throw new Error(`stream ended before "${substr}"`);
        }
        buffer += decoder.decode(value);
      }
    }

    await readUntil(": connected");
    broadcastUpdate();
    await readUntil("event: update");
    expect(buffer).toContain("Operations Dashboard");
    expect(buffer).toContain("MT-HTTP");

    await reader.cancel();
  });
});
