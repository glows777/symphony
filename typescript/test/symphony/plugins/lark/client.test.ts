import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { logger } from "../../../../src/symphony/logger.ts";
import {
  type RequestFun,
  fetchCandidateIssues,
  fetchIssueStatesByIds,
  fetchIssuesByStates,
  normalizeRecordForTest,
  request,
  resetTokenCacheForTest,
} from "../../../../src/symphony/plugins/lark/client.ts";
import { workflowFilePath } from "../../../../src/symphony/workflow.ts";
import { setupWorkflow, teardownWorkflow } from "../../../support/test-support.ts";
import { writeLarkWorkflowFile } from "./lark-test-support.ts";

type Call = { method: string; url: string; headers: Record<string, string>; body: unknown };

const TOKEN_URL_SUFFIX = "/open-apis/auth/v3/tenant_access_token/internal";

function tokenResponse(token = "t-token-1", expire = 7_200) {
  return { status: 200, body: { code: 0, msg: "ok", tenant_access_token: token, expire } };
}

function searchResponse(items: unknown[], hasMore = false, pageToken: string | null = null) {
  return {
    status: 200,
    body: {
      code: 0,
      msg: "success",
      data: { items, has_more: hasMore, ...(pageToken === null ? {} : { page_token: pageToken }) },
    },
  };
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

function rawRecord(recordId: string, fields: Record<string, unknown>, extra: object = {}) {
  return { record_id: recordId, fields, ...extra };
}

describe("Lark.Client", () => {
  let root: string;

  beforeEach(() => {
    ({ root } = setupWorkflow());
    writeLarkWorkflowFile(workflowFilePath());
    resetTokenCacheForTest();
  });

  afterEach(() => {
    teardownWorkflow(root);
  });

  describe("normalizeRecord", () => {
    test("maps a full record onto the WorkItem model", () => {
      const issue = normalizeRecordForTest(
        rawRecord(
          "recAAA",
          {
            Title: [{ type: "text", text: "Fix the parser" }],
            Status: "Todo",
            Description: "Multi-line\nbody",
            Labels: ["Backend ", "URGENT"],
            Assignee: [{ id: "ou_user1", name: "User One" }],
          },
          { created_time: 1_767_225_600_000, last_modified_time: 1_767_312_000_000 },
        ),
      );
      expect(issue).not.toBeNull();
      if (!issue) {
        return;
      }
      expect(issue.id).toBe("recAAA");
      expect(issue.identifier).toBe("recAAA");
      expect(issue.title).toBe("Fix the parser");
      expect(issue.state).toBe("Todo");
      expect(issue.description).toBe("Multi-line\nbody");
      expect(issue.labels).toEqual(["backend", "urgent"]);
      expect(issue.assigneeId).toBe("ou_user1");
      expect(issue.assignedToWorker).toBe(true);
      expect(issue.blockedBy).toEqual([]);
      expect(issue.priority).toBeNull();
      expect(issue.url).toBe("https://feishu.cn/base/bascnTEST?table=tblTEST&record=recAAA");
      expect(issue.createdAt).toEqual(new Date(1_767_225_600_000));
      expect(issue.updatedAt).toEqual(new Date(1_767_312_000_000));
      expect(issue.metadata).toEqual({
        app_token: "bascnTEST",
        table_id: "tblTEST",
        record_id: "recAAA",
      });
    });

    test("accepts option-object single selects and blank-normalizes text", () => {
      const issue = normalizeRecordForTest(
        rawRecord("recBBB", {
          Title: "Plain title",
          Status: { text: "In Progress", color: 1 },
          Description: "   ",
        }),
      );
      expect(issue?.state).toBe("In Progress");
      expect(issue?.title).toBe("Plain title");
      expect(issue?.description).toBeNull();
    });

    test("marks records assigned to someone else as not routed to worker", () => {
      const record = rawRecord("recCCC", {
        Title: "Someone else's record",
        Status: "Todo",
        Assignee: [{ id: "ou_user2", name: "User Two" }],
      });
      expect(normalizeRecordForTest(record, "ou_user1")?.assignedToWorker).toBe(false);
      expect(normalizeRecordForTest(record, "ou_user2")?.assignedToWorker).toBe(true);

      const unassigned = rawRecord("recDDD", { Title: "Unassigned", Status: "Todo" });
      expect(normalizeRecordForTest(unassigned, "ou_user1")?.assignedToWorker).toBe(false);
      expect(normalizeRecordForTest(unassigned)?.assignedToWorker).toBe(true);
    });

    test("maps configured identifier and priority fields with fallbacks", () => {
      writeLarkWorkflowFile(workflowFilePath(), {
        field_identifier: "Key",
        field_priority: "Priority",
      });

      const full = normalizeRecordForTest(
        rawRecord("recEEE", { Title: "T", Status: "Todo", Key: 42, Priority: 2 }),
      );
      expect(full?.identifier).toBe("42");
      expect(full?.priority).toBe(2);

      const selectPriority = normalizeRecordForTest(
        rawRecord("recFFF", { Title: "T", Status: "Todo", Priority: { text: "3" } }),
      );
      expect(selectPriority?.identifier).toBe("recFFF");
      expect(selectPriority?.priority).toBe(3);

      const invalidPriority = normalizeRecordForTest(
        rawRecord("recGGG", { Title: "T", Status: "Todo", Priority: "High" }),
      );
      expect(invalidPriority?.priority).toBeNull();

      const fractional = normalizeRecordForTest(
        rawRecord("recHHH", { Title: "T", Status: "Todo", Priority: 1.5 }),
      );
      expect(fractional?.priority).toBeNull();
    });

    test("honors renamed fields from WORKFLOW.md", () => {
      writeLarkWorkflowFile(workflowFilePath(), {
        field_state: "状态",
        field_title: "标题",
      });
      const issue = normalizeRecordForTest(
        rawRecord("recIII", { 标题: "中文标题", 状态: "进行中" }),
      );
      expect(issue?.title).toBe("中文标题");
      expect(issue?.state).toBe("进行中");
    });
  });

  describe("search reads", () => {
    test("fetchCandidateIssues filters by active states and requested fields", async () => {
      const calls: Call[] = [];
      const requestFun = fakeTransport(calls, [
        searchResponse([rawRecord("rec1", { Title: "One", Status: "Todo" })]),
      ]);

      const result = await fetchCandidateIssues({ requestFun });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.map((i) => i.id)).toEqual(["rec1"]);
      }

      const searchCall = calls.at(-1);
      expect(searchCall?.method).toBe("POST");
      expect(searchCall?.url).toBe(
        "https://open.feishu.cn/open-apis/bitable/v1/apps/bascnTEST/tables/tblTEST/records/search?page_size=500",
      );
      expect(searchCall?.headers.Authorization).toBe("Bearer t-token-1");
      expect(searchCall?.body).toEqual({
        filter: {
          conjunction: "or",
          conditions: [
            { field_name: "Status", operator: "is", value: ["Todo"] },
            { field_name: "Status", operator: "is", value: ["In Progress"] },
          ],
        },
        field_names: ["Title", "Status", "Description", "Labels", "Assignee"],
        automatic_fields: true,
      });
    });

    test("fetchIssuesByStates builds the filter from the requested states", async () => {
      const calls: Call[] = [];
      const requestFun = fakeTransport(calls, [searchResponse([])]);

      const result = await fetchIssuesByStates(["Done", "Cancelled", "Done"], { requestFun });
      expect(result).toEqual({ ok: true, value: [] });

      const body = calls.at(-1)?.body as { filter: { conditions: unknown[] } };
      expect(body.filter.conditions).toEqual([
        { field_name: "Status", operator: "is", value: ["Done"] },
        { field_name: "Status", operator: "is", value: ["Cancelled"] },
      ]);
    });

    test("follows page_token pagination across pages", async () => {
      const calls: Call[] = [];
      const requestFun = fakeTransport(calls, [
        searchResponse([rawRecord("rec1", { Title: "One", Status: "Todo" })], true, "cursor-1"),
        searchResponse([rawRecord("rec2", { Title: "Two", Status: "Todo" })]),
      ]);

      const result = await fetchIssuesByStates(["Todo"], { requestFun });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.map((i) => i.id)).toEqual(["rec1", "rec2"]);
      }

      const searchUrls = calls.map((c) => c.url).filter((url) => url.includes("/records/search"));
      expect(searchUrls).toEqual([
        "https://open.feishu.cn/open-apis/bitable/v1/apps/bascnTEST/tables/tblTEST/records/search?page_size=500",
        "https://open.feishu.cn/open-apis/bitable/v1/apps/bascnTEST/tables/tblTEST/records/search?page_size=500&page_token=cursor-1",
      ]);
    });

    test("reports a missing page_token on truncated pagination payloads", async () => {
      const requestFun = fakeTransport([], [searchResponse([], true, null)]);
      const result = await fetchIssuesByStates(["Todo"], { requestFun });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.tag).toBe("lark_missing_page_token");
        expect(result.error.code).toBe("invalid_payload");
      }
    });

    test("returns empty results for empty inputs without a request", async () => {
      expect(await fetchIssuesByStates([])).toEqual({ ok: true, value: [] });
      expect(await fetchIssueStatesByIds([])).toEqual({ ok: true, value: [] });
    });

    test("reports missing table configuration with stable tags", async () => {
      writeLarkWorkflowFile(workflowFilePath(), { table_id: undefined });
      const byStates = await fetchIssuesByStates(["Todo"]);
      expect(byStates.ok).toBe(false);
      if (!byStates.ok) {
        expect(byStates.error.tag).toBe("missing_lark_table_id");
      }

      writeLarkWorkflowFile(workflowFilePath(), { app_token: undefined });
      const candidates = await fetchCandidateIssues();
      expect(candidates.ok).toBe(false);
      if (!candidates.ok) {
        expect(candidates.error.tag).toBe("missing_lark_app_token");
      }

      Reflect.deleteProperty(process.env, "LARK_APP_SECRET");
      writeLarkWorkflowFile(workflowFilePath(), { app_secret: undefined });
      const noAuth = await fetchIssueStatesByIds(["rec1"]);
      expect(noAuth.ok).toBe(false);
      if (!noAuth.ok) {
        expect(noAuth.error.tag).toBe("missing_lark_app_credentials");
        expect(noAuth.error.code).toBe("missing_credentials");
      }
    });
  });

  describe("fetchIssueStatesByIds", () => {
    test("splits ids into batch_get chunks of 100 and preserves request order", async () => {
      const ids = Array.from({ length: 105 }, (_, i) => `rec-${i + 1}`);
      const calls: Call[] = [];
      const batchResponse = (batchIds: string[]) => ({
        status: 200,
        body: {
          code: 0,
          msg: "success",
          data: {
            // Reversed to prove the client re-sorts by the requested order.
            records: [...batchIds]
              .reverse()
              .map((id) => rawRecord(id, { Title: `Item ${id}`, Status: "In Progress" })),
            absent_record_ids: [],
            forbidden_record_ids: [],
          },
        },
      });
      const requestFun = fakeTransport(calls, [
        batchResponse(ids.slice(0, 100)),
        batchResponse(ids.slice(100)),
      ]);

      const result = await fetchIssueStatesByIds(ids, { requestFun });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.map((i) => i.id)).toEqual(ids);
      }

      const batchCalls = calls.filter((c) => c.url.includes("/records/batch_get"));
      expect(batchCalls).toHaveLength(2);
      expect(batchCalls[0]?.body).toEqual({
        record_ids: ids.slice(0, 100),
        automatic_fields: true,
        with_shared_url: false,
      });
      expect(batchCalls[1]?.body).toEqual({
        record_ids: ids.slice(100),
        automatic_fields: true,
        with_shared_url: false,
      });
    });

    test("skips absent records and dedupes requested ids", async () => {
      const calls: Call[] = [];
      const requestFun = fakeTransport(calls, [
        {
          status: 200,
          body: {
            code: 0,
            data: {
              records: [rawRecord("rec-1", { Title: "One", Status: "Done" })],
              absent_record_ids: ["rec-gone"],
            },
          },
        },
      ]);

      const result = await fetchIssueStatesByIds(["rec-1", "rec-gone", "rec-1"], { requestFun });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.map((i) => i.id)).toEqual(["rec-1"]);
      }
      const batchCall = calls.at(-1);
      expect((batchCall?.body as { record_ids: string[] }).record_ids).toEqual([
        "rec-1",
        "rec-gone",
      ]);
    });
  });

  describe("tenant_access_token lifecycle", () => {
    test("caches the token across requests and refreshes after expiry", async () => {
      const calls: Call[] = [];
      const tokens = [tokenResponse("t-token-1", 7_200), tokenResponse("t-token-2", 7_200)];
      const requestFun = fakeTransport(
        calls,
        [searchResponse([]), searchResponse([]), searchResponse([])],
        tokens,
      );

      expect((await fetchIssuesByStates(["Todo"], { requestFun })).ok).toBe(true);
      expect((await fetchIssuesByStates(["Todo"], { requestFun })).ok).toBe(true);
      let tokenCalls = calls.filter((c) => c.url.endsWith(TOKEN_URL_SUFFIX));
      expect(tokenCalls).toHaveLength(1);
      expect(tokenCalls[0]?.body).toEqual({ app_id: "cli_test_app", app_secret: "test-secret" });

      // A token expiring inside the 5-minute refresh margin is re-fetched.
      resetTokenCacheForTest();
      calls.length = 0;
      tokens.length = 0;
      tokens.push(tokenResponse("t-token-3", 60), tokenResponse("t-token-4", 7_200));
      const shortLived = fakeTransport(calls, [searchResponse([]), searchResponse([])], tokens);
      expect((await fetchIssuesByStates(["Todo"], { requestFun: shortLived })).ok).toBe(true);
      expect((await fetchIssuesByStates(["Todo"], { requestFun: shortLived })).ok).toBe(true);
      tokenCalls = calls.filter((c) => c.url.endsWith(TOKEN_URL_SUFFIX));
      expect(tokenCalls).toHaveLength(2);

      const searchCalls = calls.filter((c) => c.url.includes("/records/search"));
      expect(searchCalls.map((c) => c.headers.Authorization)).toEqual([
        "Bearer t-token-3",
        "Bearer t-token-4",
      ]);
    });

    test("drops the cached token and retries once on invalid-token responses", async () => {
      const calls: Call[] = [];
      const requestFun = fakeTransport(
        calls,
        [
          { status: 200, body: { code: 99991663, msg: "tenant access token invalid" } },
          searchResponse([rawRecord("rec1", { Title: "One", Status: "Todo" })]),
        ],
        [tokenResponse("t-stale", 7_200), tokenResponse("t-fresh", 7_200)],
      );

      const result = await fetchIssuesByStates(["Todo"], { requestFun });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.map((i) => i.id)).toEqual(["rec1"]);
      }

      const searchCalls = calls.filter((c) => c.url.includes("/records/search"));
      expect(searchCalls.map((c) => c.headers.Authorization)).toEqual([
        "Bearer t-stale",
        "Bearer t-fresh",
      ]);
    });

    test("does not loop when the retried request still reports an invalid token", async () => {
      const errorSpy = spyOn(logger, "error").mockImplementation(() => {});
      try {
        const invalid = { status: 401, body: { code: 99991663, msg: "invalid" } };
        const requestFun = fakeTransport(
          [],
          [invalid, invalid],
          [tokenResponse("t-1"), tokenResponse("t-2")],
        );

        const result = await fetchIssuesByStates(["Todo"], { requestFun });
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error).toEqual({
            tag: "lark_api_status",
            code: "provider_status",
            message: "Lark API request failed with HTTP 401",
            status: 401,
          } as never);
        }
      } finally {
        errorSpy.mockRestore();
      }
    });

    test("propagates token endpoint business errors", async () => {
      const requestFun = fakeTransport(
        [],
        [],
        [{ status: 200, body: { code: 10003, msg: "invalid app_secret" } }],
      );
      const result = await fetchIssuesByStates(["Todo"], { requestFun });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toEqual({
          tag: "lark_api_error",
          code: "provider_error",
          message: "Lark API returned error code 10003: invalid app_secret",
          detail: { code: 10003, msg: "invalid app_secret" },
        });
      }
    });
  });

  describe("request error mapping", () => {
    test("maps HTTP status, business errors, transport failures, and odd payloads", async () => {
      const errorSpy = spyOn(logger, "error").mockImplementation(() => {});
      try {
        const status = await request("GET", "/open-apis/x", null, {
          requestFun: fakeTransport([], [{ status: 500, body: { code: 1, msg: "boom" } }]),
        });
        expect(status.ok).toBe(false);
        if (!status.ok) {
          expect(status.error.tag).toBe("lark_api_status");
          expect(status.error.code).toBe("provider_status");
        }

        const business = await request("GET", "/open-apis/x", null, {
          requestFun: fakeTransport(
            [],
            [{ status: 200, body: { code: 1254045, msg: "FieldNameNotFound" } }],
          ),
        });
        expect(business.ok).toBe(false);
        if (!business.ok) {
          expect(business.error.tag).toBe("lark_api_error");
          expect(business.error.detail).toEqual({ code: 1254045, msg: "FieldNameNotFound" });
        }

        const transport = await request("GET", "/open-apis/x", null, {
          requestFun: (method, url) =>
            url.endsWith(TOKEN_URL_SUFFIX)
              ? { ok: true, value: tokenResponse() }
              : { ok: false, error: "timeout" },
        });
        expect(transport.ok).toBe(false);
        if (!transport.ok) {
          expect(transport.error.tag).toBe("lark_api_request");
          expect(transport.error.code).toBe("transport_failed");
        }

        const weird = await request("GET", "/open-apis/x", null, {
          requestFun: fakeTransport([], [{ status: 200, body: "not json object" }]),
        });
        expect(weird.ok).toBe(false);
        if (!weird.ok) {
          expect(weird.error.tag).toBe("lark_unknown_payload");
          expect(weird.error.code).toBe("invalid_payload");
        }

        const logged = errorSpy.mock.calls.map((c) => String(c[0])).join("\n");
        expect(logged).toContain("Lark API request failed status=500");
      } finally {
        errorSpy.mockRestore();
      }
    });
  });
});
