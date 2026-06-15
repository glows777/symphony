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
import { type Result, ok } from "./symphony/result.ts";
import { registerLiveDashboard } from "./symphony/status-dashboard.ts";
import {
  broadcastUpdate,
  makeDashboardHandler,
  makeEventsHandler,
} from "./symphony/web/dashboard.ts";
import { HttpServer } from "./symphony/web/server.ts";

const SNAPSHOT_TIMEOUT_MS = 15_000;

export type AppHandle = {
  orchestrator: Orchestrator;
  server: HttpServer;
};

// Port of `Application.start/2`: starts the core workers and returns a handle
// for shutdown. Mirrors the `:one_for_one` child list (log file → orchestrator
// → http server → dashboard wiring).
export async function startApp(): Promise<Result<AppHandle, unknown>> {
  configureLogFile();

  const orchestrator = new Orchestrator();
  await orchestrator.start();

  // `StatusDashboard.notify_update/0` → an observability broadcast that wakes
  // every connected SSE client.
  registerLiveDashboard({ notifyUpdate: () => broadcastUpdate() });

  const server = new HttpServer();
  server.start({
    orchestrator,
    snapshotTimeoutMs: SNAPSHOT_TIMEOUT_MS,
    handlers: {
      dashboard: makeDashboardHandler(orchestrator, SNAPSHOT_TIMEOUT_MS),
      events: makeEventsHandler(orchestrator, SNAPSHOT_TIMEOUT_MS),
    },
  });

  return ok({ orchestrator, server });
}

// Port of `Application.stop/1`: tear down the server and orchestrator. (The
// terminal offline-status render lives in StatusDashboard, ported separately.)
export function stopApp(handle: AppHandle): void {
  handle.server.stop();
  handle.orchestrator.stop();
  registerLiveDashboard(null);
}
