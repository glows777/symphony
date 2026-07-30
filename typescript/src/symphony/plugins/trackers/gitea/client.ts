// Thin Gitea REST client. It intentionally depends only on the platform
// `fetch` API and the tracker contract; the configurable instance URL is the
// only host it can contact. Tests inject `requestFun` at this boundary, while
// the plugin-level `gitea_client_module` seam can replace whole operations.

import { settingsBang } from "../../../config.ts";
import { logger } from "../../../logger.ts";
import { type Result, err, ok } from "../../../result.ts";
import { type Issue, newIssue } from "../../../work-item.ts";
import type { TrackerError } from "../types.ts";
import { type GiteaSettings, giteaInstanceUrl, giteaSettings } from "./settings.ts";

const API_PREFIX = "/api/v1";
const ISSUE_PAGE_SIZE = 50;
const LABEL_PAGE_SIZE = 50;
const MAX_PAGINATION_PAGES = 100;
const MAX_PAGINATION_ITEMS = 5_000;
const MAX_PAGINATION_DURATION_MS = 60_000;
const MAX_ERROR_BODY_LOG_BYTES = 1_000;
const PATH_VALIDATION_ORIGIN = "https://symphony.invalid";

const OPEN_STATE_ALIASES = new Set(["open", "active", "todo", "in progress"]);
const CLOSED_STATE_ALIASES = new Set([
  "closed",
  "terminal",
  "resolved",
  "done",
  "cancelled",
  "canceled",
  "duplicate",
]);

export type JsonObject = Record<string, unknown>;

export type ResponseHeaders =
  | {
      get(name: string): string | null;
    }
  | Record<string, string | string[] | undefined>;

export type RequestResponse = {
  status: number;
  body: unknown;
  headers?: ResponseHeaders;
};

export type RequestFun = (
  method: string,
  url: string,
  headers: Record<string, string>,
  body: JsonObject | null,
) => Result<RequestResponse, unknown> | Promise<Result<RequestResponse, unknown>>;

export type RequestOpts = { requestFun?: RequestFun };

export type GiteaClientModule = {
  fetchCandidateIssues(): Promise<Result<Issue[], TrackerError>>;
  fetchIssuesByStates(states: string[]): Promise<Result<Issue[], TrackerError>>;
  fetchIssueStatesByIds(ids: string[]): Promise<Result<Issue[], TrackerError>>;
  updateIssueState(
    issueId: string,
    stateName: string,
  ): Promise<Result<undefined, TrackerError>> | Result<undefined, TrackerError>;
  createComment(
    issueId: string,
    body: string,
  ): Promise<Result<undefined, TrackerError>> | Result<undefined, TrackerError>;
};

type AuthContext = { instanceUrl: string; token: string };
type RepositoryContext = AuthContext & { owner: string; repo: string };
type RawResponse = { status: number; body: unknown; headers?: ResponseHeaders; path: string };

// ---- required tracker reads -------------------------------------------------

export async function fetchCandidateIssues(
  opts: RequestOpts = {},
): Promise<Result<Issue[], TrackerError>> {
  const settings = settingsBang();
  const gitea = giteaSettings(settings);
  const repository = requireRepository(gitea);
  if (!repository.ok) {
    return err(repository.error);
  }
  if (settings.tracker.activeStates.length === 0) {
    return ok([]);
  }

  const nativeStates = nativeStatesForWorkflowStates(
    settings.tracker.activeStates,
    settings,
    "open",
  );
  if (nativeStates.length === 0) {
    return ok([]);
  }

  const result = await fetchIssuesForNativeStates(repository.value, nativeStates, settings, opts);
  if (!result.ok) {
    return err(result.error);
  }
  const filterByState = shouldFilterByRequestedStates(settings.tracker.activeStates, settings);
  return ok(
    result.value.filter(
      (issue) =>
        (!filterByState || stateNamesInclude(settings.tracker.activeStates, issue.state)) &&
        issue.assignedToWorker &&
        hasRequiredLabels(issue.labels, settings.tracker.requiredLabels),
    ),
  );
}

export async function fetchIssuesByStates(
  stateNames: string[],
  opts: RequestOpts = {},
): Promise<Result<Issue[], TrackerError>> {
  const normalized = uniqueNonBlank(stateNames.map(String));
  if (normalized.length === 0) {
    return ok([]);
  }
  const settings = settingsBang();
  const gitea = giteaSettings(settings);
  const repository = requireRepository(gitea);
  if (!repository.ok) {
    return err(repository.error);
  }

  const nativeStates = nativeStatesForWorkflowStates(normalized, settings, null);
  if (nativeStates.length === 0) {
    return ok([]);
  }
  const result = await fetchIssuesForNativeStates(repository.value, nativeStates, settings, opts);
  if (!result.ok) {
    return err(result.error);
  }
  if (!shouldFilterByRequestedStates(normalized, settings)) {
    return result;
  }
  return ok(result.value.filter((issue) => stateNamesInclude(normalized, issue.state)));
}

export async function fetchIssueStatesByIds(
  issueIds: string[],
  opts: RequestOpts = {},
): Promise<Result<Issue[], TrackerError>> {
  const ids = uniqueNonBlank(issueIds);
  if (ids.length === 0) {
    return ok([]);
  }
  const settings = settingsBang();
  const gitea = giteaSettings(settings);
  const repository = requireRepository(gitea);
  if (!repository.ok) {
    return err(repository.error);
  }

  const issues: Issue[] = [];
  for (const issueId of ids) {
    const issueNumber = parseIssueNumber(issueId, repository.value);
    if (issueNumber === null) {
      return err(invalidIssueIdError(issueId));
    }
    const path = repositoryIssuePath(repository.value, issueNumber);
    const response = await requestRaw("GET", path, null, opts);
    if (!response.ok) {
      if (isMissingIssueError(response.error)) {
        continue;
      }
      return err(response.error);
    }
    const issue = decodeIssue(response.value.body, settings, gitea);
    if (!issue.ok) {
      return err(issue.error);
    }
    issues.push(issue.value);
  }
  return ok(issues);
}

async function fetchIssuesForNativeStates(
  repository: RepositoryContext,
  nativeStates: ("open" | "closed")[],
  settings: ReturnType<typeof settingsBang>,
  opts: RequestOpts,
): Promise<Result<Issue[], TrackerError>> {
  const gitea = giteaSettings(settings);
  const issuesById = new Map<string, Issue>();
  for (const nativeState of nativeStates) {
    const query = new URLSearchParams({
      state: nativeState,
      type: "issues",
      page: "1",
      limit: String(ISSUE_PAGE_SIZE),
    });
    const page = await fetchPaginatedArray(
      `${repositoryPath(repository)}/issues?${query.toString()}`,
      opts,
      ISSUE_PAGE_SIZE,
    );
    if (!page.ok) {
      return err(page.error);
    }
    for (const rawIssue of page.value) {
      if (!isObject(rawIssue)) {
        return err(invalidPayloadError("issue list", rawIssue));
      }
      const issue = decodeIssue(rawIssue, settings, gitea);
      if (!issue.ok) {
        return err(issue.error);
      }
      if (!issuesById.has(issue.value.id ?? "")) {
        issuesById.set(issue.value.id ?? "", issue.value);
      }
    }
  }
  return ok([...issuesById.values()]);
}

// ---- write capabilities and provider resources -----------------------------

export async function updateIssueState(
  issueId: string,
  stateName: string,
  opts: RequestOpts = {},
): Promise<Result<undefined, TrackerError>> {
  const settings = settingsBang();
  const gitea = giteaSettings(settings);
  const repository = requireRepository(gitea);
  if (!repository.ok) {
    return err(repository.error);
  }
  const nativeState = nativeStateForWorkflowState(stateName, settings);
  if (nativeState === null) {
    return err(unknownStateError(stateName));
  }
  const issueNumber = parseIssueNumber(issueId, repository.value);
  if (issueNumber === null) {
    return err(invalidIssueIdError(issueId));
  }
  const response = await requestRaw(
    "PATCH",
    repositoryIssuePath(repository.value, issueNumber),
    { state: nativeState },
    opts,
  );
  if (!response.ok) {
    return err(response.error);
  }
  const issue = decodeIssue(response.value.body, settings, gitea);
  if (!issue.ok) {
    return err(issue.error);
  }
  const labels = nextIssueLabels(response.value.body, stateName, settings);
  if (labels !== null) {
    const replaced = await replaceIssueLabels(issueId, labels, opts);
    if (!replaced.ok) {
      return err(replaced.error);
    }
  }
  return ok(undefined);
}

export async function createComment(
  issueId: string,
  body: string,
  opts: RequestOpts = {},
): Promise<Result<undefined, TrackerError>> {
  if (body.trim() === "") {
    return err({
      tag: "gitea_invalid_comment",
      code: "invalid_payload",
      message: "Gitea comment body must not be blank",
    });
  }
  const gitea = giteaSettings(settingsBang());
  const repository = requireRepository(gitea);
  if (!repository.ok) {
    return err(repository.error);
  }
  const issueNumber = parseIssueNumber(issueId, repository.value);
  if (issueNumber === null) {
    return err(invalidIssueIdError(issueId));
  }
  const response = await requestRaw(
    "POST",
    `${repositoryIssuePath(repository.value, issueNumber)}/comments`,
    { body },
    opts,
  );
  if (!response.ok) {
    return err(response.error);
  }
  const comment = decodeObject(response.value.body, response.value.path);
  if (!comment.ok) {
    return err(comment.error);
  }
  return ok(undefined);
}

export async function fetchIssueComments(
  issueId: string,
  opts: RequestOpts = {},
): Promise<Result<unknown[], TrackerError>> {
  const gitea = giteaSettings(settingsBang());
  const repository = requireRepository(gitea);
  if (!repository.ok) {
    return err(repository.error);
  }
  const issueNumber = parseIssueNumber(issueId, repository.value);
  if (issueNumber === null) {
    return err(invalidIssueIdError(issueId));
  }
  const result = await fetchPaginatedArray(
    `${repositoryIssuePath(repository.value, issueNumber)}/comments`,
    opts,
    null,
  );
  return result;
}

export async function fetchRepositoryLabels(
  opts: RequestOpts = {},
): Promise<Result<unknown[], TrackerError>> {
  const repository = requireRepository(giteaSettings(settingsBang()));
  if (!repository.ok) {
    return err(repository.error);
  }
  return fetchPaginatedArray(
    `${repositoryPath(repository.value)}/labels?page=1&limit=${LABEL_PAGE_SIZE}`,
    opts,
    LABEL_PAGE_SIZE,
  );
}

export async function fetchIssueLabels(
  issueId: string,
  opts: RequestOpts = {},
): Promise<Result<unknown[], TrackerError>> {
  const repository = requireRepository(giteaSettings(settingsBang()));
  if (!repository.ok) {
    return err(repository.error);
  }
  const issueNumber = parseIssueNumber(issueId, repository.value);
  if (issueNumber === null) {
    return err(invalidIssueIdError(issueId));
  }
  return fetchPaginatedArray(
    `${repositoryIssuePath(repository.value, issueNumber)}/labels`,
    opts,
    null,
  );
}

export async function replaceIssueLabels(
  issueId: string,
  labels: Array<string | number>,
  opts: RequestOpts = {},
): Promise<Result<unknown[], TrackerError>> {
  const repository = requireRepository(giteaSettings(settingsBang()));
  if (!repository.ok) {
    return err(repository.error);
  }
  const issueNumber = parseIssueNumber(issueId, repository.value);
  if (issueNumber === null) {
    return err(invalidIssueIdError(issueId));
  }
  const response = await requestRaw(
    "PUT",
    `${repositoryIssuePath(repository.value, issueNumber)}/labels`,
    { labels },
    opts,
  );
  if (!response.ok) {
    return err(response.error);
  }
  return decodeArray(response.value.body, response.value.path);
}

// ---- authenticated API boundary --------------------------------------------

export async function request(
  method: string,
  path: string,
  body: JsonObject | null = null,
  opts: RequestOpts = {},
): Promise<Result<unknown, TrackerError>> {
  const response = await requestRaw(method, path, body, opts);
  return response.ok ? ok(response.value.body) : err(response.error);
}

async function requestRaw(
  method: string,
  path: string,
  body: JsonObject | null,
  opts: RequestOpts,
): Promise<Result<RawResponse, TrackerError>> {
  const auth = requireAuth(giteaSettings(settingsBang()));
  if (!auth.ok) {
    return err(auth.error);
  }
  if (!isApiPath(path)) {
    return err(invalidApiPathError(path));
  }
  const requestFun = opts.requestFun ?? httpRequest;
  let response: Result<RequestResponse, unknown>;
  try {
    response = await requestFun(
      method.toUpperCase(),
      `${auth.value.instanceUrl}${path}`,
      authHeaders(auth.value.token, body),
      body,
    );
  } catch (error) {
    return err(transportError(path, error));
  }
  if (!response.ok) {
    return err(transportError(path, response.error));
  }
  const { status, body: responseBody, headers } = response.value;
  if (!Number.isInteger(status) || status < 100 || status >= 600) {
    return err(invalidPayloadError(path, { status, body: responseBody }));
  }
  if (status < 200 || status >= 300) {
    logger.error(
      `Gitea API request failed status=${status} path=${path} body=${summarizeErrorBody(responseBody)}`,
    );
    return err(statusError(path, status, responseBody));
  }
  return ok({
    status,
    body: responseBody,
    path,
    ...(headers === undefined ? {} : { headers }),
  });
}

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
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
    });
    const text = await response.text();
    return ok({
      status: response.status,
      body: parseResponseBody(text),
      headers: response.headers,
    });
  } catch (error) {
    return err(error);
  }
}

function authHeaders(token: string, body: JsonObject | null): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: "application/json",
    Authorization: `token ${token}`,
  };
  if (body !== null) {
    headers["Content-Type"] = "application/json";
  }
  return headers;
}

function parseResponseBody(text: string): unknown {
  if (text.trim() === "") {
    return null;
  }
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

// ---- pagination -------------------------------------------------------------

async function fetchPaginatedArray(
  initialPath: string,
  opts: RequestOpts,
  pageSize: number | null,
): Promise<Result<unknown[], TrackerError>> {
  const gitea = giteaSettings(settingsBang());
  const auth = requireAuth(gitea);
  if (!auth.ok) {
    return err(auth.error);
  }
  let path = initialPath;
  const seen = new Set<string>();
  const items: unknown[] = [];
  const startedAt = Date.now();
  let pageCount = 0;

  while (true) {
    if (pageCount >= MAX_PAGINATION_PAGES) {
      return err(paginationLimitError(path, "pages", MAX_PAGINATION_PAGES));
    }
    if (Date.now() - startedAt >= MAX_PAGINATION_DURATION_MS) {
      return err(paginationLimitError(path, "duration_ms", MAX_PAGINATION_DURATION_MS));
    }
    if (seen.has(path)) {
      return err({
        tag: "gitea_pagination_loop",
        code: "invalid_payload",
        message: "Gitea pagination returned the same next link more than once",
        detail: { path },
      });
    }
    seen.add(path);
    pageCount += 1;
    const response = await requestRaw("GET", path, null, opts);
    if (!response.ok) {
      return err(response.error);
    }
    const page = decodeArray(response.value.body, response.value.path);
    if (!page.ok) {
      return err(page.error);
    }
    if (items.length + page.value.length > MAX_PAGINATION_ITEMS) {
      return err(paginationLimitError(path, "items", MAX_PAGINATION_ITEMS));
    }
    items.push(...page.value);

    const next = nextPagePath(
      path,
      response.value.headers,
      page.value.length,
      pageSize,
      auth.value.instanceUrl,
    );
    if (!next.ok) {
      return err(next.error);
    }
    if (next.value === null) {
      return ok(items);
    }
    path = next.value;
  }
}

function nextPagePath(
  currentPath: string,
  headers: ResponseHeaders | undefined,
  itemCount: number,
  pageSize: number | null,
  instanceUrl: string,
): Result<string | null, TrackerError> {
  const link = headerValue(headers, "link");
  const linkedNext = link === null ? null : nextLink(link);
  if (linkedNext !== null) {
    return normalizeLinkedPath(linkedNext, instanceUrl, currentPath);
  }
  if (pageSize === null) {
    return ok(null);
  }

  const total = parseHeaderInteger(headers, "x-total-count");
  const currentPage = pageNumber(currentPath);
  if (currentPage === null) {
    return err({
      tag: "gitea_invalid_pagination",
      code: "invalid_payload",
      message: "Gitea pagination path has an invalid page parameter",
      detail: { path: currentPath },
    });
  }
  if (total !== null && currentPage * pageSize < total) {
    return ok(withPage(currentPath, currentPage + 1, pageSize));
  }
  // Some compatible Gitea installations omit the headers. A full page is a
  // safe fallback; an empty or short page is the terminal condition.
  if (total === null && itemCount === pageSize) {
    return ok(withPage(currentPath, currentPage + 1, pageSize));
  }
  return ok(null);
}

function nextLink(linkHeader: string): string | null {
  const links = [...linkHeader.matchAll(/<([^>]+)>\s*;\s*rel=["']?([^,;"']+)["']?/gi)];
  for (const match of links) {
    const relations = match[2]?.trim().toLowerCase().split(/\s+/) ?? [];
    if (relations.includes("next") && match[1] !== undefined) {
      return match[1];
    }
  }
  return null;
}

function normalizeLinkedPath(
  link: string,
  instanceUrl: string,
  currentPath: string,
): Result<string, TrackerError> {
  try {
    const resolved = new URL(link, `${instanceUrl}/`);
    const instance = new URL(instanceUrl);
    if (resolved.origin !== instance.origin) {
      return err({
        tag: "gitea_pagination_host_mismatch",
        code: "invalid_payload",
        message: "Gitea pagination link points to a different host",
        detail: { link, currentPath },
      });
    }
    const instancePath = instance.pathname.replace(/\/+$/, "");
    const apiPath = `${instancePath}${API_PREFIX}` || API_PREFIX;
    if (!resolved.pathname.startsWith(`${apiPath}/`)) {
      return err({
        tag: "gitea_pagination_path_mismatch",
        code: "invalid_payload",
        message: "Gitea pagination link leaves the configured API path",
        detail: { link, currentPath },
      });
    }
    return ok(`${resolved.pathname.slice(instancePath.length)}${resolved.search}`);
  } catch {
    return err({
      tag: "gitea_invalid_pagination_link",
      code: "invalid_payload",
      message: "Gitea pagination returned an invalid Link header",
      detail: { link, currentPath },
    });
  }
}

function withPage(path: string, page: number, limit: number): string {
  const url = new URL(path, "https://symphony.invalid");
  url.searchParams.set("page", String(page));
  url.searchParams.set("limit", String(limit));
  return `${url.pathname}${url.search}`;
}

function pageNumber(path: string): number | null {
  const url = new URL(path, "https://symphony.invalid");
  const page = url.searchParams.get("page");
  if (page === null) {
    return 1;
  }
  const parsed = Number.parseInt(page, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function headerValue(headers: ResponseHeaders | undefined, name: string): string | null {
  if (headers === undefined) {
    return null;
  }
  if ("get" in headers && typeof headers.get === "function") {
    return headers.get(name);
  }
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== name.toLowerCase() || value === undefined) {
      continue;
    }
    return Array.isArray(value) ? value.join(",") : value;
  }
  return null;
}

function parseHeaderInteger(headers: ResponseHeaders | undefined, name: string): number | null {
  const value = headerValue(headers, name);
  if (value === null || !/^\d+$/.test(value.trim())) {
    return null;
  }
  return Number.parseInt(value, 10);
}

// ---- payload normalization --------------------------------------------------

export function normalizeIssueForTest(
  rawIssue: JsonObject,
  assignee: string | null | undefined = undefined,
): Issue | null {
  const settings = settingsBang();
  const configured = giteaSettings(settings);
  return normalizeIssue(
    rawIssue,
    settings,
    assignee === undefined ? configured : { ...configured, assignee },
  );
}

function decodeIssue(
  body: unknown,
  settings: ReturnType<typeof settingsBang>,
  gitea: GiteaSettings,
): Result<Issue, TrackerError> {
  if (!isObject(body)) {
    return err(invalidPayloadError("issue", body));
  }
  if (typeof body.message === "string") {
    return err(providerErrorPayload("issue", body));
  }
  const issue = normalizeIssue(body, settings, gitea);
  return issue === null ? err(invalidPayloadError("issue", body)) : ok(issue);
}

function decodeObject(body: unknown, path: string): Result<JsonObject, TrackerError> {
  if (isObject(body)) {
    if (typeof body.message === "string") {
      return err(providerErrorPayload(path, body));
    }
    return ok(body);
  }
  return err(invalidPayloadError(path, body));
}

function normalizeIssue(
  rawIssue: JsonObject,
  settings: ReturnType<typeof settingsBang>,
  gitea: GiteaSettings,
): Issue | null {
  if (gitea.owner === null || gitea.repo === null) {
    return null;
  }
  const number = issueNumberFromPayload(rawIssue);
  const nativeState = nativeStateFromPayload(rawIssue.state);
  if (number === null || nativeState === null || typeof rawIssue.title !== "string") {
    return null;
  }

  const identifier = `${gitea.owner}/${gitea.repo}#${number}`;
  const users = issueUsers(rawIssue);
  const assigneeId = firstUserId(users);
  const labels = issueLabels(rawIssue);
  return newIssue({
    id: identifier,
    identifier,
    title: rawIssue.title,
    description: typeof rawIssue.body === "string" ? rawIssue.body : null,
    priority: null,
    state: projectedState(nativeState, settings, labels),
    branchName: null,
    url:
      stringOrNull(rawIssue.html_url) ??
      stringOrNull(rawIssue.url) ??
      `${giteaInstanceUrl(gitea.endpoint ?? "") ?? ""}/${encodeURIComponent(gitea.owner)}/${encodeURIComponent(gitea.repo)}/issues/${number}`,
    assigneeId,
    blockedBy: [],
    labels,
    assignedToWorker: assignedToWorker(users, gitea.assignee),
    createdAt: parseDateTime(rawIssue.created_at),
    updatedAt: parseDateTime(rawIssue.updated_at),
    metadata: {
      provider: "gitea",
      owner: gitea.owner,
      repository: gitea.repo,
      issue_number: number,
      gitea_id: numberOrString(rawIssue.id),
      gitea_state: nativeState,
    },
  });
}

function issueNumberFromPayload(issue: JsonObject): number | null {
  return positiveInteger(issue.number) ?? positiveInteger(issue.index);
}

function nativeStateFromPayload(value: unknown): "open" | "closed" | null {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim().toLowerCase();
  return normalized === "open" || normalized === "closed" ? normalized : null;
}

function issueUsers(issue: JsonObject): JsonObject[] {
  const users: JsonObject[] = [];
  if (isObject(issue.assignee)) {
    users.push(issue.assignee);
  }
  if (Array.isArray(issue.assignees)) {
    for (const assignee of issue.assignees) {
      if (isObject(assignee) && !users.includes(assignee)) {
        users.push(assignee);
      }
    }
  }
  return users;
}

function firstUserId(users: JsonObject[]): string | null {
  const user = users[0];
  if (user === undefined) {
    return null;
  }
  return numberOrString(user.id) ?? stringOrNull(user.login) ?? stringOrNull(user.username);
}

function assignedToWorker(users: JsonObject[], configuredAssignee: string | null): boolean {
  if (configuredAssignee === null) {
    return true;
  }
  const expected = configuredAssignee.trim().toLowerCase();
  return users.some((user) => {
    const values = [user.login, user.username, user.login_name, user.id]
      .map((value) => numberOrString(value)?.toLowerCase())
      .filter((value): value is string => value !== null);
    return values.includes(expected);
  });
}

function issueLabels(issue: JsonObject): string[] {
  return issueLabelNames(issue)
    .map(normalizeLabelName)
    .filter((label) => label !== "");
}

function issueLabelNames(issue: JsonObject): string[] {
  if (!Array.isArray(issue.labels)) {
    return [];
  }
  return issue.labels
    .map((label) => {
      if (typeof label === "string") {
        return label;
      }
      return isObject(label) ? stringOrNull(label.name) : null;
    })
    .filter((label): label is string => label !== null)
    .map((label) => label.trim())
    .filter((label) => label !== "");
}

function hasRequiredLabels(labels: string[], requiredLabels: string[]): boolean {
  const available = new Set(labels.map((label) => label.trim().toLowerCase()));
  return requiredLabels.every((label) => available.has(label.trim().toLowerCase()));
}

function parseDateTime(value: unknown): Date | null {
  if (typeof value !== "string") {
    return null;
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function positiveInteger(value: unknown): number | null {
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) {
    return value;
  }
  if (typeof value === "string" && /^\d+$/.test(value)) {
    const parsed = Number.parseInt(value, 10);
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
  }
  return null;
}

function numberOrString(value: unknown): string | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  return stringOrNull(value);
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

// ---- state projection -------------------------------------------------------

function nativeStatesForWorkflowStates(
  stateNames: string[],
  settings: ReturnType<typeof settingsBang>,
  fallback: "open" | "closed" | null,
): ("open" | "closed")[] {
  const native = stateNames
    .map((state) => nativeStateForWorkflowState(state, settings))
    .filter((state): state is "open" | "closed" => state !== null);
  if (native.length === 0 && fallback !== null && stateNames.length > 0) {
    return [fallback];
  }
  return [...new Set(native)];
}

function nativeStateForWorkflowState(
  stateName: string,
  settings: ReturnType<typeof settingsBang>,
): "open" | "closed" | null {
  const nativeState = nativeStateForCoreWorkflowState(stateName, settings);
  if (nativeState !== null) {
    return nativeState;
  }
  const mapping = stateLabelMappingForWorkflowState(stateName, settings);
  return mapping === null ? null : nativeStateForMappedState(mapping.stateName, settings);
}

function nativeStateForCoreWorkflowState(
  stateName: string,
  settings: ReturnType<typeof settingsBang>,
): "open" | "closed" | null {
  const normalized = stateName.trim().toLowerCase();
  if (OPEN_STATE_ALIASES.has(normalized)) {
    return "open";
  }
  if (CLOSED_STATE_ALIASES.has(normalized)) {
    return "closed";
  }
  if (settings.tracker.activeStates.some((state) => state.trim().toLowerCase() === normalized)) {
    return "open";
  }
  if (settings.tracker.terminalStates.some((state) => state.trim().toLowerCase() === normalized)) {
    return "closed";
  }
  return null;
}

function projectedState(
  nativeState: "open" | "closed",
  settings: ReturnType<typeof settingsBang>,
  labels: string[],
): string {
  const labeled = projectedStateFromLabels(nativeState, settings, labels);
  if (labeled !== null) {
    return labeled;
  }
  const configured =
    nativeState === "open" ? settings.tracker.activeStates : settings.tracker.terminalStates;
  const matching = configured.find(
    (state) => nativeStateForWorkflowState(state, settings) === nativeState,
  );
  return matching ?? configured[0] ?? nativeState;
}

type StateLabelMapping = {
  stateName: string;
  normalizedStateName: string;
  labelName: string;
  normalizedLabelName: string;
};

function stateLabelMappings(settings: ReturnType<typeof settingsBang>): StateLabelMapping[] {
  return Object.entries(giteaSettings(settings).stateLabels).map(([stateName, labelName]) => ({
    stateName,
    normalizedStateName: normalizeStateName(stateName),
    labelName,
    normalizedLabelName: normalizeLabelName(labelName),
  }));
}

function stateLabelMappingForWorkflowState(
  stateName: string,
  settings: ReturnType<typeof settingsBang>,
): StateLabelMapping | null {
  const normalized = normalizeStateName(stateName);
  return (
    stateLabelMappings(settings).find((mapping) => mapping.normalizedStateName === normalized) ??
    null
  );
}

function nativeStateForMappedState(
  stateName: string,
  settings: ReturnType<typeof settingsBang>,
): "open" | "closed" {
  return nativeStateForCoreWorkflowState(stateName, settings) === "closed" ? "closed" : "open";
}

function projectedStateFromLabels(
  nativeState: "open" | "closed",
  settings: ReturnType<typeof settingsBang>,
  labels: string[],
): string | null {
  if (labels.length === 0) {
    return null;
  }
  const labelSet = new Set(labels.map(normalizeLabelName));
  for (const mapping of stateLabelMappings(settings)) {
    if (
      labelSet.has(mapping.normalizedLabelName) &&
      nativeStateForMappedState(mapping.stateName, settings) === nativeState
    ) {
      return mapping.stateName;
    }
  }
  return null;
}

function shouldFilterByRequestedStates(
  stateNames: string[],
  settings: ReturnType<typeof settingsBang>,
): boolean {
  if (stateNames.length === 0) {
    return false;
  }
  return stateNames.some((stateName) => stateLabelMappingForWorkflowState(stateName, settings));
}

function stateNamesInclude(stateNames: string[], stateName: string | null): boolean {
  if (stateName === null) {
    return false;
  }
  const normalized = normalizeStateName(stateName);
  return stateNames.some((candidate) => normalizeStateName(candidate) === normalized);
}

function nextIssueLabels(
  rawIssue: unknown,
  stateName: string,
  settings: ReturnType<typeof settingsBang>,
): string[] | null {
  const mappings = stateLabelMappings(settings);
  if (mappings.length === 0 || !isObject(rawIssue)) {
    return null;
  }
  const stateLabelNames = new Set(mappings.map((mapping) => mapping.normalizedLabelName));
  const nextLabels = issueLabelNames(rawIssue).filter(
    (label) => !stateLabelNames.has(normalizeLabelName(label)),
  );
  const target = stateLabelMappingForWorkflowState(stateName, settings);
  if (target !== null) {
    nextLabels.push(target.labelName);
  }
  return uniqueLabels(nextLabels);
}

function uniqueLabels(labels: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const label of labels) {
    const normalized = normalizeLabelName(label);
    if (normalized !== "" && !seen.has(normalized)) {
      seen.add(normalized);
      result.push(label);
    }
  }
  return result;
}

function normalizeStateName(stateName: string): string {
  return stateName.trim().toLowerCase();
}

function normalizeLabelName(labelName: string): string {
  return labelName.trim().toLowerCase();
}

// ---- paths and config errors ------------------------------------------------

function requireAuth(gitea: GiteaSettings): Result<AuthContext, TrackerError> {
  if (gitea.endpoint === null) {
    return err(missingEndpointError());
  }
  const instanceUrl = giteaInstanceUrl(gitea.endpoint);
  if (instanceUrl === null) {
    return err(invalidEndpointError(gitea.endpoint));
  }
  if (gitea.token === null) {
    return err(missingTokenError());
  }
  return ok({ instanceUrl, token: gitea.token });
}

function requireRepository(gitea: GiteaSettings): Result<RepositoryContext, TrackerError> {
  const auth = requireAuth(gitea);
  if (!auth.ok) {
    return err(auth.error);
  }
  if (gitea.owner === null) {
    return err(missingOwnerError());
  }
  if (gitea.repo === null) {
    return err(missingRepositoryError());
  }
  return ok({ ...auth.value, owner: gitea.owner, repo: gitea.repo });
}

function repositoryPath(repository: RepositoryContext): string {
  return `${API_PREFIX}/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.repo)}`;
}

function repositoryIssuePath(repository: RepositoryContext, issueNumber: number): string {
  return `${repositoryPath(repository)}/issues/${issueNumber}`;
}

function parseIssueNumber(issueId: string, repository: RepositoryContext): number | null {
  const trimmed = issueId.trim();
  const expectedPrefix = `${repository.owner}/${repository.repo}#`;
  if (trimmed.startsWith(expectedPrefix)) {
    return positiveInteger(trimmed.slice(expectedPrefix.length));
  }
  // Accept a bare issue number for callers using Gitea's repository-local
  // identifier directly; normalized WorkItems use owner/repo#number.
  if (/^\d+$/.test(trimmed)) {
    return positiveInteger(trimmed);
  }
  return null;
}

function isApiPath(path: string): boolean {
  if (path === API_PREFIX) {
    return true;
  }
  if (!path.startsWith(`${API_PREFIX}/`) || path.includes("\\")) {
    return false;
  }
  try {
    const parsed = new URL(path, PATH_VALIDATION_ORIGIN);
    return (
      parsed.origin === PATH_VALIDATION_ORIGIN && safeApiPathname(parsed.pathname, `${API_PREFIX}/`)
    );
  } catch {
    return false;
  }
}

function safeApiPathname(pathname: string, prefix: string): boolean {
  if (!pathname.startsWith(prefix)) {
    return false;
  }
  let decoded = pathname;
  try {
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

function uniqueNonBlank(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter((value) => value !== ""))];
}

function decodeArray(body: unknown, path: string): Result<unknown[], TrackerError> {
  if (Array.isArray(body)) {
    return ok(body);
  }
  if (isObject(body) && typeof body.message === "string") {
    return err(providerErrorPayload(path, body));
  }
  return err(invalidPayloadError(path, body));
}

function providerErrorPayload(path: string, body: JsonObject): TrackerError {
  return {
    tag: "gitea_api_error",
    code: "provider_error",
    message: `Gitea API returned an error payload: ${body.message}`,
    detail: { path, body },
  };
}

function invalidPayloadError(path: string, body: unknown): TrackerError {
  return {
    tag: "gitea_invalid_payload",
    code: "invalid_payload",
    message: "Gitea API response had an unexpected payload shape",
    detail: { path, body },
  };
}

function invalidIssueIdError(issueId: string): TrackerError {
  return {
    tag: "gitea_invalid_issue_id",
    code: "invalid_payload",
    message: `Gitea issue identifier is not a repository issue number: ${JSON.stringify(issueId)}`,
    detail: { issueId },
  };
}

function isMissingIssueError(error: TrackerError): boolean {
  const status =
    "status" in error ? error.status : isObject(error.detail) ? error.detail.status : null;
  return error.code === "provider_status" && status === 404;
}

function paginationLimitError(
  path: string,
  limitKind: "pages" | "items" | "duration_ms",
  limit: number,
): TrackerError {
  return {
    tag: "gitea_pagination_limit",
    code: "invalid_payload",
    message: `Gitea pagination exceeded its ${limitKind} limit`,
    detail: { path, limitKind, limit },
  };
}

function invalidApiPathError(path: string): TrackerError {
  return {
    tag: "gitea_invalid_api_path",
    code: "invalid_payload",
    message: "Gitea API path must stay under /api/v1",
    detail: { path },
  };
}

function transportError(path: string, reason: unknown): TrackerError {
  return {
    tag: "gitea_api_request",
    code: "transport_failed",
    message: "Gitea API request failed before receiving a response",
    detail: { path, reason },
  };
}

function statusError(
  path: string,
  status: number,
  body: unknown,
): TrackerError & { status: number } {
  const providerMessage =
    isObject(body) && typeof body.message === "string" ? `: ${body.message}` : "";
  return {
    tag: "gitea_api_status",
    code: "provider_status",
    message: `Gitea API request failed with HTTP ${status}${providerMessage}`,
    detail: { path, status, body },
    status,
  };
}

function missingEndpointError(): TrackerError {
  return {
    tag: "missing_gitea_endpoint",
    code: "missing_config",
    message: "Gitea endpoint missing in WORKFLOW.md",
  };
}

function invalidEndpointError(endpoint: string): TrackerError {
  return {
    tag: "invalid_gitea_endpoint",
    code: "missing_config",
    message: "Gitea endpoint must be an http(s) URL without query credentials",
    detail: { endpoint },
  };
}

function missingTokenError(): TrackerError {
  return {
    tag: "missing_gitea_api_token",
    code: "missing_credentials",
    message: "Gitea API token missing in WORKFLOW.md",
  };
}

function missingOwnerError(): TrackerError {
  return {
    tag: "missing_gitea_owner",
    code: "missing_config",
    message: "Gitea repository owner missing in WORKFLOW.md",
  };
}

function missingRepositoryError(): TrackerError {
  return {
    tag: "missing_gitea_repository",
    code: "missing_config",
    message: "Gitea repository name missing in WORKFLOW.md",
  };
}

function unknownStateError(stateName: string): TrackerError {
  return {
    tag: "gitea_unknown_state",
    code: "unsupported_operation",
    message: `Gitea state is not mapped by tracker.active_states or tracker.terminal_states: ${JSON.stringify(stateName)}`,
    detail: { stateName },
  };
}

function summarizeErrorBody(body: unknown): string {
  const rendered = typeof body === "string" ? body.replace(/\s+/g, " ").trim() : inspect(body);
  if (Buffer.byteLength(rendered, "utf8") > MAX_ERROR_BODY_LOG_BYTES) {
    return `${rendered.slice(0, MAX_ERROR_BODY_LOG_BYTES)}...<truncated>`;
  }
  return rendered;
}

function inspect(value: unknown): string {
  return typeof value === "string"
    ? JSON.stringify(value)
    : (JSON.stringify(value) ?? String(value));
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Aggregate object used by the plugin and its injection seam.
export const Client: GiteaClientModule = {
  fetchCandidateIssues: () => fetchCandidateIssues(),
  fetchIssuesByStates: (states) => fetchIssuesByStates(states),
  fetchIssueStatesByIds: (ids) => fetchIssueStatesByIds(ids),
  updateIssueState: (issueId, stateName) => updateIssueState(issueId, stateName),
  createComment: (issueId, body) => createComment(issueId, body),
};
