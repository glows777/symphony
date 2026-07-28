// The `gitea_api` agent-facing dynamic tool. It exposes only the configured
// repository's issue, comment, label, and state routes; the host and
// Authorization header always come from the tracker plugin.

import { type Result, err, ok } from "../../../result.ts";
import type { AgentToolExecuteOpts, AgentToolOutcome, AgentToolSpec } from "../types.ts";

export const GITEA_API_TOOL = "gitea_api";
const GITEA_API_PATH_PREFIX = "/api/v1/";
const GITEA_API_METHODS = ["GET", "POST", "PUT", "PATCH"] as const;
const PATH_VALIDATION_ORIGIN = "https://symphony.invalid";

const GITEA_API_DESCRIPTION =
  "Execute a constrained Gitea issue API request for the configured repository. Only issue, comment, label, and state routes are permitted.\n";

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
        "Gitea API path for the configured repository; the host, repository, and auth are always configured by Symphony.",
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

export type GiteaApiRepository = { owner: string; repo: string };

export const giteaApiToolSpec: AgentToolSpec = {
  name: GITEA_API_TOOL,
  description: GITEA_API_DESCRIPTION,
  inputSchema: GITEA_API_INPUT_SCHEMA,
};

export async function executeGiteaApiWith(
  defaultClient: GiteaApiClientFn,
  args: unknown,
  repository: GiteaApiRepository | null,
  opts: AgentToolExecuteOpts = {},
): Promise<AgentToolOutcome> {
  const giteaClient: GiteaApiClientFn =
    (opts.giteaClient as GiteaApiClientFn | undefined) ?? defaultClient;

  const normalized = normalizeGiteaApiArguments(args, repository);
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

function normalizeGiteaApiArguments(
  args: unknown,
  repository: GiteaApiRepository | null,
): Result<NormalizedArgs, unknown> {
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
  const route = validateRoute(method.value, path.value, body.value, repository);
  if (!route.ok) {
    return err(route.error);
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
  try {
    const parsed = new URL(trimmed, PATH_VALIDATION_ORIGIN);
    if (
      parsed.origin !== PATH_VALIDATION_ORIGIN ||
      !isSafeApiPathname(parsed.pathname, GITEA_API_PATH_PREFIX)
    ) {
      return err({ tag: "invalid_path" });
    }
  } catch {
    return err({ tag: "invalid_path" });
  }
  return ok(trimmed);
}

function validateRoute(
  method: string,
  path: string,
  body: Record<string, unknown> | null,
  repository: GiteaApiRepository | null,
): Result<undefined, unknown> {
  if (repository === null || repository.owner.trim() === "" || repository.repo.trim() === "") {
    return err({ tag: "missing_gitea_api_repository" });
  }
  const parsed = new URL(path, PATH_VALIDATION_ORIGIN);
  const repoPath = `${GITEA_API_PATH_PREFIX}repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.repo)}`;
  const issueCollectionPath = `${repoPath}/issues`;
  const issuePath = new RegExp(`^${escapeRegExp(issueCollectionPath)}/[1-9]\\d*$`);
  const commentsPath = new RegExp(`^${escapeRegExp(issueCollectionPath)}/[1-9]\\d*/comments$`);
  const labelsPath = new RegExp(`^${escapeRegExp(issueCollectionPath)}/[1-9]\\d*/labels$`);

  const allowed =
    (parsed.pathname === `${repoPath}/labels` && method === "GET" && body === null) ||
    (parsed.pathname === issueCollectionPath && method === "GET" && body === null) ||
    (issuePath.test(parsed.pathname) &&
      ((method === "GET" && body === null) || (method === "PATCH" && isStateBody(body)))) ||
    (commentsPath.test(parsed.pathname) &&
      ((method === "GET" && body === null) || (method === "POST" && isCommentBody(body)))) ||
    (labelsPath.test(parsed.pathname) &&
      ((method === "GET" && body === null) || (method === "PUT" && isLabelsBody(body))));

  return allowed
    ? ok(undefined)
    : err({ tag: "invalid_gitea_api_route", detail: { method, path } });
}

function isStateBody(body: Record<string, unknown> | null): boolean {
  return (
    body !== null &&
    hasOnlyKeys(body, ["state"]) &&
    (body.state === "open" || body.state === "closed")
  );
}

function isCommentBody(body: Record<string, unknown> | null): boolean {
  return (
    body !== null &&
    hasOnlyKeys(body, ["body"]) &&
    typeof body.body === "string" &&
    body.body.trim() !== ""
  );
}

function isLabelsBody(body: Record<string, unknown> | null): boolean {
  return (
    body !== null &&
    hasOnlyKeys(body, ["labels"]) &&
    Array.isArray(body.labels) &&
    body.labels.every(
      (label) =>
        (typeof label === "string" && label.trim() !== "") ||
        (typeof label === "number" && Number.isInteger(label) && label >= 0),
    )
  );
}

function hasOnlyKeys(value: Record<string, unknown>, keys: string[]): boolean {
  const allowed = new Set(keys);
  return (
    Object.keys(value).every((key) => allowed.has(key)) && Object.keys(value).length === keys.length
  );
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\\]\\]/g, "\\$&");
}

function isSafeApiPathname(pathname: string, prefix: string): boolean {
  if (!pathname.startsWith(prefix)) {
    return false;
  }
  let decoded = pathname;
  try {
    // URL normalizes one level of dot segments. Decode twice as well so a
    // doubly-encoded traversal cannot be delegated to a downstream router.
    for (let depth = 0; depth < 2; depth += 1) {
      const next = decodeURIComponent(decoded);
      if (next === decoded) {
        break;
      }
      decoded = next;
    }
  } catch {
    return false;
  }
  return (
    !decoded.includes("\\") &&
    !decoded.includes("\0") &&
    !decoded.split("/").some((segment) => segment === "." || segment === "..")
  );
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
    case "missing_gitea_api_repository":
    case "invalid_gitea_endpoint":
      return { error: { message: reasonMessage(reason) } };
    case "invalid_gitea_api_route":
      return {
        error: {
          message:
            "`gitea_api` only permits configured-repository issue, comment, label, and state routes with their supported request bodies.",
          detail: (reason as { detail?: unknown }).detail ?? null,
        },
      };
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
          message: "`gitea_api` requires a `method` string (GET, POST, PUT, or PATCH).",
        },
      };
    case "invalid_method":
      return {
        error: { message: "`gitea_api.method` must be one of GET, POST, PUT, or PATCH." },
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
