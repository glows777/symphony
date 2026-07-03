// Literal port of `symphony_elixir/http_server.ex` + `web/endpoint.ex` +
// `web/router.ex` + `web/controllers/observability_api_controller.ex`.
//
// Phoenix endpoint/router/Bandit → `Bun.serve` + a small router (per the rulebook).
// The JSON observability API (`/api/v1/*`) and its 405/404 behavior are
// framework-agnostic and ported literally; `GET /` (dashboard) and the static
// asset routes are delegated to optional handlers wired by later Phase 5 work.

import { serverPort, settingsBang } from "../config.ts";
import * as Presenter from "./presenter.ts";
import type { SnapshotProvider } from "./presenter.ts";
import { setBoundPort } from "./server-port.ts";
import { serveStaticAsset } from "./static-assets.ts";

const DEFAULT_SNAPSHOT_TIMEOUT_MS = 15_000;

const UNAVAILABLE_PROVIDER: SnapshotProvider = {
  snapshot: () => Promise.resolve("unavailable"),
  requestRefresh: () => Promise.resolve("unavailable"),
};

export type RequestHandler = (req: Request) => Response | Promise<Response>;

export type RouterHandlers = {
  // `GET /` — the SSR dashboard (wired by the dashboard module).
  dashboard?: RequestHandler;
  // `GET /events` — the dashboard's Server-Sent-Events stream.
  events?: RequestHandler;
  // Static assets (`/dashboard.css`, `/favicon.png`, vendored JS).
  staticAsset?: RequestHandler;
};

const STATIC_ASSET_PATHS = new Set([
  "/dashboard.css",
  "/favicon.png",
  "/vendor/phoenix_html/phoenix_html.js",
  "/vendor/phoenix/phoenix.js",
  "/vendor/phoenix_live_view/phoenix_live_view.js",
]);

// Builds the `Bun.serve` fetch handler. Exposed directly so routing can be unit
// tested without binding a socket.
export function createRouter(
  provider: SnapshotProvider,
  snapshotTimeoutMs: number,
  handlers: RouterHandlers = {},
): (req: Request) => Promise<Response> {
  return async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    const path = url.pathname;
    const method = req.method.toUpperCase();

    if (STATIC_ASSET_PATHS.has(path)) {
      if (method === "GET" && handlers.staticAsset) {
        return handlers.staticAsset(req);
      }
      return notFound();
    }

    if (path === "/") {
      if (method === "GET" && handlers.dashboard) {
        return handlers.dashboard(req);
      }
      if (method === "GET") {
        return notFound();
      }
      return methodNotAllowed();
    }

    if (path === "/events" && method === "GET" && handlers.events) {
      return handlers.events(req);
    }

    if (path === "/api/v1/state") {
      return method === "GET" ? handleState(provider, snapshotTimeoutMs) : methodNotAllowed();
    }

    if (path === "/api/v1/refresh") {
      return method === "POST" ? handleRefresh(provider) : methodNotAllowed();
    }

    const issueIdentifier = apiV1IssueIdentifier(path);
    if (issueIdentifier !== null) {
      return method === "GET"
        ? handleIssue(provider, issueIdentifier, snapshotTimeoutMs)
        : methodNotAllowed();
    }

    return notFound();
  };
}

// `/api/v1/:issue_identifier` — a single trailing segment (Phoenix `:param`
// does not span slashes).
function apiV1IssueIdentifier(path: string): string | null {
  const prefix = "/api/v1/";
  if (!path.startsWith(prefix)) {
    return null;
  }
  const rest = path.slice(prefix.length);
  if (rest === "" || rest.includes("/")) {
    return null;
  }
  try {
    return decodeURIComponent(rest);
  } catch {
    // Malformed percent-encoding (e.g. /api/v1/%zz) is an unroutable path,
    // not a server error.
    return null;
  }
}

async function handleState(provider: SnapshotProvider, timeoutMs: number): Promise<Response> {
  return jsonResponse(200, await Presenter.statePayload(provider, timeoutMs));
}

async function handleIssue(
  provider: SnapshotProvider,
  issueIdentifier: string,
  timeoutMs: number,
): Promise<Response> {
  const result = await Presenter.issuePayload(issueIdentifier, provider, timeoutMs);
  if (result.ok) {
    return jsonResponse(200, result.value);
  }
  return errorResponse(404, "issue_not_found", "Issue not found");
}

async function handleRefresh(provider: SnapshotProvider): Promise<Response> {
  const result = await Presenter.refreshPayload(provider);
  if (result.ok) {
    return jsonResponse(202, result.value);
  }
  return errorResponse(503, "orchestrator_unavailable", "Orchestrator is unavailable");
}

function methodNotAllowed(): Response {
  return errorResponse(405, "method_not_allowed", "Method not allowed");
}

function notFound(): Response {
  return errorResponse(404, "not_found", "Route not found");
}

function errorResponse(status: number, code: string, message: string): Response {
  return jsonResponse(status, { error: { code, message } });
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

// ---- HttpServer facade (`http_server.ex`) ----------------------------------

export type ServerOpts = {
  host?: string | null;
  port?: number | null;
  orchestrator?: SnapshotProvider;
  snapshotTimeoutMs?: number;
  handlers?: RouterHandlers;
};

export type StartResult =
  | { kind: "started"; server: ReturnType<typeof Bun.serve> }
  | { kind: "ignore" }
  | { kind: "error"; error: unknown };

export class HttpServer {
  private server: ReturnType<typeof Bun.serve> | null = null;

  // Port of `start_link/1`: `:ignore` when no port is configured, `{:error, _}`
  // on an unresolvable host, otherwise binds and records the bound port.
  start(opts: ServerOpts = {}): StartResult {
    const port = opts.port ?? serverPort();
    if (typeof port !== "number" || !Number.isInteger(port) || port < 0) {
      return { kind: "ignore" };
    }
    const host = opts.host ?? settingsBang().server.host;
    const provider = opts.orchestrator ?? UNAVAILABLE_PROVIDER;
    const snapshotTimeoutMs = opts.snapshotTimeoutMs ?? DEFAULT_SNAPSHOT_TIMEOUT_MS;
    const handlers: RouterHandlers = { staticAsset: serveStaticAsset, ...opts.handlers };
    const fetch = createRouter(provider, snapshotTimeoutMs, handlers);

    try {
      const server = Bun.serve({ hostname: normalizeHost(host), port, fetch });
      this.server = server;
      setBoundPort(server.port ?? null);
      return { kind: "started", server };
    } catch (error) {
      return { kind: "error", error };
    }
  }

  stop(): void {
    if (this.server) {
      this.server.stop(true);
      this.server = null;
    }
    setBoundPort(null);
  }

  boundPort(): number | null {
    return this.server?.port ?? null;
  }
}

function normalizeHost(host: string | null | undefined): string {
  if (host === null || host === undefined || host === "") {
    return "127.0.0.1";
  }
  return host;
}
