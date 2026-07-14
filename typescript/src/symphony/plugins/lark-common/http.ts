// Lark (Feishu) OpenAPI transport shared by the lark-family plugins (Bitable
// `lark`, task-center `lark-task`). Everything here is resource-agnostic:
// tenant_access_token lifecycle, the authenticated request layer (HTTP 2xx +
// business `code === 0` folded into one Result), and the small JSON helpers
// both clients use for payload traversal.
//
// Auth is a short-lived tenant_access_token (~2h): tokens are cached
// module-level per (endpoint, app_id) with a refresh margin, and the cache
// entry is dropped + re-acquired once when a request reports an invalid
// token. Tests inject a fake transport via the `requestFun` option and reset
// the cache through `resetTokenCacheForTest` (wired into teardownWorkflow).
//
// Error tags are plugin-owned (`lark_api_status` vs `lark_task_api_status`,
// ...): each plugin builds its own `LarkApiErrorSet` via `larkApiErrorSet`,
// so the shared layer stays out of the tag namespace while the normalized
// `code` categories (the only thing core code switches on) are identical.

import { logger } from "../../logger.ts";
import { type Result, err, ok } from "../../result.ts";
import type { TrackerError } from "../types.ts";

const TENANT_TOKEN_PATH = "/open-apis/auth/v3/tenant_access_token/internal";
const TOKEN_REFRESH_MARGIN_MS = 5 * 60_000;
const MAX_ERROR_BODY_LOG_BYTES = 1_000;

// Lark business codes signalling an expired/invalid access token; the request
// layer treats them (and HTTP 401) as "drop the cached token and retry once".
const TOKEN_INVALID_CODES: ReadonlySet<number> = new Set([99991661, 99991663]);

export type JsonObject = Record<string, unknown>;
export type RequestResponse = { status: number; body: unknown };
export type RequestFun = (
  method: string,
  url: string,
  headers: Record<string, string>,
  body: JsonObject | null,
) => Result<RequestResponse, unknown> | Promise<Result<RequestResponse, unknown>>;
export type RequestOpts = { requestFun?: RequestFun };

// The slice of a plugin's settings the transport needs (both lark-family
// plugins claim the same endpoint/app_id/app_secret config keys).
export type LarkAuth = { endpoint: string; appId: string | null; appSecret: string | null };

// Plugin-owned error constructors. `status`/`transport` keep their raw
// payloads top-level (`status`, `reason`) mirroring the Linear plugin's
// legacy error shapes; `api` carries the Lark business code/msg in `detail`.
export type LarkApiErrorSet = {
  missingCredentials(): TrackerError;
  status(status: number): TrackerError & { status: number };
  api(code: number, msg: unknown): TrackerError;
  transport(reason: unknown): TrackerError & { reason: unknown };
  unknownPayload(): TrackerError;
};

// Builds the standard error set for a tag prefix (`lark` -> `lark_api_status`,
// `lark_api_error`, `lark_api_request`, `lark_unknown_payload`; `lark_task`
// -> the `lark_task_*` equivalents). The missing-credentials error is passed
// in whole because its tag does not follow the prefix pattern.
export function larkApiErrorSet(
  tagPrefix: string,
  missingCredentials: () => TrackerError,
): LarkApiErrorSet {
  return {
    missingCredentials,
    status: (status: number) => ({
      tag: `${tagPrefix}_api_status`,
      code: "provider_status",
      message: `Lark API request failed with HTTP ${status}`,
      status,
    }),
    api: (code: number, msg: unknown) => {
      const suffix = typeof msg === "string" && msg !== "" ? `: ${msg}` : "";
      return {
        tag: `${tagPrefix}_api_error`,
        code: "provider_error",
        message: `Lark API returned error code ${code}${suffix}`,
        detail: { code, msg: typeof msg === "string" ? msg : null },
      };
    },
    transport: (reason: unknown) => ({
      tag: `${tagPrefix}_api_request`,
      code: "transport_failed",
      message: "Lark API request failed before receiving a response",
      reason,
    }),
    unknownPayload: () => ({
      tag: `${tagPrefix}_unknown_payload`,
      code: "invalid_payload",
      message: "Lark API response had an unexpected shape",
    }),
  };
}

// Per-call context: fresh auth (settings re-parse on every read) plus the
// calling plugin's error constructors.
export type LarkApiContext = { auth: LarkAuth; errors: LarkApiErrorSet };

// ---- token cache -------------------------------------------------------------

const tokenCache = new Map<string, { token: string; expiresAt: number }>();

export function resetTokenCacheForTest(): void {
  tokenCache.clear();
}

function tokenCacheKey(auth: LarkAuth): string {
  return `${auth.endpoint}|${auth.appId}`;
}

// ---- authenticated OpenAPI request ---------------------------------------------

// Sends one authenticated request against the configured Lark endpoint.
// Success means HTTP 2xx AND Lark business `code === 0`; the full response
// body is returned so callers keep `data`/`msg` context.
export async function request(
  ctx: LarkApiContext,
  method: string,
  path: string,
  body: JsonObject | null = null,
  opts: RequestOpts = {},
): Promise<Result<unknown, TrackerError>> {
  const requestFun = opts.requestFun ?? httpRequest;
  return doRequest(ctx, method, path, body, requestFun, true);
}

async function doRequest(
  ctx: LarkApiContext,
  method: string,
  path: string,
  body: JsonObject | null,
  requestFun: RequestFun,
  retryOnInvalidToken: boolean,
): Promise<Result<unknown, TrackerError>> {
  const token = await tenantAccessToken(ctx, requestFun);
  if (!token.ok) {
    return err(token.error);
  }
  const response = await requestFun(
    method,
    `${ctx.auth.endpoint}${path}`,
    authHeaders(token.value),
    body,
  );
  if (!response.ok) {
    logger.error(`Lark API request failed: ${inspect(response.error)}`);
    return err(ctx.errors.transport(response.error));
  }
  const { status, body: responseBody } = response.value;
  if (retryOnInvalidToken && tokenInvalid(status, responseBody)) {
    tokenCache.delete(tokenCacheKey(ctx.auth));
    return doRequest(ctx, method, path, body, requestFun, false);
  }
  if (status < 200 || status >= 300) {
    logger.error(
      `Lark API request failed status=${status} path=${path} body=${summarizeErrorBody(responseBody)}`,
    );
    return err(ctx.errors.status(status));
  }
  return decodeLarkBody(ctx, responseBody);
}

function decodeLarkBody(ctx: LarkApiContext, body: unknown): Result<JsonObject, TrackerError> {
  if (!isObject(body) || typeof body.code !== "number") {
    return err(ctx.errors.unknownPayload());
  }
  if (body.code !== 0) {
    return err(ctx.errors.api(body.code, body.msg));
  }
  return ok(body);
}

// ---- tenant_access_token lifecycle ---------------------------------------------

async function tenantAccessToken(
  ctx: LarkApiContext,
  requestFun: RequestFun,
): Promise<Result<string, TrackerError>> {
  const { auth } = ctx;
  if (auth.appId === null || auth.appSecret === null) {
    return err(ctx.errors.missingCredentials());
  }
  const cacheKey = tokenCacheKey(auth);
  const now = Date.now();
  const cached = tokenCache.get(cacheKey);
  if (cached !== undefined && now < cached.expiresAt - TOKEN_REFRESH_MARGIN_MS) {
    return ok(cached.token);
  }
  const response = await requestFun(
    "POST",
    `${auth.endpoint}${TENANT_TOKEN_PATH}`,
    { "Content-Type": "application/json" },
    { app_id: auth.appId, app_secret: auth.appSecret },
  );
  if (!response.ok) {
    logger.error(`Lark tenant_access_token request failed: ${inspect(response.error)}`);
    return err(ctx.errors.transport(response.error));
  }
  const { status, body } = response.value;
  if (status < 200 || status >= 300) {
    logger.error(
      `Lark tenant_access_token request failed status=${status} body=${summarizeErrorBody(body)}`,
    );
    return err(ctx.errors.status(status));
  }
  const decoded = decodeLarkBody(ctx, body);
  if (!decoded.ok) {
    return err(decoded.error);
  }
  const token = decoded.value.tenant_access_token;
  if (typeof token !== "string" || token === "") {
    return err(ctx.errors.unknownPayload());
  }
  const expire = decoded.value.expire;
  // Missing/invalid expire caches nothing (`expiresAt` in the past forces a
  // refetch on the next call once the margin is applied).
  const expiresAt = typeof expire === "number" && expire > 0 ? now + expire * 1_000 : now;
  tokenCache.set(cacheKey, { token, expiresAt });
  return ok(token);
}

function tokenInvalid(status: number, body: unknown): boolean {
  if (status === 401) {
    return true;
  }
  return isObject(body) && typeof body.code === "number" && TOKEN_INVALID_CODES.has(body.code);
}

function authHeaders(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
}

// ---- URLs -----------------------------------------------------------------------

// User-facing base URLs live on the tenant domain, not the OpenAPI host;
// strip the `open.` prefix (open.feishu.cn -> feishu.cn).
export function webDomain(endpoint: string): string | null {
  try {
    const host = new URL(endpoint).host;
    return host.startsWith("open.") ? host.slice("open.".length) : host;
  } catch {
    return null;
  }
}

// ---- transport ------------------------------------------------------------------

async function httpRequest(
  method: string,
  url: string,
  headers: Record<string, string>,
  body: JsonObject | null,
): Promise<Result<RequestResponse, unknown>> {
  try {
    const response = await fetch(url, {
      method,
      headers,
      body: body === null ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
    const parsed = await response.json();
    return ok({ status: response.status, body: parsed });
  } catch (error) {
    return err(error);
  }
}

// ---- shared JSON helpers ----------------------------------------------------------

export function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function asObject(value: unknown): JsonObject | null {
  return isObject(value) ? value : null;
}

export function getIn(value: unknown, keys: string[]): unknown {
  let current: unknown = value;
  for (const key of keys) {
    if (!isObject(current)) {
      return undefined;
    }
    current = current[key];
  }
  return current;
}

export function stringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

// Lark timestamps are epoch milliseconds, delivered as numbers (Bitable
// record metadata) or numeric strings (task-center `created_at`/`updated_at`).
export function parseTimestamp(value: unknown): Date | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return new Date(value);
  }
  if (typeof value === "string" && /^\d+$/.test(value)) {
    return new Date(Number.parseInt(value, 10));
  }
  return null;
}

function summarizeErrorBody(body: unknown): string {
  const rendered = typeof body === "string" ? body.replace(/\s+/g, " ").trim() : inspect(body);
  if (Buffer.byteLength(rendered, "utf8") > MAX_ERROR_BODY_LOG_BYTES) {
    return `${rendered.slice(0, MAX_ERROR_BODY_LOG_BYTES)}...<truncated>`;
  }
  return rendered;
}

export function inspect(value: unknown): string {
  if (typeof value === "string") {
    return JSON.stringify(value);
  }
  return JSON.stringify(value) ?? String(value);
}
