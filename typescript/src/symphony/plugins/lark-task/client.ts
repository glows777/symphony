// Lark (Feishu) task-center (Task v2) HTTP client. Work items are tasks in
// one tasklist, and state is modeled on the tasklist's sections (one section
// = one board column): the state vocabulary is the section names, candidate
// reads list the tasks of each active-state section, and a state update
// moves the task into the section named after the target state. The
// resource-agnostic transport (tenant token cache, authenticated request
// layer) is shared with the Bitable plugin via ../lark-common/http.ts.
//
// API facts this client is built on (verified against the official
// @larksuiteoapi/node-sdk 1.70.0 generated bindings; the doc site blocks
// non-browser fetches, so the SDK is the checkable source of truth):
//
// - `GET /open-apis/task/v2/sections?resource_type=tasklist&resource_id={guid}`
//   pages over `{guid, name, is_default}` section summaries.
// - `GET /open-apis/task/v2/sections/{section_guid}/tasks` pages over task
//   *summaries* (`guid`, `summary`, `completed_at`, `start`, `due`,
//   `members`, `subtask_count` — no description/url/timestamps/custom
//   fields), with an optional server-side `completed` filter. There is no
//   server-side filtering by custom-field values.
// - `GET /open-apis/task/v2/tasks/{task_guid}` returns the full task,
//   including `description`, `url`, `created_at`/`updated_at` (epoch-ms
//   strings), and `tasklists: [{tasklist_guid, section_guid}]` — the task's
//   section membership per tasklist.
// - There is NO batch task get, so the by-ids read issues one get per id.
// - `POST /open-apis/task/v2/tasks/{task_guid}/add_tasklist` with
//   `{tasklist_guid, section_guid}` moves the task into that section
//   (re-adding to a tasklist the task is already in updates its section).
// - `POST /open-apis/task/v2/comments` with
//   `{content, resource_type: "task", resource_id}` creates a task comment.
//
// Candidate listing passes `completed=false` so checkbox-completed tasks
// (completion is orthogonal to sections in the task center) never re-enter
// the dispatch pool; the by-states read used for terminal-state cleanup
// applies no completed filter.

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
import { type LarkTaskSettings, larkTaskSettings } from "./settings.ts";

export type { RequestFun, RequestOpts } from "../lark-common/http.ts";

const LIST_PAGE_SIZE = 100; // task v2 list endpoints' page_size cap
// Task v2 defaults member ids to open_id already; pinned explicitly so the
// `tracker.assignee` open_id comparison never depends on a server default.
const USER_ID_TYPE = "open_id";
const SECTIONS_PATH = "/open-apis/task/v2/sections";
const TASKS_PATH = "/open-apis/task/v2/tasks";
const COMMENTS_PATH = "/open-apis/task/v2/comments";

// A configured `tracker.assignee` open_id (the app identity has no viewer
// concept, so unlike Linear there is no "me" resolution).
type AssigneeFilter = string | null;

type Section = { guid: string; name: string; isDefault: boolean };

// ---- required reads ----------------------------------------------------------

export async function fetchCandidateIssues(
  opts: RequestOpts = {},
): Promise<Result<Issue[], TrackerError>> {
  const settings = settingsBang();
  const lark = larkTaskSettings(settings);
  return tasksInSectionsNamed(lark, settings.tracker.activeStates, {
    assigneeFilter: routingAssigneeFilter(lark),
    completed: false,
    opts,
  });
}

export async function fetchIssuesByStates(
  stateNames: string[],
  opts: RequestOpts = {},
): Promise<Result<Issue[], TrackerError>> {
  const normalizedStates = [...new Set(stateNames.map(String))];
  if (normalizedStates.length === 0) {
    return ok([]);
  }
  const lark = larkTaskSettings(settingsBang());
  return tasksInSectionsNamed(lark, normalizedStates, {
    assigneeFilter: null,
    completed: null,
    opts,
  });
}

export async function fetchIssueStatesByIds(
  taskGuids: string[],
  opts: RequestOpts = {},
): Promise<Result<Issue[], TrackerError>> {
  const ids = [...new Set(taskGuids)];
  if (ids.length === 0) {
    return ok([]);
  }
  const lark = larkTaskSettings(settingsBang());
  const board = requireBoard(lark);
  if (!board.ok) {
    return err(board.error);
  }
  const sections = await listSections(lark, board.value, opts);
  if (!sections.ok) {
    return err(sections.error);
  }
  const sectionNames = new Map(sections.value.map((section) => [section.guid, section.name]));
  const defaultName = sections.value.find((section) => section.isDefault)?.name ?? null;
  const assigneeFilter = routingAssigneeFilter(lark);
  const issues: Issue[] = [];
  for (const id of ids) {
    const response = await request(
      "GET",
      `${TASKS_PATH}/${encodeURIComponent(id)}?user_id_type=${USER_ID_TYPE}`,
      null,
      opts,
    );
    if (!response.ok) {
      // Deleted tasks come back as HTTP 404; they are simply not returned,
      // matching the Bitable plugin's absent_record_ids semantics. Other
      // failures abort the whole refresh (a skipped tick beats silently
      // dropping a live item).
      if (isNotFound(response.error)) {
        continue;
      }
      return err(response.error);
    }
    const task = asObject(getIn(response.value, ["data", "task"]));
    const issue = normalizeTaskDetail(task, board.value, {
      sectionNames,
      defaultSectionName: defaultName,
      assigneeFilter,
    });
    if (issue !== null) {
      issues.push(issue);
    }
  }
  return ok(issues);
}

function isNotFound(error: TrackerError): boolean {
  return error.code === "provider_status" && (error as { status?: unknown }).status === 404;
}

// ---- write-backs ---------------------------------------------------------------

// Moves the task into the section named `stateName` (the stateUpdates
// capability): state names are section names, so the update is an
// add_tasklist call re-targeting the task's section within the board.
export async function updateTaskState(
  taskGuid: string,
  stateName: string,
  opts: RequestOpts = {},
): Promise<Result<undefined, TrackerError>> {
  const lark = larkTaskSettings(settingsBang());
  const board = requireBoard(lark);
  if (!board.ok) {
    return err(board.error);
  }
  const sections = await listSections(lark, board.value, opts);
  if (!sections.ok) {
    return err(sections.error);
  }
  const target = sectionNamed(sections.value, stateName);
  if (target === null) {
    return err({
      tag: "lark_task_unknown_state",
      code: "provider_error",
      message: `Lark tasklist has no section named ${JSON.stringify(stateName)}; the state vocabulary is the tasklist's section names`,
    });
  }
  const response = await request(
    "POST",
    `${TASKS_PATH}/${encodeURIComponent(taskGuid)}/add_tasklist`,
    { tasklist_guid: board.value, section_guid: target.guid },
    opts,
  );
  if (!response.ok) {
    return err(response.error);
  }
  return ok(undefined);
}

// Creates a task comment (the comments capability — the task center has a
// native comment API, unlike Bitable records).
export async function createTaskComment(
  taskGuid: string,
  body: string,
  opts: RequestOpts = {},
): Promise<Result<undefined, TrackerError>> {
  const lark = larkTaskSettings(settingsBang());
  const board = requireBoard(lark);
  if (!board.ok) {
    return err(board.error);
  }
  const response = await request(
    "POST",
    COMMENTS_PATH,
    { content: body, resource_type: "task", resource_id: taskGuid },
    opts,
  );
  if (!response.ok) {
    return err(response.error);
  }
  return ok(undefined);
}

// ---- authenticated OpenAPI request (shared with the lark_api agent tool) -------

// The task plugin's binding of the shared request layer: auth comes from the
// current lark-task settings, errors carry the `lark_task_*` tags.
export async function request(
  method: string,
  path: string,
  body: JsonObject | null = null,
  opts: RequestOpts = {},
): Promise<Result<unknown, TrackerError>> {
  return larkRequest(apiContext(larkTaskSettings(settingsBang())), method, path, body, opts);
}

const larkTaskErrors = larkApiErrorSet("lark_task", missingCredentialsError);

function apiContext(lark: LarkTaskSettings): LarkApiContext {
  return {
    auth: { endpoint: lark.endpoint, appId: lark.appId, appSecret: lark.appSecret },
    errors: larkTaskErrors,
  };
}

// ---- section-scoped listing ------------------------------------------------------

// Lists the tasks of every section whose name matches one of `stateNames`
// (case-insensitively, mirroring the core reconcile matching). Names that
// match no section contribute nothing — same as a Bitable state filter that
// matches no rows.
async function tasksInSectionsNamed(
  lark: LarkTaskSettings,
  stateNames: string[],
  options: { assigneeFilter: AssigneeFilter; completed: boolean | null; opts: RequestOpts },
): Promise<Result<Issue[], TrackerError>> {
  const board = requireBoard(lark);
  if (!board.ok) {
    return err(board.error);
  }
  if (stateNames.length === 0) {
    return ok([]);
  }
  const sections = await listSections(lark, board.value, options.opts);
  if (!sections.ok) {
    return err(sections.error);
  }
  const wanted = new Set(stateNames.map((name) => name.toLowerCase()));
  const issues: Issue[] = [];
  for (const section of sections.value) {
    if (!wanted.has(section.name.toLowerCase())) {
      continue;
    }
    const tasks = await listSectionTasks(section, options.completed, options.opts);
    if (!tasks.ok) {
      return err(tasks.error);
    }
    for (const task of tasks.value) {
      const issue = normalizeTaskSummary(task, board.value, section, options.assigneeFilter);
      if (issue !== null) {
        issues.push(issue);
      }
    }
  }
  return ok(issues);
}

async function listSections(
  lark: LarkTaskSettings,
  tasklistGuid: string,
  opts: RequestOpts,
): Promise<Result<Section[], TrackerError>> {
  const basePath =
    `${SECTIONS_PATH}?resource_type=tasklist` +
    `&resource_id=${encodeURIComponent(tasklistGuid)}&page_size=${LIST_PAGE_SIZE}`;
  const items = await listAllPages(basePath, opts);
  if (!items.ok) {
    return err(items.error);
  }
  const sections: Section[] = [];
  for (const item of items.value) {
    const section = asObject(item);
    const guid = section === null ? null : stringOrNull(section.guid);
    const name = section === null ? null : stringOrNull(section.name);
    if (guid !== null && name !== null) {
      sections.push({ guid, name, isDefault: section?.is_default === true });
    }
  }
  return ok(sections);
}

async function listSectionTasks(
  section: Section,
  completed: boolean | null,
  opts: RequestOpts,
): Promise<Result<JsonObject[], TrackerError>> {
  const completedParam = completed === null ? "" : `&completed=${completed}`;
  const basePath =
    `${SECTIONS_PATH}/${encodeURIComponent(section.guid)}/tasks` +
    `?page_size=${LIST_PAGE_SIZE}&user_id_type=${USER_ID_TYPE}${completedParam}`;
  const items = await listAllPages(basePath, opts);
  if (!items.ok) {
    return err(items.error);
  }
  return ok(items.value.map(asObject).filter((item): item is JsonObject => item !== null));
}

// Drains a task v2 list endpoint (`data.items` + `has_more`/`page_token`
// cursor pagination). `basePath` must already carry a query string.
async function listAllPages(
  basePath: string,
  opts: RequestOpts,
): Promise<Result<unknown[], TrackerError>> {
  const acc: unknown[] = [];
  let pageToken: string | null = null;
  for (;;) {
    const path =
      pageToken === null ? basePath : `${basePath}&page_token=${encodeURIComponent(pageToken)}`;
    const response = await request("GET", path, null, opts);
    if (!response.ok) {
      return err(response.error);
    }
    const data = getIn(response.value, ["data"]);
    const items = getIn(data, ["items"]);
    if (Array.isArray(items)) {
      acc.push(...items);
    }
    if (getIn(data, ["has_more"]) !== true) {
      return ok(acc);
    }
    const nextToken = getIn(data, ["page_token"]);
    if (typeof nextToken !== "string" || nextToken === "") {
      return err({
        tag: "lark_task_missing_page_token",
        code: "invalid_payload",
        message: "Lark task list pagination response is missing page_token",
      });
    }
    pageToken = nextToken;
  }
}

// ---- task normalization ------------------------------------------------------------

// Normalizes a section-listing task *summary*. Summaries carry no
// description/url/timestamps — those degrade to null (contract-sanctioned)
// and are filled in by the detail-backed by-ids read, which the orchestrator
// runs on every item right before dispatch.
function normalizeTaskSummary(
  task: JsonObject,
  tasklistGuid: string,
  section: Section,
  assigneeFilter: AssigneeFilter,
): Issue | null {
  const guid = stringOrNull(task.guid);
  if (guid === null) {
    return null;
  }
  const assigneeIds = assigneeMemberIds(task.members);
  return newIssue({
    id: guid,
    identifier: guid,
    title: blankToNull(stringOrNull(task.summary)),
    state: section.name,
    assigneeId: assigneeIds[0] ?? null,
    // Task dependencies are not mapped in v1: empty blockedBy disables the
    // orchestrator's blocking gate (contract-sanctioned degradation).
    blockedBy: [],
    labels: [],
    assignedToWorker: assignedToWorker(assigneeIds, assigneeFilter),
    metadata: {
      tasklist_guid: tasklistGuid,
      task_guid: guid,
      section_guid: section.guid,
    },
  });
}

// Normalizes a full task detail (the by-ids read). The task's state is the
// name of its section within the configured tasklist; a task that is no
// longer on the board (no matching `tasklists` entry) normalizes to null and
// is treated as absent.
function normalizeTaskDetail(
  task: JsonObject | null,
  tasklistGuid: string,
  context: {
    sectionNames: Map<string, string>;
    defaultSectionName: string | null;
    assigneeFilter: AssigneeFilter;
  },
): Issue | null {
  if (task === null) {
    return null;
  }
  const guid = stringOrNull(task.guid);
  if (guid === null) {
    return null;
  }
  const membership = boardMembership(task.tasklists, tasklistGuid);
  if (membership === null) {
    return null;
  }
  const state =
    membership.sectionGuid !== null
      ? (context.sectionNames.get(membership.sectionGuid) ?? null)
      : context.defaultSectionName;
  const assigneeIds = assigneeMemberIds(task.members);
  return newIssue({
    id: guid,
    identifier: guid,
    title: blankToNull(stringOrNull(task.summary)),
    description: blankToNull(stringOrNull(task.description)),
    state,
    url: stringOrNull(task.url),
    assigneeId: assigneeIds[0] ?? null,
    blockedBy: [],
    labels: [],
    assignedToWorker: assignedToWorker(assigneeIds, context.assigneeFilter),
    createdAt: parseTimestamp(task.created_at),
    updatedAt: parseTimestamp(task.updated_at),
    metadata: {
      tasklist_guid: tasklistGuid,
      task_guid: guid,
      section_guid: membership.sectionGuid,
    },
  });
}

// Finds the task's membership entry for the configured tasklist inside the
// detail's `tasklists: [{tasklist_guid, section_guid}]` array.
function boardMembership(
  value: unknown,
  tasklistGuid: string,
): { sectionGuid: string | null } | null {
  if (!Array.isArray(value)) {
    return null;
  }
  for (const entry of value) {
    if (isObject(entry) && stringOrNull(entry.tasklist_guid) === tasklistGuid) {
      return { sectionGuid: stringOrNull(entry.section_guid) };
    }
  }
  return null;
}

// Task members carry a role ("assignee" | "follower"); only assignees count
// for routing. Ids are open_ids (`user_id_type` is pinned on every read).
function assigneeMemberIds(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .filter((entry): entry is JsonObject => isObject(entry))
    .filter((entry) => entry.role === "assignee")
    .map((entry) => stringOrNull(entry.id))
    .filter((id): id is string => id !== null && id !== "");
}

function assignedToWorker(assigneeIds: string[], assigneeFilter: AssigneeFilter): boolean {
  if (assigneeFilter === null) {
    return true;
  }
  return assigneeIds.includes(assigneeFilter);
}

function routingAssigneeFilter(lark: LarkTaskSettings): AssigneeFilter {
  if (lark.assignee === null) {
    return null;
  }
  const trimmed = lark.assignee.trim();
  return trimmed === "" ? null : trimmed;
}

function blankToNull(value: string | null): string | null {
  if (value === null || value.trim() === "") {
    return null;
  }
  return value;
}

function sectionNamed(sections: Section[], stateName: string): Section | null {
  const exact = sections.find((section) => section.name === stateName);
  if (exact !== undefined) {
    return exact;
  }
  const lowered = stateName.toLowerCase();
  return sections.find((section) => section.name.toLowerCase() === lowered) ?? null;
}

// ---- URLs -----------------------------------------------------------------------

// Tasklist share links use the applink protocol on the tenant domain
// (open.feishu.cn -> applink.feishu.cn, open.larksuite.com ->
// applink.larksuite.com), matching the `url` field the tasklist APIs return.
export function tasklistUrl(lark: LarkTaskSettings): string | null {
  const domain = webDomain(lark.endpoint);
  if (domain === null || lark.tasklistGuid === null) {
    return null;
  }
  return `https://applink.${domain}/client/todo/task_list?guid=${lark.tasklistGuid}`;
}

// ---- test seams -------------------------------------------------------------------

export function normalizeTaskSummaryForTest(
  task: JsonObject,
  section: { guid: string; name: string },
  assignee?: string | null,
): Issue | null {
  const lark = larkTaskSettings(settingsBang());
  return normalizeTaskSummary(
    task,
    lark.tasklistGuid ?? "",
    { guid: section.guid, name: section.name, isDefault: false },
    normalizeFilter(assignee),
  );
}

export function normalizeTaskDetailForTest(
  task: JsonObject,
  sections: { guid: string; name: string; isDefault?: boolean }[],
  assignee?: string | null,
): Issue | null {
  const lark = larkTaskSettings(settingsBang());
  return normalizeTaskDetail(task, lark.tasklistGuid ?? "", {
    sectionNames: new Map(sections.map((section) => [section.guid, section.name])),
    defaultSectionName: sections.find((section) => section.isDefault === true)?.name ?? null,
    assigneeFilter: normalizeFilter(assignee),
  });
}

function normalizeFilter(assignee: string | null | undefined): AssigneeFilter {
  return typeof assignee === "string" && assignee.trim() !== "" ? assignee.trim() : null;
}

// ---- error constructors -------------------------------------------------------------
// Request-layer errors (lark_task_api_status / lark_task_api_error /
// lark_task_api_request / lark_task_unknown_payload) come from the shared
// larkApiErrorSet; the config-shaped errors below stay local.

function missingCredentialsError() {
  return {
    tag: "missing_lark_task_credentials",
    code: "missing_credentials",
    message: "Lark app credentials (app_id/app_secret) missing in WORKFLOW.md",
  } as const;
}

function missingTasklistError() {
  return {
    tag: "missing_lark_task_tasklist",
    code: "missing_config",
    message: "Lark task-center tasklist_guid missing in WORKFLOW.md",
  } as const;
}

// ---- board addressing ----------------------------------------------------------------

function requireBoard(lark: LarkTaskSettings): Result<string, TrackerError> {
  if (lark.appId === null || lark.appSecret === null) {
    return err(missingCredentialsError());
  }
  if (lark.tasklistGuid === null) {
    return err(missingTasklistError());
  }
  return ok(lark.tasklistGuid);
}

// Aggregate object used as the default lark-task client module and for
// injection.
export const Client = {
  fetchCandidateIssues,
  fetchIssuesByStates,
  fetchIssueStatesByIds,
  updateTaskState,
  createTaskComment,
};

export type LarkTaskClientModule = {
  fetchCandidateIssues(): Promise<Result<Issue[], TrackerError>>;
  fetchIssuesByStates(states: string[]): Promise<Result<Issue[], TrackerError>>;
  fetchIssueStatesByIds(ids: string[]): Promise<Result<Issue[], TrackerError>>;
  updateTaskState(
    taskGuid: string,
    stateName: string,
  ): Promise<Result<undefined, unknown>> | Result<undefined, unknown>;
  createTaskComment(
    taskGuid: string,
    body: string,
  ): Promise<Result<undefined, unknown>> | Result<undefined, unknown>;
};
