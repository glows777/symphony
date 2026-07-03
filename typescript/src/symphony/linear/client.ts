// Literal port of `symphony_elixir/linear/client.ex`.
//
// Thin Linear GraphQL client. Elixir's Req calls are blocking; the TS port uses
// `fetch`, so `graphql` and the fetch helpers are async (Promise-returning).

import { settingsBang } from "../config.ts";
import { logger } from "../logger.ts";
import { linearSettings } from "../plugins/linear/settings.ts";
import { type Result, err, ok } from "../result.ts";
import { type Blocker, type Issue, newIssue } from "./issue.ts";

const ISSUE_PAGE_SIZE = 50;
const MAX_ERROR_BODY_LOG_BYTES = 1_000;

const QUERY = `query SymphonyLinearPoll($projectSlug: String!, $stateNames: [String!]!, $first: Int!, $relationFirst: Int!, $after: String) {
  issues(filter: {project: {slugId: {eq: $projectSlug}}, state: {name: {in: $stateNames}}}, first: $first, after: $after) {
    nodes {
      id identifier title description priority
      state { name }
      branchName url
      assignee { id }
      labels { nodes { name } }
      inverseRelations(first: $relationFirst) {
        nodes { type issue { id identifier state { name } } }
      }
      createdAt updatedAt
    }
    pageInfo { hasNextPage endCursor }
  }
}`;

const QUERY_BY_IDS = `query SymphonyLinearIssuesById($ids: [ID!]!, $first: Int!, $relationFirst: Int!) {
  issues(filter: {id: {in: $ids}}, first: $first) {
    nodes {
      id identifier title description priority
      state { name }
      branchName url
      assignee { id }
      labels { nodes { name } }
      inverseRelations(first: $relationFirst) {
        nodes { type issue { id identifier state { name } } }
      }
      createdAt updatedAt
    }
  }
}`;

const VIEWER_QUERY = `query SymphonyLinearViewer {
  viewer { id }
}`;

type AssigneeFilter = { configuredAssignee: string; matchValues: Set<string> } | null;
type RequestResponse = { status: number; body: unknown };
export type RequestFun = (
  payload: JsonObject,
  headers: Record<string, string>,
) => Result<RequestResponse, unknown> | Promise<Result<RequestResponse, unknown>>;
export type GraphqlOpts = { operationName?: string; requestFun?: RequestFun };
export type GraphqlFun = (
  query: string,
  variables: JsonObject,
) => Result<unknown, unknown> | Promise<Result<unknown, unknown>>;

type JsonObject = Record<string, unknown>;

export async function fetchCandidateIssues(): Promise<Result<Issue[], unknown>> {
  const settings = settingsBang();
  const linear = linearSettings(settings);
  const projectSlug = linear.projectSlug;

  if (linear.apiKey === null) {
    return err(missingApiTokenError());
  }
  if (projectSlug === null) {
    return err(missingProjectSlugError());
  }
  const assigneeFilter = await routingAssigneeFilter();
  if (!assigneeFilter.ok) {
    return err(assigneeFilter.error);
  }
  return doFetchByStates(projectSlug, settings.tracker.activeStates, assigneeFilter.value);
}

export async function fetchIssuesByStates(stateNames: string[]): Promise<Result<Issue[], unknown>> {
  const normalizedStates = [...new Set(stateNames.map(String))];
  if (normalizedStates.length === 0) {
    return ok([]);
  }
  const linear = linearSettings(settingsBang());
  const projectSlug = linear.projectSlug;
  if (linear.apiKey === null) {
    return err(missingApiTokenError());
  }
  if (projectSlug === null) {
    return err(missingProjectSlugError());
  }
  return doFetchByStates(projectSlug, normalizedStates, null);
}

export async function fetchIssueStatesByIds(issueIds: string[]): Promise<Result<Issue[], unknown>> {
  const ids = [...new Set(issueIds)];
  if (ids.length === 0) {
    return ok([]);
  }
  const assigneeFilter = await routingAssigneeFilter();
  if (!assigneeFilter.ok) {
    return err(assigneeFilter.error);
  }
  return doFetchIssueStates(ids, assigneeFilter.value, graphql);
}

export async function graphql(
  query: string,
  variables: JsonObject = {},
  opts: GraphqlOpts = {},
): Promise<Result<unknown, unknown>> {
  const payload = buildGraphqlPayload(query, variables, opts.operationName);
  const requestFun = opts.requestFun ?? postGraphqlRequest;

  const headers = graphqlHeaders();
  if (!headers.ok) {
    return err(headers.error);
  }

  const response = await requestFun(payload, headers.value);
  if (response.ok && response.value.status === 200) {
    return ok(response.value.body);
  }
  if (response.ok) {
    logger.error(
      `Linear GraphQL request failed status=${response.value.status}${linearErrorContext(payload, response.value)}`,
    );
    return err({
      tag: "linear_api_status",
      code: "provider_status",
      message: `Linear GraphQL request failed with HTTP ${response.value.status}`,
      status: response.value.status,
    });
  }
  logger.error(`Linear GraphQL request failed: ${inspect(response.error)}`);
  return err({
    tag: "linear_api_request",
    code: "transport_failed",
    message: "Linear GraphQL request failed before receiving a response",
    reason: response.error,
  });
}

// ---- test seams (mirror the *_for_test helpers) ----------------------------

export function normalizeIssueForTest(issue: JsonObject, assignee?: string | null): Issue | null {
  let assigneeFilter: AssigneeFilter = null;
  if (typeof assignee === "string") {
    const built = buildAssigneeFilterSync(assignee);
    assigneeFilter = built.ok ? built.value : null;
  }
  return normalizeIssue(issue, assigneeFilter);
}

export function nextPageCursorForTest(pageInfo: PageInfo): Result<string, unknown> | "done" {
  return nextPageCursor(pageInfo);
}

export function mergeIssuePagesForTest(issuePages: Issue[][]): Issue[] {
  return finalizePaginatedIssues(issuePages.reduce<Issue[]>(prependPageIssues, []));
}

export function fetchIssueStatesByIdsForTest(
  issueIds: string[],
  graphqlFun: GraphqlFun,
): Promise<Result<Issue[], unknown>> {
  const ids = [...new Set(issueIds)];
  if (ids.length === 0) {
    return Promise.resolve(ok([]));
  }
  return doFetchIssueStates(ids, null, graphqlFun);
}

// ---- pagination / fetching -------------------------------------------------

function doFetchByStates(
  projectSlug: string,
  stateNames: string[],
  assigneeFilter: AssigneeFilter,
): Promise<Result<Issue[], unknown>> {
  return doFetchByStatesPage(projectSlug, stateNames, assigneeFilter, null, []);
}

async function doFetchByStatesPage(
  projectSlug: string,
  stateNames: string[],
  assigneeFilter: AssigneeFilter,
  afterCursor: string | null,
  accIssues: Issue[],
): Promise<Result<Issue[], unknown>> {
  const body = await graphql(QUERY, {
    projectSlug,
    stateNames,
    first: ISSUE_PAGE_SIZE,
    relationFirst: ISSUE_PAGE_SIZE,
    after: afterCursor,
  });
  if (!body.ok) {
    return err(body.error);
  }
  const decoded = decodeLinearPageResponse(body.value, assigneeFilter);
  if (!decoded.ok) {
    return err(decoded.error);
  }
  const updatedAcc = prependPageIssues(accIssues, decoded.value.issues);

  const cursor = nextPageCursor(decoded.value.pageInfo);
  if (cursor === "done") {
    return ok(finalizePaginatedIssues(updatedAcc));
  }
  if (!cursor.ok) {
    return err(cursor.error);
  }
  return doFetchByStatesPage(projectSlug, stateNames, assigneeFilter, cursor.value, updatedAcc);
}

// Note: `prependPageIssues(acc, issues)` matches Elixir's
// `prepend_page_issues(issues, acc)` = `Enum.reverse(issues, acc)`.
function prependPageIssues(acc: Issue[], issues: Issue[]): Issue[] {
  return [...issues].reverse().concat(acc);
}

function finalizePaginatedIssues(accIssues: Issue[]): Issue[] {
  return [...accIssues].reverse();
}

function doFetchIssueStates(
  ids: string[],
  assigneeFilter: AssigneeFilter,
  graphqlFun: GraphqlFun,
): Promise<Result<Issue[], unknown>> {
  return doFetchIssueStatesPage(ids, assigneeFilter, graphqlFun, [], issueOrderIndex(ids));
}

async function doFetchIssueStatesPage(
  ids: string[],
  assigneeFilter: AssigneeFilter,
  graphqlFun: GraphqlFun,
  accIssues: Issue[],
  orderIndex: Map<string, number>,
): Promise<Result<Issue[], unknown>> {
  if (ids.length === 0) {
    return ok(sortIssuesByRequestedIds(finalizePaginatedIssues(accIssues), orderIndex));
  }
  const batchIds = ids.slice(0, ISSUE_PAGE_SIZE);
  const restIds = ids.slice(ISSUE_PAGE_SIZE);

  const body = await graphqlFun(QUERY_BY_IDS, {
    ids: batchIds,
    first: batchIds.length,
    relationFirst: ISSUE_PAGE_SIZE,
  });
  if (!body.ok) {
    return err(body.error);
  }
  const decoded = decodeLinearResponse(body.value, assigneeFilter);
  if (!decoded.ok) {
    return err(decoded.error);
  }
  const updatedAcc = prependPageIssues(accIssues, decoded.value);
  return doFetchIssueStatesPage(restIds, assigneeFilter, graphqlFun, updatedAcc, orderIndex);
}

function issueOrderIndex(ids: string[]): Map<string, number> {
  return new Map(ids.map((id, index) => [id, index]));
}

function sortIssuesByRequestedIds(issues: Issue[], orderIndex: Map<string, number>): Issue[] {
  const fallback = orderIndex.size;
  const rank = (issue: Issue): number =>
    issue.id !== null ? (orderIndex.get(issue.id) ?? fallback) : fallback;
  return [...issues].sort((a, b) => rank(a) - rank(b));
}

// ---- payload / headers / transport -----------------------------------------

function buildGraphqlPayload(
  query: string,
  variables: JsonObject,
  operationName: string | undefined,
): JsonObject {
  const payload: JsonObject = { query, variables };
  if (typeof operationName === "string") {
    const trimmed = operationName.trim();
    if (trimmed !== "") {
      payload.operationName = trimmed;
    }
  }
  return payload;
}

function linearErrorContext(payload: JsonObject, response: RequestResponse): string {
  const name = payload.operationName;
  const operation = typeof name === "string" && name !== "" ? ` operation=${name}` : "";
  return `${operation} body=${summarizeErrorBody(response.body)}`;
}

function summarizeErrorBody(body: unknown): string {
  if (typeof body === "string") {
    return inspect(truncateErrorBody(body.replace(/\s+/g, " ").trim()));
  }
  return truncateErrorBody(inspect(body));
}

function truncateErrorBody(body: string): string {
  if (Buffer.byteLength(body, "utf8") > MAX_ERROR_BODY_LOG_BYTES) {
    return `${body.slice(0, MAX_ERROR_BODY_LOG_BYTES)}...<truncated>`;
  }
  return body;
}

function graphqlHeaders(): Result<Record<string, string>, unknown> {
  const token = linearSettings(settingsBang()).apiKey;
  if (token === null) {
    return err(missingApiTokenError());
  }
  return ok({ Authorization: token, "Content-Type": "application/json" });
}

async function postGraphqlRequest(
  payload: JsonObject,
  headers: Record<string, string>,
): Promise<Result<RequestResponse, unknown>> {
  try {
    const response = await fetch(linearSettings(settingsBang()).endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(30_000),
    });
    const body = await response.json();
    return ok({ status: response.status, body });
  } catch (error) {
    return err(error);
  }
}

// ---- decoding --------------------------------------------------------------

type PageInfo = { hasNextPage: boolean; endCursor: unknown };

function decodeLinearResponse(
  body: unknown,
  assigneeFilter: AssigneeFilter,
): Result<Issue[], unknown> {
  const nodes = getIn(body, ["data", "issues", "nodes"]);
  if (Array.isArray(nodes)) {
    const issues = nodes
      .map((node) => normalizeIssue(node as JsonObject, assigneeFilter))
      .filter((issue): issue is Issue => issue !== null);
    return ok(issues);
  }
  const errors = getIn(body, ["errors"]);
  if (errors !== undefined) {
    return err({
      tag: "linear_graphql_errors",
      code: "provider_error",
      message: "Linear GraphQL response contained errors",
      errors,
    });
  }
  return err({
    tag: "linear_unknown_payload",
    code: "invalid_payload",
    message: "Linear GraphQL response had an unexpected shape",
  });
}

function decodeLinearPageResponse(
  body: unknown,
  assigneeFilter: AssigneeFilter,
): Result<{ issues: Issue[]; pageInfo: PageInfo }, unknown> {
  const nodes = getIn(body, ["data", "issues", "nodes"]);
  const pageInfo = getIn(body, ["data", "issues", "pageInfo"]);
  if (
    Array.isArray(nodes) &&
    isObject(pageInfo) &&
    "hasNextPage" in pageInfo &&
    "endCursor" in pageInfo
  ) {
    const decoded = decodeLinearResponse(body, assigneeFilter);
    if (!decoded.ok) {
      return err(decoded.error);
    }
    return ok({
      issues: decoded.value,
      pageInfo: { hasNextPage: pageInfo.hasNextPage === true, endCursor: pageInfo.endCursor },
    });
  }
  const fallback = decodeLinearResponse(body, assigneeFilter);
  if (!fallback.ok) {
    return err(fallback.error);
  }
  // The fallback path implies an unexpected/non-paginated body; treat as done.
  return ok({ issues: fallback.value, pageInfo: { hasNextPage: false, endCursor: null } });
}

function nextPageCursor(pageInfo: PageInfo): Result<string, unknown> | "done" {
  if (pageInfo.hasNextPage === true) {
    if (typeof pageInfo.endCursor === "string" && pageInfo.endCursor.length > 0) {
      return ok(pageInfo.endCursor);
    }
    return err({
      tag: "linear_missing_end_cursor",
      code: "invalid_payload",
      message: "Linear pagination response is missing endCursor",
    });
  }
  return "done";
}

function normalizeIssue(issue: JsonObject, assigneeFilter: AssigneeFilter): Issue | null {
  if (!isObject(issue)) {
    return null;
  }
  const assignee = issue.assignee;
  return newIssue({
    id: (issue.id as string | null) ?? null,
    identifier: (issue.identifier as string | null) ?? null,
    title: (issue.title as string | null) ?? null,
    description: (issue.description as string | null) ?? null,
    priority: parsePriority(issue.priority),
    state: (getIn(issue, ["state", "name"]) as string | null) ?? null,
    branchName: (issue.branchName as string | null) ?? null,
    url: (issue.url as string | null) ?? null,
    assigneeId: assigneeField(assignee, "id"),
    blockedBy: extractBlockers(issue),
    labels: extractLabels(issue),
    assignedToWorker: assignedToWorker(assignee, assigneeFilter),
    createdAt: parseDateTime(issue.createdAt),
    updatedAt: parseDateTime(issue.updatedAt),
  });
}

function assigneeField(assignee: unknown, field: string): string | null {
  return isObject(assignee) ? ((assignee[field] as string | null) ?? null) : null;
}

function assignedToWorker(assignee: unknown, assigneeFilter: AssigneeFilter): boolean {
  if (assigneeFilter === null) {
    return true;
  }
  if (isObject(assignee)) {
    const id = normalizeAssigneeMatchValue(assignee.id);
    return id !== null && assigneeFilter.matchValues.has(id);
  }
  return false;
}

async function routingAssigneeFilter(): Promise<Result<AssigneeFilter, unknown>> {
  const assignee = linearSettings(settingsBang()).assignee;
  if (assignee === null) {
    return ok(null);
  }
  return buildAssigneeFilter(assignee);
}

async function buildAssigneeFilter(assignee: string): Promise<Result<AssigneeFilter, unknown>> {
  const normalized = normalizeAssigneeMatchValue(assignee);
  if (normalized === null) {
    return ok(null);
  }
  if (normalized === "me") {
    return resolveViewerAssigneeFilter();
  }
  return ok({ configuredAssignee: assignee, matchValues: new Set([normalized]) });
}

// Synchronous variant used by the normalize_issue_for_test seam (no viewer).
function buildAssigneeFilterSync(assignee: string): Result<AssigneeFilter, unknown> {
  const normalized = normalizeAssigneeMatchValue(assignee);
  if (normalized === null) {
    return ok(null);
  }
  if (normalized === "me") {
    return err(missingViewerIdentityError());
  }
  return ok({ configuredAssignee: assignee, matchValues: new Set([normalized]) });
}

async function resolveViewerAssigneeFilter(): Promise<Result<AssigneeFilter, unknown>> {
  const response = await graphql(VIEWER_QUERY, {});
  if (!response.ok) {
    return err(response.error);
  }
  const viewer = getIn(response.value, ["data", "viewer"]);
  if (isObject(viewer)) {
    const viewerId = normalizeAssigneeMatchValue(viewer.id);
    if (viewerId === null) {
      return err(missingViewerIdentityError());
    }
    return ok({ configuredAssignee: "me", matchValues: new Set([viewerId]) });
  }
  return err(missingViewerIdentityError());
}

function normalizeAssigneeMatchValue(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

function extractLabels(issue: JsonObject): string[] {
  const nodes = getIn(issue, ["labels", "nodes"]);
  if (!Array.isArray(nodes)) {
    return [];
  }
  return nodes
    .map((node) => (isObject(node) ? node.name : null))
    .filter((name): name is string => typeof name === "string")
    .map((name) => name.trim().toLowerCase());
}

function extractBlockers(issue: JsonObject): Blocker[] {
  const nodes = getIn(issue, ["inverseRelations", "nodes"]);
  if (!Array.isArray(nodes)) {
    return [];
  }
  const blockers: Blocker[] = [];
  for (const node of nodes) {
    if (!isObject(node)) {
      continue;
    }
    const type = node.type;
    const blockerIssue = node.issue;
    if (
      typeof type === "string" &&
      isObject(blockerIssue) &&
      type.trim().toLowerCase() === "blocks"
    ) {
      blockers.push({
        id: (blockerIssue.id as string | null) ?? null,
        identifier: (blockerIssue.identifier as string | null) ?? null,
        state: (getIn(blockerIssue, ["state", "name"]) as string | null) ?? null,
      });
    }
  }
  return blockers;
}

function parseDateTime(raw: unknown): Date | null {
  if (typeof raw !== "string") {
    return null;
  }
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? null : date;
}

function parsePriority(priority: unknown): number | null {
  return typeof priority === "number" && Number.isInteger(priority) ? priority : null;
}

// ---- error constructors ------------------------------------------------------
// Legacy tags are preserved verbatim; `code`/`message` follow the TrackerError
// convention from plugins/types.ts (extra fields like `status` stay top-level
// for compatibility with existing consumers).

function missingApiTokenError() {
  return {
    tag: "missing_linear_api_token",
    code: "missing_credentials",
    message: "Linear API token missing in WORKFLOW.md",
  } as const;
}

function missingProjectSlugError() {
  return {
    tag: "missing_linear_project_slug",
    code: "missing_config",
    message: "Linear project slug missing in WORKFLOW.md",
  } as const;
}

function missingViewerIdentityError() {
  return {
    tag: "missing_linear_viewer_identity",
    code: "missing_config",
    message: 'Unable to resolve the Linear viewer identity for assignee "me"',
  } as const;
}

// ---- helpers ---------------------------------------------------------------

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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

function inspect(value: unknown): string {
  if (typeof value === "string") {
    return JSON.stringify(value);
  }
  return JSON.stringify(value) ?? String(value);
}

// Aggregate object used as the default Linear client module and for injection.
export const Client = {
  fetchCandidateIssues,
  fetchIssuesByStates,
  fetchIssueStatesByIds,
  graphql,
};

export type LinearClientModule = {
  fetchCandidateIssues(): Promise<Result<Issue[], unknown>>;
  fetchIssuesByStates(states: string[]): Promise<Result<Issue[], unknown>>;
  fetchIssueStatesByIds(ids: string[]): Promise<Result<Issue[], unknown>>;
  graphql(
    query: string,
    variables?: JsonObject,
    opts?: GraphqlOpts,
  ): Promise<Result<unknown, unknown>> | Result<unknown, unknown>;
};
