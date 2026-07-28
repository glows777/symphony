// The `gitea_api` agent-facing dynamic tool. It exposes only declared HTTP
// methods and paths under the configured Gitea instance's `/api/v1/` prefix;
// the host and Authorization header always come from the tracker plugin.

import { type Result, err, ok } from "../../../result.ts";
import type { AgentToolExecuteOpts, AgentToolOutcome, AgentToolSpec } from "../types.ts";

export const GITEA_API_TOOL = "gitea_api";
const GITEA_API_PATH_PREFIX = "/api/v1/";
const GITEA_API_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;

const GITEA_API_DESCRIPTION =
  "Execute a raw Gitea API request using Symphony's configured endpoint and token. Paths must stay under /api/v1/.\n";

const GITEA_API_INPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["method", "path"],
  properties: {
    method: {
      type: "string",
      enum: [...GITEA_API_METHODS],
      description: "HTTP method for the Gitea API call.",
    },
    path: {
      type: "string",
      description:
        "Gitea API path starting with /api/v1/ (query string allowed); the host and auth are always configured by Symphony.",
    },
    body: {
      type: ["object", "null"],
      description: "Optional JSON request body.",
      additionalProperties: true,
    },
  },
};

export type GiteaApiClientFn = (
  method: string,
  path: string,
  body: Record<string, unknown> | null,
) => Result<unknown, unknown> | Promise<Result<unknown, unknown>>;

export const giteaApiToolSpec: AgentToolSpec = {
  name: GITEA_API_TOOL,
  description: GITEA_API_DESCRIPTION,
  inputSchema: GITEA_API_INPUT_SCHEMA,
};

export async function executeGiteaApiWith(
  defaultClient: GiteaApiClientFn,
  args: unknown,
  opts: AgentToolExecuteOpts = {},
): Promise<AgentToolOutcome> {
  const giteaClient: GiteaApiClientFn =
    (opts.giteaClient as GiteaApiClientFn | undefined) ?? defaultClient;

  const normalized = normalizeGiteaApiArguments(args);
  if (!normalized.ok) {
    return { success: false, payload: toolErrorPayload(normalized.error) };
  }

  try {
    const response = await giteaClient(
      normalized.value.method,
      normalized.value.path,
      normalized.value.body,
    );
    if (isOkResult(response)) {
      return { success: true, payload: response.value };
    }
    if (isErrResult(response)) {
      return { success: false, payload: toolErrorPayload(response.error) };
    }
    return { success: false, payload: toolErrorPayload(response) };
  } catch (error) {
    return { success: false, payload: toolErrorPayload(error) };
  }
}

type NormalizedArgs = {
  method: string;
  path: string;
  body: Record<string, unknown> | null;
};

function normalizeGiteaApiArguments(args: unknown): Result<NormalizedArgs, unknown> {
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
  if (!GITEA_API_METHODS.includes(normalized as (typeof GITEA_API_METHODS)[number])) {
    return err({ tag: "invalid_method" });
  }
  return ok(normalized);
}

function normalizePath(path: unknown): Result<string, unknown> {
  if (typeof path !== "string" || path.trim() === "") {
    return err({ tag: "missing_path" });
  }
  const trimmed = path.trim();
  if (!trimmed.startsWith(GITEA_API_PATH_PREFIX) || trimmed.includes("\\")) {
    return err({ tag: "invalid_path" });
  }
  const pathname = trimmed.split("?", 1)[0]?.split("#", 1)[0] ?? trimmed;
  if (pathname.split("/").some((segment) => segment === "..")) {
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

function toolErrorPayload(reason: unknown): Record<string, unknown> {
  const tag = isObject(reason) ? reason.tag : undefined;
  switch (tag) {
    case "missing_gitea_api_token":
      return {
        error: {
          message:
            "Symphony is missing Gitea auth. Set `tracker.token` in `WORKFLOW.md` or export `GITEA_API_TOKEN`.",
        },
      };
    case "missing_gitea_endpoint":
    case "missing_gitea_owner":
    case "missing_gitea_repository":
    case "invalid_gitea_endpoint":
      return { error: { message: reasonMessage(reason) } };
    case "gitea_api_status":
      return statusPayload(reason);
    case "gitea_api_request":
      return {
        error: {
          message: "Gitea API request failed before receiving a response.",
          reason: inspectReason((reason as { detail?: { reason?: unknown } }).detail?.reason),
        },
      };
    case "gitea_api_error":
      return {
        error: {
          message: reasonMessage(reason),
          detail: (reason as { detail?: unknown }).detail ?? null,
        },
      };
    case "invalid_arguments":
      return {
        error: {
          message: "`gitea_api` expects an object with `method`, `path`, and optional `body`.",
        },
      };
    case "missing_method":
      return {
        error: {
          message: "`gitea_api` requires a `method` string (GET, POST, PUT, PATCH, or DELETE).",
        },
      };
    case "invalid_method":
      return {
        error: { message: "`gitea_api.method` must be one of GET, POST, PUT, PATCH, or DELETE." },
      };
    case "missing_path":
      return { error: { message: "`gitea_api` requires a non-empty `path` string." } };
    case "invalid_path":
      return {
        error: {
          message:
            "`gitea_api.path` must start with `/api/v1/`; requests always target the configured Gitea endpoint.",
        },
      };
    case "invalid_body":
      return { error: { message: "`gitea_api.body` must be a JSON object when provided." } };
    default:
      return requestErrorPayload(reason);
  }
}

function requestErrorPayload(reason: unknown): Record<string, unknown> {
  const code = isObject(reason) ? reason.code : undefined;
  switch (code) {
    case "missing_credentials":
      return toolErrorPayload({ tag: "missing_gitea_api_token" });
    case "provider_status":
      return statusPayload(reason);
    case "provider_error":
      return {
        error: {
          message: reasonMessage(reason),
          detail: (reason as { detail?: unknown }).detail ?? null,
        },
      };
    case "transport_failed":
      return {
        error: {
          message: "Gitea API request failed before receiving a response.",
          reason: inspectReason((reason as { detail?: { reason?: unknown } }).detail?.reason),
        },
      };
    default:
      return {
        error: { message: "Gitea API tool execution failed.", reason: inspectReason(reason) },
      };
  }
}

function statusPayload(reason: unknown): Record<string, unknown> {
  const status = isObject(reason) ? reason.status : undefined;
  const detail = isObject(reason) ? reason.detail : undefined;
  return {
    error: {
      message: reasonMessage(reason),
      status: typeof status === "number" ? status : isObject(detail) ? detail.status : null,
      detail: detail ?? null,
    },
  };
}

function reasonMessage(reason: unknown): string {
  return isObject(reason) && typeof reason.message === "string"
    ? reason.message
    : "Gitea API tool execution failed.";
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isOkResult(value: unknown): value is { ok: true; value: unknown } {
  return isObject(value) && value.ok === true;
}

function isErrResult(value: unknown): value is { ok: false; error: unknown } {
  return isObject(value) && value.ok === false;
}

function inspectReason(reason: unknown): string {
  if (reason === undefined) {
    return "null";
  }
  if (typeof reason === "string") {
    return `:${reason}`;
  }
  return JSON.stringify(reason) ?? String(reason);
}
