// Literal port of `symphony_elixir/http_server.ex` + `web/endpoint.ex` +
// `web/router.ex` + `web/controllers/observability_api_controller.ex`.
//
// Phoenix endpoint/router/Bandit → `Bun.serve` + a small router (per the rulebook).
// The JSON observability API (`/api/v1/*`) and its 405/404 behavior are
// framework-agnostic and ported literally; `GET /` (dashboard) and the static
// asset routes are delegated to optional handlers wired by later Phase 5 work.

import {
  type AgentOutputEvent,
  type AgentOutputStore,
  getAgentOutputStore,
} from "../agent-output-store.ts";
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
  agentOutputStore?: AgentOutputStore;
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
  const outputStore = handlers.agentOutputStore ?? getAgentOutputStore();
  return async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    const path = url.pathname;
    const method = req.method.toUpperCase();

    if (STATIC_ASSET_PATHS.has(path) || path.startsWith("/assets/")) {
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
      return method === "GET"
        ? handleState(provider, snapshotTimeoutMs, outputStore)
        : methodNotAllowed();
    }

    if (path === "/api/v1/refresh") {
      return method === "POST" ? handleRefresh(provider) : methodNotAllowed();
    }

    const outputRoute = apiV1IssueOutputRoute(path);
    if (outputRoute !== null) {
      if (method !== "GET") {
        return methodNotAllowed();
      }
      const query = outputQuery(url.searchParams);
      if (!query.ok) {
        return errorResponse(400, "invalid_output_query", query.message);
      }
      if (outputRoute.stream) {
        return handleOutputStream(
          provider,
          outputStore,
          outputRoute.issueIdentifier,
          snapshotTimeoutMs,
          query,
        );
      }
      return handleOutput(
        provider,
        outputStore,
        outputRoute.issueIdentifier,
        snapshotTimeoutMs,
        query,
      );
    }

    const issueIdentifier = apiV1IssueIdentifier(path);
    if (issueIdentifier !== null) {
      return method === "GET"
        ? handleIssue(provider, issueIdentifier, snapshotTimeoutMs, outputStore)
        : methodNotAllowed();
    }

    return notFound();
  };
}

function apiV1IssueOutputRoute(path: string): { issueIdentifier: string; stream: boolean } | null {
  const prefix = "/api/v1/";
  if (!path.startsWith(prefix)) {
    return null;
  }
  const rest = path.slice(prefix.length);
  const suffix = rest.endsWith("/output/stream")
    ? "/output/stream"
    : rest.endsWith("/output")
      ? "/output"
      : null;
  if (suffix === null) {
    return null;
  }
  const encodedIdentifier = rest.slice(0, -suffix.length);
  if (encodedIdentifier === "" || encodedIdentifier.includes("/")) {
    return null;
  }
  try {
    return {
      issueIdentifier: decodeURIComponent(encodedIdentifier),
      stream: suffix.endsWith("stream"),
    };
  } catch {
    return null;
  }
}

function outputQuery(
  search: URLSearchParams,
): { ok: true; limit?: number; after?: number | null } | { ok: false; message: string } {
  const limitValue = search.get("limit");
  const afterValue = search.get("after");
  const limit = limitValue === null ? undefined : parseNonNegativeInt(limitValue);
  const after = afterValue === null ? null : parseNonNegativeInt(afterValue);
  if (limitValue !== null && (limit === null || limit === 0)) {
    return { ok: false, message: "limit must be a positive integer" };
  }
  if (afterValue !== null && after === null) {
    return { ok: false, message: "after must be a non-negative integer" };
  }
  if (limit !== undefined && limit !== null && limit > 500) {
    return { ok: false, message: "limit must be at most 500" };
  }
  const result: { ok: true; limit?: number; after?: number | null } = {
    ok: true,
    after: after as number | null,
  };
  if (limit !== undefined) {
    result.limit = limit as number;
  }
  return result;
}

function parseNonNegativeInt(value: string): number | null {
  if (!/^\d+$/.test(value)) {
    return null;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) ? parsed : null;
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
    // not a server error: fall through to 404 instead of throwing a URIError
    // into a 500.
    return null;
  }
}

async function handleState(
  provider: SnapshotProvider,
  timeoutMs: number,
  outputStore: AgentOutputStore,
): Promise<Response> {
  return jsonResponse(200, await Presenter.statePayload(provider, timeoutMs, outputStore));
}

async function handleIssue(
  provider: SnapshotProvider,
  issueIdentifier: string,
  timeoutMs: number,
  outputStore: AgentOutputStore,
): Promise<Response> {
  const result = await Presenter.issuePayload(issueIdentifier, provider, timeoutMs, outputStore);
  if (result.ok) {
    return jsonResponse(200, result.value);
  }
  return errorResponse(404, "issue_not_found", "Issue not found");
}

async function handleOutput(
  provider: SnapshotProvider,
  outputStore: AgentOutputStore,
  issueIdentifier: string,
  timeoutMs: number,
  query: { limit?: number; after?: number | null },
): Promise<Response> {
  const result = await Presenter.outputPayload(
    issueIdentifier,
    provider,
    timeoutMs,
    outputStore,
    query,
  );
  if (result.ok) {
    return jsonResponse(200, result.value);
  }
  return outputErrorResponse(result.error);
}

async function handleOutputStream(
  provider: SnapshotProvider,
  outputStore: AgentOutputStore,
  issueIdentifier: string,
  timeoutMs: number,
  query: { limit?: number; after?: number | null },
): Promise<Response> {
  const result = await Presenter.outputPayload(
    issueIdentifier,
    provider,
    timeoutMs,
    outputStore,
    query,
  );
  if (!result.ok) {
    return outputErrorResponse(result.error);
  }

  let unsubscribe: () => void = () => {};
  let closed = false;
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const close = (): void => {
        if (closed) {
          return;
        }
        closed = true;
        unsubscribe();
        try {
          controller.close();
        } catch {
          // The browser already closed the stream.
        }
      };
      const send = (event: AgentOutputEvent): void => {
        if (closed) {
          return;
        }
        try {
          controller.enqueue(encoder.encode(sseAgentOutput(event)));
          if (event.terminal === true) {
            close();
          }
        } catch {
          close();
        }
      };
      controller.enqueue(encoder.encode(": connected\n\n"));
      unsubscribe = outputStore.subscribe(issueIdentifier, send);
      const body = result.value as {
        events?: AgentOutputEvent[];
        run?: { status?: string } | null;
      };
      const lastEvent = body.events?.at(-1);
      if (lastEvent?.terminal === true) {
        send(lastEvent);
      } else if (body.run?.status !== undefined && body.run.status !== "running") {
        close();
      }
    },
    cancel() {
      closed = true;
      unsubscribe();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    },
  });
}

function sseAgentOutput(event: AgentOutputEvent): string {
  return `event: agent_output\ndata: ${JSON.stringify(event)}\n\n`;
}

function outputErrorResponse(
  error: "issue_not_found" | "snapshot_timeout" | "snapshot_unavailable",
): Response {
  switch (error) {
    case "issue_not_found":
      return errorResponse(404, "issue_not_found", "Issue not found");
    case "snapshot_timeout":
      return errorResponse(504, "snapshot_timeout", "Snapshot timed out");
    case "snapshot_unavailable":
      return errorResponse(503, "snapshot_unavailable", "Snapshot unavailable");
  }
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
  agentOutputStore?: AgentOutputStore;
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
    const handlers: RouterHandlers = {
      staticAsset: serveStaticAsset,
      ...(opts.agentOutputStore === undefined ? {} : { agentOutputStore: opts.agentOutputStore }),
      ...opts.handlers,
    };
    const route = createRouter(provider, snapshotTimeoutMs, handlers);

    try {
      const server = Bun.serve({
        hostname: normalizeHost(host),
        port,
        fetch: (req, server) => {
          // `/events` is a quiet SSE stream between dashboard updates. Bun's
          // default 10-second idle timeout would close it and log a timeout.
          const requestPath = new URL(req.url).pathname;
          if (
            req.method === "GET" &&
            (requestPath === "/events" || requestPath.endsWith("/output/stream"))
          ) {
            server.timeout(req, 0);
          }
          return route(req);
        },
      });
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
