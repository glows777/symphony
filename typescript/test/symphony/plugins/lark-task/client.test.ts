import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { logger } from "../../../../src/symphony/logger.ts";
import { resetTokenCacheForTest } from "../../../../src/symphony/plugins/lark-common/http.ts";
import {
  type RequestFun,
  createTaskComment,
  fetchCandidateIssues,
  fetchIssueStatesByIds,
  fetchIssuesByStates,
  normalizeTaskDetailForTest,
  normalizeTaskSummaryForTest,
  updateTaskState,
} from "../../../../src/symphony/plugins/lark-task/client.ts";
import { workflowFilePath } from "../../../../src/symphony/workflow.ts";
import { setupWorkflow, teardownWorkflow } from "../../../support/test-support.ts";
import { writeLarkTaskWorkflowFile } from "./lark-task-test-support.ts";

type Call = { method: string; url: string; headers: Record<string, string>; body: unknown };

const TOKEN_URL_SUFFIX = "/open-apis/auth/v3/tenant_access_token/internal";
const SECTIONS_URL = "/open-apis/task/v2/sections";

function tokenResponse(token = "t-token-1", expire = 7_200) {
  return { status: 200, body: { code: 0, msg: "ok", tenant_access_token: token, expire } };
}

function listResponse(items: unknown[], hasMore = false, pageToken: string | null = null) {
  return {
    status: 200,
    body: {
      code: 0,
      msg: "success",
      data: { items, has_more: hasMore, ...(pageToken === null ? {} : { page_token: pageToken }) },
    },
  };
}

function taskResponse(task: unknown) {
  return { status: 200, body: { code: 0, msg: "success", data: { task } } };
}

function section(guid: string, name: string, isDefault = false) {
  return { guid, name, is_default: isDefault };
}

function summary(guid: string, title: string, members: unknown[] = []) {
  return { guid, summary: title, completed_at: "0", members, subtask_count: 0 };
}

function assignee(id: string) {
  return { id, type: "user", role: "assignee" };
}

// Fake transport: answers the token endpoint from `tokens` (in order) and
// everything else from `responses` (in order), recording every call.
function fakeTransport(
  calls: Call[],
  responses: { status: number; body: unknown }[],
  tokens: { status: number; body: unknown }[] = [tokenResponse()],
): RequestFun {
  return (method, url, headers, body) => {
    calls.push({ method, url, headers, body });
    if (url.endsWith(TOKEN_URL_SUFFIX)) {
      const next = tokens.shift();
      if (next === undefined) {
        throw new Error("unexpected extra token request");
      }
      return { ok: true, value: next };
    }
    const next = responses.shift();
    if (next === undefined) {
      throw new Error("unexpected extra API request");
    }
    return { ok: true, value: next };
  };
}

function apiCalls(calls: Call[]): Call[] {
  return calls.filter((call) => !call.url.endsWith(TOKEN_URL_SUFFIX));
}

describe("LarkTask.Client", () => {
  let root: string;

  beforeEach(() => {
    ({ root } = setupWorkflow());
    writeLarkTaskWorkflowFile(workflowFilePath());
    resetTokenCacheForTest();
  });

  afterEach(() => {
    teardownWorkflow(root);
  });

  describe("normalizeTaskSummary", () => {
    test("maps a section-listing summary onto the WorkItem model", () => {
      const issue = normalizeTaskSummaryForTest(
        summary("guid-1", "Fix the parser", [
          assignee("ou_user1"),
          { id: "ou_user2", type: "user", role: "follower" },
        ]),
        { guid: "sec-todo", name: "Todo" },
      );
      expect(issue).not.toBeNull();
      if (!issue) {
        return;
      }
      expect(issue.id).toBe("guid-1");
      expect(issue.identifier).toBe("guid-1");
      expect(issue.title).toBe("Fix the parser");
      expect(issue.state).toBe("Todo");
      // Summaries carry no description/url/timestamps; the detail-backed
      // by-ids read fills them in before dispatch.
      expect(issue.description).toBeNull();
      expect(issue.url).toBeNull();
      expect(issue.createdAt).toBeNull();
      expect(issue.assigneeId).toBe("ou_user1");
      expect(issue.labels).toEqual([]);
      expect(issue.blockedBy).toEqual([]);
      expect(issue.assignedToWorker).toBe(true);
      expect(issue.metadata).toEqual({
        tasklist_guid: "tlg-TEST",
        task_guid: "guid-1",
        section_guid: "sec-todo",
      });
    });

    test("drops summaries without a guid and blanks empty titles", () => {
      expect(
        normalizeTaskSummaryForTest({ summary: "no guid" }, { guid: "s", name: "Todo" }),
      ).toBeNull();
      const blank = normalizeTaskSummaryForTest(summary("guid-2", "  "), {
        guid: "s",
        name: "Todo",
      });
      expect(blank?.title).toBeNull();
    });

    test("flags assignedToWorker from the configured assignee open_id", () => {
      const mine = normalizeTaskSummaryForTest(
        summary("guid-3", "Routed", [assignee("ou_me")]),
        { guid: "s", name: "Todo" },
        "ou_me",
      );
      expect(mine?.assignedToWorker).toBe(true);

      const theirs = normalizeTaskSummaryForTest(
        summary("guid-4", "Not routed", [assignee("ou_other")]),
        { guid: "s", name: "Todo" },
        "ou_me",
      );
      expect(theirs?.assignedToWorker).toBe(false);

      // Followers never count as assignees.
      const follower = normalizeTaskSummaryForTest(
        summary("guid-5", "Followed", [{ id: "ou_me", type: "user", role: "follower" }]),
        { guid: "s", name: "Todo" },
        "ou_me",
      );
      expect(follower?.assignedToWorker).toBe(false);
    });
  });

  describe("normalizeTaskDetail", () => {
    const sections = [
      { guid: "sec-todo", name: "Todo", isDefault: true },
      { guid: "sec-doing", name: "In Progress" },
    ];

    function detail(overrides: Record<string, unknown> = {}) {
      return {
        guid: "guid-9",
        summary: "Ship it",
        description: "Multi-line\nbody",
        members: [assignee("ou_user1")],
        completed_at: "0",
        tasklists: [{ tasklist_guid: "tlg-TEST", section_guid: "sec-doing" }],
        created_at: "1767225600000",
        updated_at: "1767312000000",
        url: "https://applink.feishu.cn/client/todo/detail?guid=guid-9",
        status: "todo",
        ...overrides,
      };
    }

    test("maps a full task detail onto the WorkItem model", () => {
      const issue = normalizeTaskDetailForTest(detail(), sections);
      expect(issue).not.toBeNull();
      if (!issue) {
        return;
      }
      expect(issue.id).toBe("guid-9");
      expect(issue.title).toBe("Ship it");
      expect(issue.description).toBe("Multi-line\nbody");
      expect(issue.state).toBe("In Progress");
      expect(issue.url).toBe("https://applink.feishu.cn/client/todo/detail?guid=guid-9");
      expect(issue.assigneeId).toBe("ou_user1");
      expect(issue.createdAt).toEqual(new Date(1_767_225_600_000));
      expect(issue.updatedAt).toEqual(new Date(1_767_312_000_000));
      expect(issue.metadata).toEqual({
        tasklist_guid: "tlg-TEST",
        task_guid: "guid-9",
        section_guid: "sec-doing",
      });
    });

    test("treats checkbox-completed tasks as absent", () => {
      // Completed while still in an active section: the detail refresh backs
      // dispatch revalidation, so the task must not resurface as active.
      expect(
        normalizeTaskDetailForTest(detail({ completed_at: "1767398400000" }), sections),
      ).toBeNull();
      // "0", empty, and absent all mean not completed.
      expect(normalizeTaskDetailForTest(detail({ completed_at: "0" }), sections)).not.toBeNull();
      expect(normalizeTaskDetailForTest(detail({ completed_at: "" }), sections)).not.toBeNull();
      expect(
        normalizeTaskDetailForTest(detail({ completed_at: undefined }), sections),
      ).not.toBeNull();
    });

    test("treats tasks that left the configured tasklist as absent", () => {
      const gone = normalizeTaskDetailForTest(
        detail({ tasklists: [{ tasklist_guid: "tlg-OTHER", section_guid: "sec-x" }] }),
        sections,
      );
      expect(gone).toBeNull();
      expect(normalizeTaskDetailForTest(detail({ tasklists: [] }), sections)).toBeNull();
    });

    test("falls back to the default section when the entry has no section_guid", () => {
      const issue = normalizeTaskDetailForTest(
        detail({ tasklists: [{ tasklist_guid: "tlg-TEST" }] }),
        sections,
      );
      expect(issue?.state).toBe("Todo");
    });

    test("unknown section guids degrade to a null state", () => {
      const issue = normalizeTaskDetailForTest(
        detail({ tasklists: [{ tasklist_guid: "tlg-TEST", section_guid: "sec-new" }] }),
        sections,
      );
      expect(issue?.state).toBeNull();
    });
  });

  describe("fetchCandidateIssues", () => {
    test("lists only active-state sections, excluding checkbox-completed tasks", async () => {
      const calls: Call[] = [];
      const transport = fakeTransport(calls, [
        listResponse([
          section("sec-todo", "todo"),
          section("sec-doing", "In Progress"),
          section("sec-done", "Done"),
        ]),
        listResponse([summary("guid-1", "First", [assignee("ou_user1")])]),
        listResponse([summary("guid-2", "Second")]),
      ]);

      const result = await fetchCandidateIssues({ requestFun: transport });
      expect(result.ok).toBe(true);
      if (!result.ok) {
        return;
      }
      // Section names are matched case-insensitively against active_states
      // and the section's own name becomes the state.
      expect(result.value.map((issue) => [issue.id, issue.state])).toEqual([
        ["guid-1", "todo"],
        ["guid-2", "In Progress"],
      ]);

      const requests = apiCalls(calls);
      expect(requests).toHaveLength(3);
      expect(requests[0]?.method).toBe("GET");
      expect(requests[0]?.url).toContain(
        `${SECTIONS_URL}?resource_type=tasklist&resource_id=tlg-TEST&page_size=100`,
      );
      expect(requests[1]?.url).toContain(`${SECTIONS_URL}/sec-todo/tasks?`);
      expect(requests[1]?.url).toContain("completed=false");
      expect(requests[1]?.url).toContain("user_id_type=open_id");
      expect(requests[2]?.url).toContain(`${SECTIONS_URL}/sec-doing/tasks?`);
      // Only one token request across the whole read.
      expect(calls.filter((call) => call.url.endsWith(TOKEN_URL_SUFFIX))).toHaveLength(1);
    });

    test("applies the configured assignee open_id as the routing filter", async () => {
      writeLarkTaskWorkflowFile(workflowFilePath(), {
        assignee: "ou_me",
        active_states: ["Todo"],
      });
      const transport = fakeTransport(
        [],
        [
          listResponse([section("sec-todo", "Todo")]),
          listResponse([
            summary("guid-1", "Mine", [assignee("ou_me")]),
            summary("guid-2", "Theirs", [assignee("ou_other")]),
            summary("guid-3", "Unassigned"),
          ]),
        ],
      );

      const result = await fetchCandidateIssues({ requestFun: transport });
      expect(result.ok).toBe(true);
      if (!result.ok) {
        return;
      }
      expect(result.value.map((issue) => [issue.id, issue.assignedToWorker])).toEqual([
        ["guid-1", true],
        ["guid-2", false],
        ["guid-3", false],
      ]);
    });

    test("a whitespace-only assignee disables routing", async () => {
      writeLarkTaskWorkflowFile(workflowFilePath(), { assignee: "  ", active_states: ["Todo"] });
      const transport = fakeTransport(
        [],
        [
          listResponse([section("sec-todo", "Todo")]),
          listResponse([summary("guid-1", "Anyone", [assignee("ou_other")])]),
        ],
      );

      const result = await fetchCandidateIssues({ requestFun: transport });
      expect(result.ok).toBe(true);
      if (!result.ok) {
        return;
      }
      expect(result.value.map((issue) => issue.assignedToWorker)).toEqual([true]);
    });

    test("drains section-task pagination with the page_token cursor", async () => {
      const calls: Call[] = [];
      const transport = fakeTransport(calls, [
        listResponse([section("sec-todo", "Todo")]),
        listResponse([summary("guid-1", "Page one")], true, "cursor-1"),
        listResponse([summary("guid-2", "Page two")]),
      ]);
      writeLarkTaskWorkflowFile(workflowFilePath(), { active_states: ["Todo"] });

      const result = await fetchCandidateIssues({ requestFun: transport });
      expect(result.ok).toBe(true);
      if (!result.ok) {
        return;
      }
      expect(result.value.map((issue) => issue.id)).toEqual(["guid-1", "guid-2"]);
      const pages = apiCalls(calls).filter((call) => call.url.includes("/sec-todo/tasks"));
      expect(pages).toHaveLength(2);
      expect(pages[1]?.url).toContain("page_token=cursor-1");
    });

    test("pagination without a page_token fails as invalid_payload", async () => {
      const transport = fakeTransport(
        [],
        [
          listResponse([section("sec-todo", "Todo")]),
          listResponse([summary("guid-1", "Page one")], true, null),
        ],
      );
      writeLarkTaskWorkflowFile(workflowFilePath(), { active_states: ["Todo"] });

      const result = await fetchCandidateIssues({ requestFun: transport });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.tag).toBe("lark_task_missing_page_token");
        expect(result.error.code).toBe("invalid_payload");
      }
    });

    test("fails with missing_lark_task_tasklist / credentials before any request", async () => {
      Reflect.deleteProperty(process.env, "LARK_APP_SECRET");
      const guard: RequestFun = () => {
        throw new Error("no request expected");
      };

      writeLarkTaskWorkflowFile(workflowFilePath(), { tasklist_guid: undefined });
      const noBoard = await fetchCandidateIssues({ requestFun: guard });
      expect(noBoard.ok).toBe(false);
      if (!noBoard.ok) {
        expect(noBoard.error.tag).toBe("missing_lark_task_tasklist");
        expect(noBoard.error.code).toBe("missing_config");
      }

      writeLarkTaskWorkflowFile(workflowFilePath(), { app_secret: undefined });
      const noCreds = await fetchCandidateIssues({ requestFun: guard });
      expect(noCreds.ok).toBe(false);
      if (!noCreds.ok) {
        expect(noCreds.error.tag).toBe("missing_lark_task_credentials");
        expect(noCreds.error.code).toBe("missing_credentials");
      }
    });
  });

  describe("fetchIssuesByStates", () => {
    test("lists only sections matching the requested states, without a completed filter", async () => {
      const calls: Call[] = [];
      const transport = fakeTransport(calls, [
        listResponse([
          section("sec-todo", "Todo"),
          section("sec-done", "Done"),
          section("sec-cancelled", "Cancelled"),
        ]),
        listResponse([summary("guid-9", "Finished")]),
        listResponse([]),
      ]);

      const result = await fetchIssuesByStates(["Done", "Cancelled", "Done"], {
        requestFun: transport,
      });
      expect(result.ok).toBe(true);
      if (!result.ok) {
        return;
      }
      expect(result.value.map((issue) => [issue.id, issue.state])).toEqual([["guid-9", "Done"]]);

      const requests = apiCalls(calls);
      expect(requests.map((call) => call.url)).toEqual([
        expect.stringContaining(`${SECTIONS_URL}?resource_type=tasklist`),
        expect.stringContaining(`${SECTIONS_URL}/sec-done/tasks?`),
        expect.stringContaining(`${SECTIONS_URL}/sec-cancelled/tasks?`),
      ]);
      for (const call of requests.slice(1)) {
        expect(call.url).not.toContain("completed=");
      }
    });

    test("returns [] for an empty state list without any request", async () => {
      const guard: RequestFun = () => {
        throw new Error("no request expected");
      };
      expect(await fetchIssuesByStates([], { requestFun: guard })).toEqual({
        ok: true,
        value: [],
      });
    });
  });

  describe("fetchIssueStatesByIds", () => {
    test("refreshes state per id via task detail gets", async () => {
      const calls: Call[] = [];
      const transport = fakeTransport(calls, [
        listResponse([section("sec-todo", "Todo"), section("sec-done", "Done")]),
        taskResponse({
          guid: "guid-1",
          summary: "One",
          tasklists: [{ tasklist_guid: "tlg-TEST", section_guid: "sec-done" }],
        }),
        taskResponse({
          guid: "guid-2",
          summary: "Two",
          tasklists: [{ tasklist_guid: "tlg-TEST", section_guid: "sec-todo" }],
        }),
      ]);

      const result = await fetchIssueStatesByIds(["guid-1", "guid-2", "guid-1"], {
        requestFun: transport,
      });
      expect(result.ok).toBe(true);
      if (!result.ok) {
        return;
      }
      // Fresh states come from the detail's section membership; duplicate
      // ids are deduplicated and order follows the request.
      expect(result.value.map((issue) => [issue.id, issue.state])).toEqual([
        ["guid-1", "Done"],
        ["guid-2", "Todo"],
      ]);
      const gets = apiCalls(calls).filter((call) => call.url.includes("/task/v2/tasks/"));
      expect(gets.map((call) => call.url)).toEqual([
        expect.stringContaining("/open-apis/task/v2/tasks/guid-1?user_id_type=open_id"),
        expect.stringContaining("/open-apis/task/v2/tasks/guid-2?user_id_type=open_id"),
      ]);
    });

    test("skips deleted (HTTP 404) tasks and tasks that left the board", async () => {
      const errorSpy = spyOn(logger, "error").mockImplementation(() => {});
      const transport = fakeTransport(
        [],
        [
          listResponse([section("sec-todo", "Todo")]),
          { status: 404, body: { code: 144999, msg: "task not found" } },
          taskResponse({
            guid: "guid-2",
            summary: "Moved away",
            tasklists: [{ tasklist_guid: "tlg-OTHER", section_guid: "sec-x" }],
          }),
          taskResponse({
            guid: "guid-3",
            summary: "Still here",
            tasklists: [{ tasklist_guid: "tlg-TEST", section_guid: "sec-todo" }],
          }),
        ],
      );

      const result = await fetchIssueStatesByIds(["guid-1", "guid-2", "guid-3"], {
        requestFun: transport,
      });
      expect(result.ok).toBe(true);
      if (!result.ok) {
        return;
      }
      expect(result.value.map((issue) => issue.id)).toEqual(["guid-3"]);
      errorSpy.mockRestore();
    });

    test("skips checkbox-completed tasks so revalidation cannot redispatch them", async () => {
      const transport = fakeTransport(
        [],
        [
          listResponse([section("sec-todo", "Todo")]),
          taskResponse({
            guid: "guid-1",
            summary: "Checked off in an active section",
            completed_at: "1767398400000",
            tasklists: [{ tasklist_guid: "tlg-TEST", section_guid: "sec-todo" }],
          }),
          taskResponse({
            guid: "guid-2",
            summary: "Still open",
            completed_at: "0",
            tasklists: [{ tasklist_guid: "tlg-TEST", section_guid: "sec-todo" }],
          }),
        ],
      );

      const result = await fetchIssueStatesByIds(["guid-1", "guid-2"], { requestFun: transport });
      expect(result.ok).toBe(true);
      if (!result.ok) {
        return;
      }
      expect(result.value.map((issue) => issue.id)).toEqual(["guid-2"]);
    });

    test("propagates non-404 failures instead of dropping live items", async () => {
      const errorSpy = spyOn(logger, "error").mockImplementation(() => {});
      const transport = fakeTransport(
        [],
        [
          listResponse([section("sec-todo", "Todo")]),
          { status: 500, body: { code: 999, msg: "boom" } },
        ],
      );

      const result = await fetchIssueStatesByIds(["guid-1"], { requestFun: transport });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.tag).toBe("lark_task_api_status");
        expect(result.error.code).toBe("provider_status");
      }
      errorSpy.mockRestore();
    });

    test("returns [] for an empty id list without any request", async () => {
      const guard: RequestFun = () => {
        throw new Error("no request expected");
      };
      expect(await fetchIssueStatesByIds([], { requestFun: guard })).toEqual({
        ok: true,
        value: [],
      });
    });
  });

  describe("updateTaskState", () => {
    test("moves the task into the section named after the state", async () => {
      const calls: Call[] = [];
      const transport = fakeTransport(calls, [
        listResponse([section("sec-todo", "Todo"), section("sec-done", "Done")]),
        { status: 200, body: { code: 0, msg: "success", data: { task: {} } } },
      ]);

      const result = await updateTaskState("guid-1", "Done", { requestFun: transport });
      expect(result).toEqual({ ok: true, value: undefined });

      const move = apiCalls(calls)[1];
      expect(move?.method).toBe("POST");
      expect(move?.url).toContain("/open-apis/task/v2/tasks/guid-1/add_tasklist");
      expect(move?.body).toEqual({ tasklist_guid: "tlg-TEST", section_guid: "sec-done" });
    });

    test("accepts a response echo that confirms the section move", async () => {
      const transport = fakeTransport(
        [],
        [
          listResponse([section("sec-done", "Done")]),
          taskResponse({
            guid: "guid-1",
            tasklists: [{ tasklist_guid: "tlg-TEST", section_guid: "sec-done" }],
          }),
        ],
      );

      expect(await updateTaskState("guid-1", "Done", { requestFun: transport })).toEqual({
        ok: true,
        value: undefined,
      });
    });

    test("fails when the response echo shows the task still in the old section", async () => {
      const transport = fakeTransport(
        [],
        [
          listResponse([section("sec-todo", "Todo"), section("sec-done", "Done")]),
          taskResponse({
            guid: "guid-1",
            tasklists: [{ tasklist_guid: "tlg-TEST", section_guid: "sec-todo" }],
          }),
        ],
      );

      const result = await updateTaskState("guid-1", "Done", { requestFun: transport });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.tag).toBe("lark_task_state_update_unconfirmed");
        expect(result.error.code).toBe("provider_error");
      }
    });

    test("matches section names case-insensitively when no exact match exists", async () => {
      const calls: Call[] = [];
      const transport = fakeTransport(calls, [
        listResponse([section("sec-done", "done")]),
        { status: 200, body: { code: 0, msg: "success", data: { task: {} } } },
      ]);

      const result = await updateTaskState("guid-1", "Done", { requestFun: transport });
      expect(result).toEqual({ ok: true, value: undefined });
      expect(apiCalls(calls)[1]?.body).toEqual({
        tasklist_guid: "tlg-TEST",
        section_guid: "sec-done",
      });
    });

    test("rejects state names outside the section vocabulary without writing", async () => {
      const calls: Call[] = [];
      const transport = fakeTransport(calls, [listResponse([section("sec-todo", "Todo")])]);

      const result = await updateTaskState("guid-1", "Shipped", { requestFun: transport });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.tag).toBe("lark_task_unknown_state");
        expect(result.error.code).toBe("provider_error");
        expect(result.error.message).toContain('"Shipped"');
      }
      expect(apiCalls(calls)).toHaveLength(1);
    });
  });

  describe("createTaskComment", () => {
    test("posts a task-scoped comment", async () => {
      const calls: Call[] = [];
      const transport = fakeTransport(calls, [
        { status: 200, body: { code: 0, msg: "success", data: { comment: { id: "7001" } } } },
      ]);

      const result = await createTaskComment("guid-1", "All checks green.", {
        requestFun: transport,
      });
      expect(result).toEqual({ ok: true, value: undefined });

      const post = apiCalls(calls)[0];
      expect(post?.method).toBe("POST");
      expect(post?.url).toContain("/open-apis/task/v2/comments");
      expect(post?.body).toEqual({
        content: "All checks green.",
        resource_type: "task",
        resource_id: "guid-1",
      });
    });

    test("surfaces Lark business errors with the lark_task tag namespace", async () => {
      const transport = fakeTransport(
        [],
        [{ status: 200, body: { code: 190004, msg: "no permission" } }],
      );

      const result = await createTaskComment("guid-1", "hello", { requestFun: transport });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.tag).toBe("lark_task_api_error");
        expect(result.error.code).toBe("provider_error");
        expect(result.error.detail).toEqual({ code: 190004, msg: "no permission" });
      }
    });
  });

  describe("tenant token lifecycle", () => {
    test("reuses the cached token across reads and refetches after a reset", async () => {
      const calls: Call[] = [];
      const transport = fakeTransport(
        calls,
        [listResponse([]), listResponse([]), listResponse([])],
        [tokenResponse("t-token-1"), tokenResponse("t-token-2")],
      );

      expect((await fetchCandidateIssues({ requestFun: transport })).ok).toBe(true);
      expect((await fetchCandidateIssues({ requestFun: transport })).ok).toBe(true);
      expect(calls.filter((call) => call.url.endsWith(TOKEN_URL_SUFFIX))).toHaveLength(1);

      // teardownWorkflow's reset seam: a cleared cache forces a new token.
      resetTokenCacheForTest();
      expect((await fetchCandidateIssues({ requestFun: transport })).ok).toBe(true);
      expect(calls.filter((call) => call.url.endsWith(TOKEN_URL_SUFFIX))).toHaveLength(2);
      const lastApiCall = apiCalls(calls).at(-1);
      expect(lastApiCall?.headers.Authorization).toBe("Bearer t-token-2");
    });

    test("drops the cached token and retries once on HTTP 401", async () => {
      const calls: Call[] = [];
      const transport = fakeTransport(
        calls,
        [{ status: 401, body: { code: 99991661, msg: "token expired" } }, listResponse([])],
        [tokenResponse("t-stale"), tokenResponse("t-fresh")],
      );

      const result = await fetchCandidateIssues({ requestFun: transport });
      expect(result).toEqual({ ok: true, value: [] });
      const sectionCalls = apiCalls(calls);
      expect(sectionCalls).toHaveLength(2);
      expect(sectionCalls[0]?.headers.Authorization).toBe("Bearer t-stale");
      expect(sectionCalls[1]?.headers.Authorization).toBe("Bearer t-fresh");
    });
  });
});
