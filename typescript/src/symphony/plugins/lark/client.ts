// Lark (Feishu) Bitable HTTP client. Work items are records in one Bitable
// table; the three tracker reads map onto records/search (server-side state
// filter + pagination) and records/batch_get (batched id refresh). Unlike
// Linear's static API key, Lark auth is a short-lived tenant_access_token
// (~2h): the token is cached module-level with a refresh margin and the
// cache is dropped + re-acquired once when a request reports an invalid
// token. Tests inject a fake transport via the `requestFun` option and reset
// the cache through `resetTokenCacheForTest` (wired into teardownWorkflow).

import { settingsBang } from "../../config.ts";
import { logger } from "../../logger.ts";
import { type Result, err, ok } from "../../result.ts";
import type { TrackerError } from "../types.ts";
import { type Issue, newIssue } from "../work-item.ts";
import { type LarkSettings, larkSettings } from "./settings.ts";

const TENANT_TOKEN_PATH = "/open-apis/auth/v3/tenant_access_token/internal";
const SEARCH_PAGE_SIZE = 500; // records/search hard page cap
const BATCH_GET_LIMIT = 100; // records/batch_get hard record_ids cap
const TOKEN_REFRESH_MARGIN_MS = 5 * 60_000;
const MAX_ERROR_BODY_LOG_BYTES = 1_000;

// Lark business codes signalling an expired/invalid access token; the request
// layer treats them (and HTTP 401) as "drop the cached token and retry once".
const TOKEN_INVALID_CODES: ReadonlySet<number> = new Set([99991661, 99991663]);

type JsonObject = Record<string, unknown>;
type RequestResponse = { status: number; body: unknown };
export type RequestFun = (
  method: string,
  url: string,
  headers: Record<string, string>,
  body: JsonObject | null,
) => Result<RequestResponse, unknown> | Promise<Result<RequestResponse, unknown>>;
export type RequestOpts = { requestFun?: RequestFun };

// A configured `tracker.assignee` open_id (the app identity has no viewer
// concept, so unlike Linear there is no "me" resolution).
type AssigneeFilter = string | null;

// ---- token cache -------------------------------------------------------------

let tokenCache: { token: string; expiresAt: number } | null = null;

export function resetTokenCacheForTest(): void {
  tokenCache = null;
}

// ---- required reads ----------------------------------------------------------

export async function fetchCandidateIssues(
  opts: RequestOpts = {},
): Promise<Result<Issue[], TrackerError>> {
  const settings = settingsBang();
  const lark = larkSettings(settings);
  const table = requireTable(lark);
  if (!table.ok) {
    return err(table.error);
  }
  return searchByStates(lark, settings.tracker.activeStates, routingAssigneeFilter(lark), opts);
}

export async function fetchIssuesByStates(
  stateNames: string[],
  opts: RequestOpts = {},
): Promise<Result<Issue[], TrackerError>> {
  const normalizedStates = [...new Set(stateNames.map(String))];
  if (normalizedStates.length === 0) {
    return ok([]);
  }
  const lark = larkSettings(settingsBang());
  const table = requireTable(lark);
  if (!table.ok) {
    return err(table.error);
  }
  return searchByStates(lark, normalizedStates, null, opts);
}

export async function fetchIssueStatesByIds(
  recordIds: string[],
  opts: RequestOpts = {},
): Promise<Result<Issue[], TrackerError>> {
  const ids = [...new Set(recordIds)];
  if (ids.length === 0) {
    return ok([]);
  }
  const lark = larkSettings(settingsBang());
  const table = requireTable(lark);
  if (!table.ok) {
    return err(table.error);
  }
  return batchGetByIds(lark, ids, routingAssigneeFilter(lark), opts);
}

// ---- authenticated OpenAPI request (shared with the lark_api agent tool) -------

// Sends one authenticated request against the configured Lark endpoint.
// Success means HTTP 2xx AND Lark business `code === 0`; the full response
// body is returned so callers keep `data`/`msg` context.
export async function request(
  method: string,
  path: string,
  body: JsonObject | null = null,
  opts: RequestOpts = {},
): Promise<Result<unknown, TrackerError>> {
  const requestFun = opts.requestFun ?? httpRequest;
  return doRequest(method, path, body, requestFun, true);
}

async function doRequest(
  method: string,
  path: string,
  body: JsonObject | null,
  requestFun: RequestFun,
  retryOnInvalidToken: boolean,
): Promise<Result<unknown, TrackerError>> {
  const lark = larkSettings(settingsBang());
  const token = await tenantAccessToken(lark, requestFun);
  if (!token.ok) {
    return err(token.error);
  }
  const response = await requestFun(
    method,
    `${lark.endpoint}${path}`,
    authHeaders(token.value),
    body,
  );
  if (!response.ok) {
    logger.error(`Lark API request failed: ${inspect(response.error)}`);
    return err(transportError(response.error));
  }
  const { status, body: responseBody } = response.value;
  if (retryOnInvalidToken && tokenInvalid(status, responseBody)) {
    tokenCache = null;
    return doRequest(method, path, body, requestFun, false);
  }
  if (status < 200 || status >= 300) {
    logger.error(
      `Lark API request failed status=${status} path=${path} body=${summarizeErrorBody(responseBody)}`,
    );
    return err(statusError(status));
  }
  return decodeLarkBody(responseBody);
}

function decodeLarkBody(body: unknown): Result<JsonObject, TrackerError> {
  if (!isObject(body) || typeof body.code !== "number") {
    return err(unknownPayloadError());
  }
  if (body.code !== 0) {
    return err(apiError(body.code, body.msg));
  }
  return ok(body);
}

// ---- tenant_access_token lifecycle ---------------------------------------------

async function tenantAccessToken(
  lark: LarkSettings,
  requestFun: RequestFun,
): Promise<Result<string, TrackerError>> {
  if (lark.appId === null || lark.appSecret === null) {
    return err(missingCredentialsError());
  }
  const now = Date.now();
  if (tokenCache !== null && now < tokenCache.expiresAt - TOKEN_REFRESH_MARGIN_MS) {
    return ok(tokenCache.token);
  }
  const response = await requestFun(
    "POST",
    `${lark.endpoint}${TENANT_TOKEN_PATH}`,
    { "Content-Type": "application/json" },
    { app_id: lark.appId, app_secret: lark.appSecret },
  );
  if (!response.ok) {
    logger.error(`Lark tenant_access_token request failed: ${inspect(response.error)}`);
    return err(transportError(response.error));
  }
  const { status, body } = response.value;
  if (status < 200 || status >= 300) {
    logger.error(
      `Lark tenant_access_token request failed status=${status} body=${summarizeErrorBody(body)}`,
    );
    return err(statusError(status));
  }
  const decoded = decodeLarkBody(body);
  if (!decoded.ok) {
    return err(decoded.error);
  }
  const token = decoded.value.tenant_access_token;
  if (typeof token !== "string" || token === "") {
    return err(unknownPayloadError());
  }
  const expire = decoded.value.expire;
  // Missing/invalid expire caches nothing (`expiresAt` in the past forces a
  // refetch on the next call once the margin is applied).
  const expiresAt = typeof expire === "number" && expire > 0 ? now + expire * 1_000 : now;
  tokenCache = { token, expiresAt };
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

// ---- records/search (state-filtered, paginated) ---------------------------------

async function searchByStates(
  lark: LarkSettings,
  stateNames: string[],
  assigneeFilter: AssigneeFilter,
  opts: RequestOpts,
): Promise<Result<Issue[], TrackerError>> {
  if (stateNames.length === 0) {
    return ok([]);
  }
  return searchPage(lark, stateNames, assigneeFilter, opts, null, []);
}

async function searchPage(
  lark: LarkSettings,
  stateNames: string[],
  assigneeFilter: AssigneeFilter,
  opts: RequestOpts,
  pageToken: string | null,
  accIssues: Issue[],
): Promise<Result<Issue[], TrackerError>> {
  const table = requireTable(lark);
  if (!table.ok) {
    return err(table.error);
  }
  const query =
    pageToken === null
      ? `?page_size=${SEARCH_PAGE_SIZE}`
      : `?page_size=${SEARCH_PAGE_SIZE}&page_token=${encodeURIComponent(pageToken)}`;
  const response = await request(
    "POST",
    `${tablePath(table.value)}/records/search${query}`,
    {
      filter: buildStateFilter(lark.fieldState, stateNames),
      field_names: searchFieldNames(lark),
      automatic_fields: true,
    },
    opts,
  );
  if (!response.ok) {
    return err(response.error);
  }
  const data = getIn(response.value, ["data"]);
  const items = getIn(data, ["items"]);
  const records = Array.isArray(items) ? items : [];
  const issues = records
    .map((record) => normalizeRecord(asObject(record), lark, assigneeFilter))
    .filter((issue): issue is Issue => issue !== null);
  const updatedAcc = accIssues.concat(issues);

  if (getIn(data, ["has_more"]) !== true) {
    return ok(updatedAcc);
  }
  const nextToken = getIn(data, ["page_token"]);
  if (typeof nextToken !== "string" || nextToken === "") {
    return err({
      tag: "lark_missing_page_token",
      code: "invalid_payload",
      message: "Lark records/search pagination response is missing page_token",
    });
  }
  return searchPage(lark, stateNames, assigneeFilter, opts, nextToken, updatedAcc);
}

// Single-select fields carry the full state vocabulary; multi-state matching
// uses `conjunction: "or"` over one `is` condition per state (condition
// values are string arrays in the Bitable filter grammar).
function buildStateFilter(stateFieldName: string, stateNames: string[]): JsonObject {
  return {
    conjunction: "or",
    conditions: stateNames.map((state) => ({
      field_name: stateFieldName,
      operator: "is",
      value: [state],
    })),
  };
}

function searchFieldNames(lark: LarkSettings): string[] {
  const names = [
    lark.fieldTitle,
    lark.fieldState,
    lark.fieldDescription,
    lark.fieldLabels,
    lark.fieldAssignee,
  ];
  if (lark.fieldIdentifier !== null) {
    names.push(lark.fieldIdentifier);
  }
  if (lark.fieldPriority !== null) {
    names.push(lark.fieldPriority);
  }
  return [...new Set(names)];
}

// ---- records/batch_get (id refresh) ----------------------------------------------

async function batchGetByIds(
  lark: LarkSettings,
  recordIds: string[],
  assigneeFilter: AssigneeFilter,
  opts: RequestOpts,
): Promise<Result<Issue[], TrackerError>> {
  const table = requireTable(lark);
  if (!table.ok) {
    return err(table.error);
  }
  const orderIndex = new Map(recordIds.map((id, index) => [id, index]));
  const accIssues: Issue[] = [];
  for (let offset = 0; offset < recordIds.length; offset += BATCH_GET_LIMIT) {
    const batchIds = recordIds.slice(offset, offset + BATCH_GET_LIMIT);
    const response = await request(
      "POST",
      `${tablePath(table.value)}/records/batch_get`,
      { record_ids: batchIds, automatic_fields: true, with_shared_url: false },
      opts,
    );
    if (!response.ok) {
      return err(response.error);
    }
    // Deleted records surface via `absent_record_ids` and are simply not
    // returned, matching the Linear by-ids semantics.
    const records = getIn(response.value, ["data", "records"]);
    if (Array.isArray(records)) {
      for (const record of records) {
        const issue = normalizeRecord(asObject(record), lark, assigneeFilter);
        if (issue !== null) {
          accIssues.push(issue);
        }
      }
    }
  }
  return ok(sortIssuesByRequestedIds(accIssues, orderIndex));
}

function sortIssuesByRequestedIds(issues: Issue[], orderIndex: Map<string, number>): Issue[] {
  const fallback = orderIndex.size;
  const rank = (issue: Issue): number =>
    issue.id !== null ? (orderIndex.get(issue.id) ?? fallback) : fallback;
  return [...issues].sort((a, b) => rank(a) - rank(b));
}

// ---- record normalization ---------------------------------------------------------

// Bitable field values are polymorphic across field types (plain strings,
// `{text, ...}` option objects, text-segment arrays, person arrays); the
// helpers below accept every documented shape and degrade to null.
function normalizeRecord(
  record: JsonObject | null,
  lark: LarkSettings,
  assigneeFilter: AssigneeFilter,
): Issue | null {
  if (record === null) {
    return null;
  }
  const recordId = stringOrNull(record.record_id);
  const fields = asObject(record.fields) ?? {};
  const identifier =
    lark.fieldIdentifier !== null
      ? (normalizeText(fields[lark.fieldIdentifier]) ?? recordId)
      : recordId;
  const personIds = extractPersonIds(fields[lark.fieldAssignee]);
  return newIssue({
    id: recordId,
    identifier,
    title: normalizeText(fields[lark.fieldTitle]),
    description: normalizeText(fields[lark.fieldDescription]),
    priority: lark.fieldPriority !== null ? parsePriority(fields[lark.fieldPriority]) : null,
    state: normalizeText(fields[lark.fieldState]),
    url: recordUrl(lark, recordId),
    assigneeId: personIds[0] ?? null,
    // Blocking link fields are not mapped in v1: empty blockedBy disables
    // the orchestrator's blocking gate (contract-sanctioned degradation).
    blockedBy: [],
    labels: extractLabels(fields[lark.fieldLabels]),
    assignedToWorker: assignedToWorker(personIds, assigneeFilter),
    createdAt: parseTimestamp(record.created_time),
    updatedAt: parseTimestamp(record.last_modified_time),
    metadata: {
      app_token: lark.appToken,
      table_id: lark.tableId,
      record_id: recordId,
    },
  });
}

// Flattens the value shapes Bitable uses for text-ish fields: plain strings,
// numbers (autonumber), `{text, ...}` option objects, and text-segment
// arrays. Blank results normalize to null.
function normalizeText(value: unknown): string | null {
  const text = flattenText(value);
  if (text === null || text.trim() === "") {
    return null;
  }
  return text;
}

function flattenText(value: unknown): string | null {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number") {
    return String(value);
  }
  if (Array.isArray(value)) {
    const segments = value.map(flattenText).filter((seg): seg is string => seg !== null);
    return segments.length === 0 ? null : segments.join("");
  }
  if (isObject(value) && "text" in value) {
    return flattenText(value.text);
  }
  return null;
}

function extractLabels(value: unknown): string[] {
  const entries = Array.isArray(value)
    ? value
    : value === undefined || value === null
      ? []
      : [value];
  return entries
    .map(flattenText)
    .filter((name): name is string => typeof name === "string")
    .map((name) => name.trim().toLowerCase())
    .filter((name) => name !== "");
}

// Person fields are arrays of `{id, name, ...}` member objects.
function extractPersonIds(value: unknown): string[] {
  const entries = Array.isArray(value) ? value : isObject(value) ? [value] : [];
  return entries
    .map((entry) => (isObject(entry) ? entry.id : null))
    .filter((id): id is string => typeof id === "string" && id !== "");
}

function assignedToWorker(personIds: string[], assigneeFilter: AssigneeFilter): boolean {
  if (assigneeFilter === null) {
    return true;
  }
  return personIds.includes(assigneeFilter);
}

function routingAssigneeFilter(lark: LarkSettings): AssigneeFilter {
  if (lark.assignee === null) {
    return null;
  }
  const trimmed = lark.assignee.trim();
  return trimmed === "" ? null : trimmed;
}

function parsePriority(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isInteger(value) ? value : null;
  }
  const text = flattenText(value)?.trim();
  if (text !== undefined && /^-?\d+$/.test(text)) {
    return Number.parseInt(text, 10);
  }
  return null;
}

function parseTimestamp(value: unknown): Date | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return new Date(value);
  }
  if (typeof value === "string" && /^\d+$/.test(value)) {
    return new Date(Number.parseInt(value, 10));
  }
  return null;
}

// ---- URLs -----------------------------------------------------------------------

// User-facing base URLs live on the tenant domain, not the OpenAPI host;
// strip the `open.` prefix (open.feishu.cn -> feishu.cn).
function webDomain(endpoint: string): string | null {
  try {
    const host = new URL(endpoint).host;
    return host.startsWith("open.") ? host.slice("open.".length) : host;
  } catch {
    return null;
  }
}

export function tableUrl(lark: LarkSettings): string | null {
  const domain = webDomain(lark.endpoint);
  if (domain === null || lark.appToken === null || lark.tableId === null) {
    return null;
  }
  return `https://${domain}/base/${lark.appToken}?table=${lark.tableId}`;
}

function recordUrl(lark: LarkSettings, recordId: string | null): string | null {
  const base = tableUrl(lark);
  if (base === null || recordId === null) {
    return null;
  }
  return `${base}&record=${recordId}`;
}

// ---- test seams -------------------------------------------------------------------

export function normalizeRecordForTest(record: JsonObject, assignee?: string | null): Issue | null {
  const lark = larkSettings(settingsBang());
  const filter = typeof assignee === "string" && assignee.trim() !== "" ? assignee.trim() : null;
  return normalizeRecord(record, lark, filter);
}

// ---- error constructors -------------------------------------------------------------
// All tags follow the TrackerError convention from plugins/types.ts; `status`
// stays top-level mirroring the Linear plugin's `linear_api_status` shape.

function missingCredentialsError() {
  return {
    tag: "missing_lark_app_credentials",
    code: "missing_credentials",
    message: "Lark app credentials (app_id/app_secret) missing in WORKFLOW.md",
  } as const;
}

function missingAppTokenError() {
  return {
    tag: "missing_lark_app_token",
    code: "missing_config",
    message: "Lark Bitable app_token missing in WORKFLOW.md",
  } as const;
}

function missingTableIdError() {
  return {
    tag: "missing_lark_table_id",
    code: "missing_config",
    message: "Lark Bitable table_id missing in WORKFLOW.md",
  } as const;
}

function statusError(status: number) {
  return {
    tag: "lark_api_status",
    code: "provider_status",
    message: `Lark API request failed with HTTP ${status}`,
    status,
  } as const;
}

function apiError(code: number, msg: unknown) {
  const suffix = typeof msg === "string" && msg !== "" ? `: ${msg}` : "";
  return {
    tag: "lark_api_error",
    code: "provider_error",
    message: `Lark API returned error code ${code}${suffix}`,
    detail: { code, msg: typeof msg === "string" ? msg : null },
  } as const;
}

function transportError(reason: unknown) {
  return {
    tag: "lark_api_request",
    code: "transport_failed",
    message: "Lark API request failed before receiving a response",
    reason,
  } as const;
}

function unknownPayloadError() {
  return {
    tag: "lark_unknown_payload",
    code: "invalid_payload",
    message: "Lark API response had an unexpected shape",
  } as const;
}

// ---- table addressing ----------------------------------------------------------------

type TableRef = { appToken: string; tableId: string };

function requireTable(lark: LarkSettings): Result<TableRef, TrackerError> {
  if (lark.appId === null || lark.appSecret === null) {
    return err(missingCredentialsError());
  }
  if (lark.appToken === null) {
    return err(missingAppTokenError());
  }
  if (lark.tableId === null) {
    return err(missingTableIdError());
  }
  return ok({ appToken: lark.appToken, tableId: lark.tableId });
}

function tablePath(table: TableRef): string {
  return `/open-apis/bitable/v1/apps/${table.appToken}/tables/${table.tableId}`;
}

// ---- transport ------------------------------------------------------------------------

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

// ---- helpers ---------------------------------------------------------------------------

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asObject(value: unknown): JsonObject | null {
  return isObject(value) ? value : null;
}

function getIn(value: unknown, keys: string[]): unknown {
  let current: unknown = value;
  for (const key of keys) {
    if (!isObject(current)) {
      return undefined;
    }
    current = current[key];
  }
  return current;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function summarizeErrorBody(body: unknown): string {
  const rendered = typeof body === "string" ? body.replace(/\s+/g, " ").trim() : inspect(body);
  if (Buffer.byteLength(rendered, "utf8") > MAX_ERROR_BODY_LOG_BYTES) {
    return `${rendered.slice(0, MAX_ERROR_BODY_LOG_BYTES)}...<truncated>`;
  }
  return rendered;
}

function inspect(value: unknown): string {
  if (typeof value === "string") {
    return JSON.stringify(value);
  }
  return JSON.stringify(value) ?? String(value);
}

// Aggregate object used as the default Lark client module and for injection.
export const Client = {
  fetchCandidateIssues,
  fetchIssuesByStates,
  fetchIssueStatesByIds,
};

export type LarkClientModule = {
  fetchCandidateIssues(): Promise<Result<Issue[], TrackerError>>;
  fetchIssuesByStates(states: string[]): Promise<Result<Issue[], TrackerError>>;
  fetchIssueStatesByIds(ids: string[]): Promise<Result<Issue[], TrackerError>>;
};
