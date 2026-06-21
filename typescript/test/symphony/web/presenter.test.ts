import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import path from "node:path";
import { settingsBang } from "../../../src/symphony/config.ts";
import type { RequestRefreshReply, Snapshot } from "../../../src/symphony/orchestrator.ts";
import * as Presenter from "../../../src/symphony/web/presenter.ts";
import type { SnapshotProvider, SnapshotResult } from "../../../src/symphony/web/presenter.ts";
import { setupWorkflow, teardownWorkflow } from "../../support/test-support.ts";

// Translated from the observability-API payload expectations in extensions_test.exs
// (the Presenter projections that back `/api/v1/state`, `/api/v1/:id`, and
// `/api/v1/refresh`). The Elixir StaticOrchestrator/SlowOrchestrator/unavailable
// doubles become SnapshotProvider doubles.

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
          timestamp: new Date(),
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

describe("Presenter", () => {
  let root: string;

  beforeEach(() => {
    ({ root } = setupWorkflow());
  });

  afterEach(() => {
    teardownWorkflow(root);
  });

  test("state payload projects running, retrying, and blocked entries", async () => {
    const payload = await Presenter.statePayload(provider(staticSnapshot(), refreshReply), 50);

    expect(typeof payload.generated_at).toBe("string");
    expect(payload.counts).toEqual({ running: 1, retrying: 1, blocked: 1 });

    const running = (payload.running as Record<string, unknown>[])[0];
    expect(running).toMatchObject({
      issue_id: "issue-http",
      issue_identifier: "MT-HTTP",
      issue_url: "https://example.org/issues/MT-HTTP",
      state: "In Progress",
      worker_host: null,
      workspace_path: null,
      session_id: "thread-http",
      turn_count: 7,
      last_event: "notification",
      last_message: "rendered",
      last_event_at: null,
      tokens: { input_tokens: 4, output_tokens: 8, total_tokens: 12 },
    });
    expect(typeof running?.started_at).toBe("string");

    const retrying = (payload.retrying as Record<string, unknown>[])[0];
    expect(retrying).toMatchObject({
      issue_id: "issue-retry",
      issue_identifier: "MT-RETRY",
      issue_url: "https://example.org/issues/MT-RETRY",
      attempt: 2,
      error: "boom",
      worker_host: null,
      workspace_path: null,
    });
    expect(typeof retrying?.due_at).toBe("string");

    const blocked = (payload.blocked as Record<string, unknown>[])[0];
    expect(blocked).toMatchObject({
      issue_id: "issue-blocked",
      issue_identifier: "MT-BLOCKED",
      issue_url: "https://example.org/issues/MT-BLOCKED",
      state: "In Progress",
      error: "codex turn requires operator input",
      worker_host: "dm-dev2",
      workspace_path: "/workspaces/MT-BLOCKED",
      session_id: "thread-blocked",
      last_event: "turn_input_required",
      last_message: "turn blocked: waiting for user input",
    });

    expect(payload.codex_totals).toEqual({
      input_tokens: 4,
      output_tokens: 8,
      total_tokens: 12,
      seconds_running: 42.5,
    });
    expect(payload.rate_limits).toEqual({ primary: { remaining: 11 } });
  });

  test("issue payload projects a running issue body", async () => {
    const result = await Presenter.issuePayload(
      "MT-HTTP",
      provider(staticSnapshot(), refreshReply),
      50,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    const value = result.value;
    expect(value).toMatchObject({
      issue_identifier: "MT-HTTP",
      issue_id: "issue-http",
      status: "running",
      workspace: { path: path.join(settingsBang().workspace.root, "MT-HTTP"), host: null },
      attempts: { restart_count: 0, current_retry_attempt: 0 },
      retry: null,
      blocked: null,
      logs: { codex_session_logs: [] },
      recent_events: [],
      last_error: null,
      tracked: {},
    });
    expect(value.running).toMatchObject({
      session_id: "thread-http",
      turn_count: 7,
      state: "In Progress",
      last_event: "notification",
      last_message: "rendered",
      tokens: { input_tokens: 4, output_tokens: 8, total_tokens: 12 },
    });
  });

  test("issue payload projects retrying and blocked issues", async () => {
    const retry = await Presenter.issuePayload(
      "MT-RETRY",
      provider(staticSnapshot(), refreshReply),
      50,
    );
    expect(retry.ok).toBe(true);
    if (retry.ok) {
      expect(retry.value.status).toBe("retrying");
      expect(retry.value.retry).toMatchObject({ attempt: 2, error: "boom" });
    }

    const blocked = await Presenter.issuePayload(
      "MT-BLOCKED",
      provider(staticSnapshot(), refreshReply),
      50,
    );
    expect(blocked.ok).toBe(true);
    if (blocked.ok) {
      expect(blocked.value.status).toBe("blocked");
      expect(blocked.value.last_error).toBe("codex turn requires operator input");
      expect(blocked.value.blocked).toMatchObject({
        session_id: "thread-blocked",
        state: "In Progress",
        error: "codex turn requires operator input",
      });
    }
  });

  test("issue payload reports not found for unknown identifiers", async () => {
    const result = await Presenter.issuePayload(
      "MT-MISSING",
      provider(staticSnapshot(), refreshReply),
      50,
    );
    expect(result).toEqual({ ok: false, error: "issue_not_found" });
  });

  test("refresh payload serializes requested_at", async () => {
    const result = await Presenter.refreshPayload(provider(staticSnapshot(), refreshReply));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toMatchObject({
        queued: true,
        coalesced: false,
        operations: ["poll", "reconcile"],
      });
      expect(typeof result.value.requested_at).toBe("string");
    }
  });

  test("state payload reports snapshot unavailable", async () => {
    const payload = await Presenter.statePayload(provider("unavailable", "unavailable"), 5);
    expect(payload.error).toEqual({
      code: "snapshot_unavailable",
      message: "Snapshot unavailable",
    });
  });

  test("refresh payload reports orchestrator unavailable", async () => {
    const result = await Presenter.refreshPayload(provider("unavailable", "unavailable"));
    expect(result).toEqual({ ok: false, error: "unavailable" });
  });

  test("state payload reports snapshot timeout", async () => {
    const payload = await Presenter.statePayload(provider("timeout", refreshReply), 1);
    expect(payload.error).toEqual({ code: "snapshot_timeout", message: "Snapshot timed out" });
  });
});
