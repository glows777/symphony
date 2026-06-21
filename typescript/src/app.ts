// Port of the `SymphonyElixir.Application` supervisor + `SymphonyElixir.start_link/1`.
//
// The OTP `:one_for_one` supervisor tree becomes an explicit async start that
// wires the ported components together: the WorkflowStore, the live Orchestrator
// (GenServer class), the HttpServer (Bun.serve), and the dashboard's SSR + SSE
// handlers. `Phoenix.PubSub`/`StatusDashboard.notify_update` is bridged by
// registering a live dashboard whose `notifyUpdate` fans out an observability
// broadcast that drives the SSE stream.

import { configure as configureLogFile } from "./symphony/log-file.ts";
import { Orchestrator } from "./symphony/orchestrator.ts";
import { type Result, err, ok } from "./symphony/result.ts";
import { registerLiveDashboard } from "./symphony/status-dashboard.ts";
import {
  broadcastUpdate,
  makeDashboardHandler,
  makeEventsHandler,
} from "./symphony/web/dashboard.ts";
import { HttpServer } from "./symphony/web/server.ts";
import { WorkflowStore } from "./symphony/workflow-store.ts";

const SNAPSHOT_TIMEOUT_MS = 15_000;

export type AppHandle = {
  workflowStore: WorkflowStore;
  orchestrator: Orchestrator;
  server: HttpServer;
};

// Port of `Application.start/2`: starts the core workers and returns a handle
// for shutdown. Mirrors the `:one_for_one` child list (log file → workflow store
// → orchestrator → http server → dashboard wiring).
export async function startApp(): Promise<Result<AppHandle, unknown>> {
  configureLogFile();

  // Start the workflow store before the orchestrator (mirrors the supervisor
  // child order). It caches the last-known-good WORKFLOW.md so config reads do
  // not re-parse the file on every poll; without it a transient invalid/unreadable
  // edit could make `refreshRuntimeConfig()` throw in the tick handler and leave
  // the orchestrator with no next poll scheduled.
  const storeStart = WorkflowStore.startLink();
  if (!storeStart.ok) {
    return err(storeStart.error);
  }
  const workflowStore = storeStart.value;

  const orchestrator = new Orchestrator();
  await orchestrator.start();

  // `StatusDashboard.notify_update/0` → an observability broadcast that wakes
  // every connected SSE client.
  registerLiveDashboard({ notifyUpdate: () => broadcastUpdate() });

  const server = new HttpServer();
  const started = server.start({
    orchestrator,
    snapshotTimeoutMs: SNAPSHOT_TIMEOUT_MS,
    handlers: {
      dashboard: makeDashboardHandler(orchestrator, SNAPSHOT_TIMEOUT_MS),
      events: makeEventsHandler(orchestrator, SNAPSHOT_TIMEOUT_MS),
    },
  });

  // A configured-but-unbindable port (e.g. already in use) is a startup failure,
  // just as a failed child crashes the OTP `:one_for_one` supervisor. Unwind what
  // we already started so the caller does not see a half-running service report
  // success. (`kind: "ignore"` means no port was configured — not an error.)
  if (started.kind === "error") {
    registerLiveDashboard(null);
    orchestrator.stop();
    workflowStore.stop();
    return err(started.error);
  }

  return ok({ workflowStore, orchestrator, server });
}

// Port of `Application.stop/1`: tear down the server, orchestrator, and workflow
// store. (The terminal offline-status render lives in StatusDashboard, ported
// separately.)
export function stopApp(handle: AppHandle): void {
  handle.server.stop();
  handle.orchestrator.stop();
  handle.workflowStore.stop();
  registerLiveDashboard(null);
}
