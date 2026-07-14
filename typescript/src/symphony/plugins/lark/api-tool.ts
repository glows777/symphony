// The `lark_api` agent-facing dynamic tool, exposed through the Lark plugin's
// agentTools capability (role-equivalent to the Linear plugin's
// `linear_graphql`): agents call Lark OpenAPI endpoints with Symphony's
// configured auth to write back state, update fields, or send messages.
// Requests always target the configured endpoint host and the path must stay
// under /open-apis/, so the tool cannot be steered at arbitrary hosts or
// non-API routes. Protocol encoding stays in codex/dynamic-tool.ts.

import { type Result, err, ok } from "../../result.ts";
import type { AgentToolExecuteOpts, AgentToolOutcome, AgentToolSpec } from "../types.ts";
import { request as clientRequest } from "./client.ts";

export const LARK_API_TOOL = "lark_api";
const LARK_API_PATH_PREFIX = "/open-apis/";
const LARK_API_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;
const LARK_API_DESCRIPTION =
  "Execute a raw Lark (Feishu) OpenAPI request using Symphony's configured auth.\n";
const LARK_API_INPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["method", "path"],
  properties: {
    method: {
      type: "string",
      enum: [...LARK_API_METHODS],
      description: "HTTP method for the OpenAPI call.",
    },
    path: {
      type: "string",
      description:
        "OpenAPI path starting with /open-apis/ (query string allowed); the host is always Symphony's configured Lark endpoint.",
    },
    body: {
      type: ["object", "null"],
      description: "Optional JSON request body.",
      additionalProperties: true,
    },
  },
};

export type LarkApiClientFn = (
  method: string,
  path: string,
  body: Record<string, unknown> | null,
) => Result<unknown, unknown> | Promise<Result<unknown, unknown>>;

export const larkApiToolSpec: AgentToolSpec = {
  name: LARK_API_TOOL,
  description: LARK_API_DESCRIPTION,
  inputSchema: LARK_API_INPUT_SCHEMA,
};

export async function executeLarkApi(
  args: unknown,
  opts: AgentToolExecuteOpts = {},
): Promise<AgentToolOutcome> {
  const larkClient: LarkApiClientFn =
    (opts.larkClient as LarkApiClientFn | undefined) ??
    ((method, path, body) => clientRequest(method, path, body));

  const normalized = normalizeLarkApiArguments(args);
  if (!normalized.ok) {
    return { success: false, payload: toolErrorPayload(normalized.error) };
  }
  const response = await larkClient(
    normalized.value.method,
    normalized.value.path,
    normalized.value.body,
  );
  // Success means HTTP 2xx AND Lark business `code === 0`; the client's
  // request layer already folds both into the Result.
  if (isOkResult(response)) {
    return { success: true, payload: response.value };
  }
  if (isErrResult(response)) {
    return { success: false, payload: toolErrorPayload(response.error) };
  }
  return { success: false, payload: toolErrorPayload(response) };
}

type NormalizedArgs = { method: string; path: string; body: Record<string, unknown> | null };

function normalizeLarkApiArguments(args: unknown): Result<NormalizedArgs, unknown> {
  if (!isObject(args)) {
    return err({ tag: "invalid_arguments" });
  }
  const method = normalizeMethod(args.method);
  if (!method.ok) {
    return err(method.error);
  }
  const path = normalizePath(args.path);
  if (!path.ok) {
    return err(path.error);
  }
  const body = normalizeBody(args.body);
  if (!body.ok) {
    return err(body.error);
  }
  return ok({ method: method.value, path: path.value, body: body.value });
}

function normalizeMethod(method: unknown): Result<string, unknown> {
  if (typeof method !== "string" || method.trim() === "") {
    return err({ tag: "missing_method" });
  }
  const normalized = method.trim().toUpperCase();
  if (!LARK_API_METHODS.includes(normalized as (typeof LARK_API_METHODS)[number])) {
    return err({ tag: "invalid_method" });
  }
  return ok(normalized);
}

function normalizePath(path: unknown): Result<string, unknown> {
  if (typeof path !== "string" || path.trim() === "") {
    return err({ tag: "missing_path" });
  }
  const trimmed = path.trim();
  if (!trimmed.startsWith(LARK_API_PATH_PREFIX)) {
    return err({ tag: "invalid_path" });
  }
  return ok(trimmed);
}

function normalizeBody(body: unknown): Result<Record<string, unknown> | null, unknown> {
  if (body === undefined || body === null) {
    return ok(null);
  }
  if (isObject(body)) {
    return ok(body);
  }
  return err({ tag: "invalid_body" });
}

// Error payload copy follows the linear_graphql tool's four categories:
// argument errors, missing auth, HTTP status, and transport failures.
function toolErrorPayload(reason: unknown): Record<string, unknown> {
  const tag = isObject(reason) ? reason.tag : undefined;
  switch (tag) {
    case "invalid_arguments":
      return {
        error: {
          message: "`lark_api` expects an object with `method`, `path`, and optional `body`.",
        },
      };
    case "missing_method":
      return {
        error: {
          message: "`lark_api` requires a `method` string (GET, POST, PUT, PATCH, or DELETE).",
        },
      };
    case "invalid_method":
      return {
        error: { message: "`lark_api.method` must be one of GET, POST, PUT, PATCH, or DELETE." },
      };
    case "missing_path":
      return { error: { message: "`lark_api` requires a non-empty `path` string." } };
    case "invalid_path":
      return {
        error: {
          message:
            "`lark_api.path` must start with `/open-apis/`; requests always target Symphony's configured Lark endpoint.",
        },
      };
    case "invalid_body":
      return { error: { message: "`lark_api.body` must be a JSON object when provided." } };
    case "missing_lark_app_credentials":
      return {
        error: {
          message:
            "Symphony is missing Lark auth. Set `tracker.app_id`/`tracker.app_secret` in `WORKFLOW.md` or export `LARK_APP_SECRET`.",
        },
      };
    case "lark_api_status":
      return {
        error: {
          message: `Lark API request failed with HTTP ${(reason as { status: number }).status}.`,
          status: (reason as { status: number }).status,
        },
      };
    case "lark_api_error": {
      const detail = (reason as { detail?: { code?: unknown; msg?: unknown } }).detail;
      return {
        error: {
          message: (reason as { message: string }).message,
          code: detail?.code ?? null,
          msg: detail?.msg ?? null,
        },
      };
    }
    case "lark_api_request":
      return {
        error: {
          message: "Lark API request failed before receiving a response.",
          reason: inspectReason((reason as { reason: unknown }).reason),
        },
      };
    default:
      return {
        error: { message: "Lark API tool execution failed.", reason: inspectReason(reason) },
      };
  }
}

// ---- helpers ---------------------------------------------------------------

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isOkResult(value: unknown): value is { ok: true; value: unknown } {
  return isObject(value) && value.ok === true;
}

function isErrResult(value: unknown): value is { ok: false; error: unknown } {
  return isObject(value) && value.ok === false;
}

// Elixir `inspect` of an atom reason (`:timeout`) — strings render `:name`.
function inspectReason(reason: unknown): string {
  if (typeof reason === "string") {
    return `:${reason}`;
  }
  return JSON.stringify(reason) ?? String(reason);
}
