// Lark (Feishu) Bitable HTTP client. Work items are records in one Bitable
// table; the three tracker reads map onto records/search (server-side state
// filter + pagination) and records/batch_get (batched id refresh). The
// resource-agnostic transport — tenant_access_token lifecycle, authenticated
// request layer, JSON helpers — lives in ../lark-common/http.ts and is shared
// with the task-center plugin; this module owns everything Bitable-specific
// (paths, filter grammar, record normalization). Tests inject a fake
// transport via the `requestFun` option and reset the shared token cache
// through `resetTokenCacheForTest` (wired into teardownWorkflow).

import { settingsBang } from "../../config.ts";
import { type Result, err, ok } from "../../result.ts";
import {
  type JsonObject,
  type LarkApiContext,
  type RequestOpts,
  asObject,
  getIn,
  isObject,
  larkApiErrorSet,
  request as larkRequest,
  parseTimestamp,
  stringOrNull,
  webDomain,
} from "../lark-common/http.ts";
import type { TrackerError } from "../types.ts";
import { type Issue, newIssue } from "../work-item.ts";
import { type LarkSettings, larkSettings } from "./settings.ts";

export type { RequestFun, RequestOpts } from "../lark-common/http.ts";
export { resetTokenCacheForTest } from "../lark-common/http.ts";

const SEARCH_PAGE_SIZE = 500; // records/search hard page cap
const BATCH_GET_LIMIT = 100; // records/batch_get hard record_ids cap

// A configured `tracker.assignee` open_id (the app identity has no viewer
// concept, so unlike Linear there is no "me" resolution).
type AssigneeFilter = string | null;

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

// ---- state write-back ----------------------------------------------------------

// Updates the state single-select field on one record (the stateUpdates
// capability). `stateName` must be an option from the field's vocabulary;
// unknown options surface as a Lark business error.
export async function updateRecordState(
  recordId: string,
  stateName: string,
  opts: RequestOpts = {},
): Promise<Result<undefined, TrackerError>> {
  const lark = larkSettings(settingsBang());
  const table = requireTable(lark);
  if (!table.ok) {
    return err(table.error);
  }
  const path = `${tablePath(table.value)}/records/${encodeURIComponent(recordId)}`;
  const response = await request("PUT", path, { fields: { [lark.fieldState]: stateName } }, opts);
  if (!response.ok) {
    return err(response.error);
  }
  return ok(undefined);
}

// ---- authenticated OpenAPI request (shared with the lark_api agent tool) -------

// The Bitable plugin's binding of the shared request layer: auth comes from
// the current lark settings, errors carry the `lark_api_*` tags.
export async function request(
  method: string,
  path: string,
  body: JsonObject | null = null,
  opts: RequestOpts = {},
): Promise<Result<unknown, TrackerError>> {
  return larkRequest(apiContext(larkSettings(settingsBang())), method, path, body, opts);
}

const larkErrors = larkApiErrorSet("lark", missingCredentialsError);

function apiContext(lark: LarkSettings): LarkApiContext {
  return {
    auth: { endpoint: lark.endpoint, appId: lark.appId, appSecret: lark.appSecret },
    errors: larkErrors,
  };
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

// ---- URLs -----------------------------------------------------------------------

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
// Request-layer errors (lark_api_status / lark_api_error / lark_api_request /
// lark_unknown_payload) come from the shared larkApiErrorSet; the
// config-shaped errors below stay local. All follow the TrackerError
// convention from plugins/types.ts.

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

// Aggregate object used as the default Lark client module and for injection.
export const Client = {
  fetchCandidateIssues,
  fetchIssuesByStates,
  fetchIssueStatesByIds,
  updateRecordState,
};

export type LarkClientModule = {
  fetchCandidateIssues(): Promise<Result<Issue[], TrackerError>>;
  fetchIssuesByStates(states: string[]): Promise<Result<Issue[], TrackerError>>;
  fetchIssueStatesByIds(ids: string[]): Promise<Result<Issue[], TrackerError>>;
  updateRecordState(
    recordId: string,
    stateName: string,
  ): Promise<Result<undefined, unknown>> | Result<undefined, unknown>;
};
