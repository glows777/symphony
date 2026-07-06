import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { putEnv } from "../../../../src/symphony/app-env.ts";
import { settingsBang, validate } from "../../../../src/symphony/config.ts";
import type { LarkClientModule } from "../../../../src/symphony/plugins/lark/client.ts";
import { LarkPlugin } from "../../../../src/symphony/plugins/lark/plugin.ts";
import { larkSettings } from "../../../../src/symphony/plugins/lark/settings.ts";
import { newIssue } from "../../../../src/symphony/plugins/work-item.ts";
import { err, ok } from "../../../../src/symphony/result.ts";
import * as Tracker from "../../../../src/symphony/tracker/tracker.ts";
import { workflowFilePath } from "../../../../src/symphony/workflow.ts";
import { setupWorkflow, teardownWorkflow } from "../../../support/test-support.ts";
import { writeLarkWorkflowFile } from "./lark-test-support.ts";

describe("Lark.Plugin", () => {
  let root: string;

  beforeEach(() => {
    ({ root } = setupWorkflow());
  });

  afterEach(() => {
    teardownWorkflow(root);
  });

  describe("configSchema", () => {
    test("kind lark parses and validates with the required config", () => {
      writeLarkWorkflowFile(workflowFilePath());
      expect(validate()).toEqual({ ok: true, value: undefined });

      const lark = larkSettings(settingsBang());
      expect(lark.endpoint).toBe("https://open.feishu.cn");
      expect(lark.appId).toBe("cli_test_app");
      expect(lark.appSecret).toBe("test-secret");
      expect(lark.appToken).toBe("bascnTEST");
      expect(lark.tableId).toBe("tblTEST");
      expect(lark.assignee).toBeNull();
    });

    test("cast applies the documented field-name defaults", () => {
      writeLarkWorkflowFile(workflowFilePath());
      const lark = larkSettings(settingsBang());
      expect(lark.fieldState).toBe("Status");
      expect(lark.fieldTitle).toBe("Title");
      expect(lark.fieldDescription).toBe("Description");
      expect(lark.fieldLabels).toBe("Labels");
      expect(lark.fieldAssignee).toBe("Assignee");
      expect(lark.fieldIdentifier).toBeNull();
      expect(lark.fieldPriority).toBeNull();
    });

    test("cast keeps overridden field names and reports invalid types", () => {
      writeLarkWorkflowFile(workflowFilePath(), {
        field_state: "状态",
        field_identifier: "编号",
      });
      const lark = larkSettings(settingsBang());
      expect(lark.fieldState).toBe("状态");
      expect(lark.fieldIdentifier).toBe("编号");

      writeLarkWorkflowFile(workflowFilePath(), { app_id: 123 });
      const invalid = validate();
      expect(invalid.ok).toBe(false);
      if (!invalid.ok) {
        const error = invalid.error as { tag: string; message: string };
        expect(error.tag).toBe("invalid_workflow_config");
        expect(error.message).toContain("tracker.app_id");
      }
    });

    test("finalize resolves $VAR references and the LARK_APP_SECRET fallback", () => {
      const unique = `${process.pid}_${Math.floor(Math.random() * 1e9)}`;
      const secretEnv = `SYMP_LARK_SECRET_${unique}`;
      process.env[secretEnv] = "resolved-secret";
      try {
        writeLarkWorkflowFile(workflowFilePath(), { app_secret: `$${secretEnv}` });
        expect(larkSettings(settingsBang()).appSecret).toBe("resolved-secret");
      } finally {
        Reflect.deleteProperty(process.env, secretEnv);
      }

      process.env.LARK_APP_SECRET = "canonical-secret";
      try {
        writeLarkWorkflowFile(workflowFilePath(), { app_secret: undefined });
        expect(larkSettings(settingsBang()).appSecret).toBe("canonical-secret");
        expect(validate()).toEqual({ ok: true, value: undefined });
      } finally {
        Reflect.deleteProperty(process.env, "LARK_APP_SECRET");
      }
    });

    test("validate reports missing credentials, app_token, and table_id", () => {
      Reflect.deleteProperty(process.env, "LARK_APP_SECRET");
      const cases: [Record<string, unknown>, string, string][] = [
        [{ app_id: undefined }, "missing_lark_app_credentials", "missing_credentials"],
        [{ app_secret: undefined }, "missing_lark_app_credentials", "missing_credentials"],
        [{ app_token: undefined }, "missing_lark_app_token", "missing_config"],
        [{ table_id: undefined }, "missing_lark_table_id", "missing_config"],
      ];

      for (const [overrides, tag, code] of cases) {
        writeLarkWorkflowFile(workflowFilePath(), overrides);
        const result = validate();
        expect(result.ok).toBe(false);
        if (!result.ok) {
          const error = result.error as { tag: string; code: string };
          expect(error.tag).toBe(tag);
          expect(error.code).toBe(code);
        }
      }
    });
  });

  describe("capabilities", () => {
    test("omits comments (no public record-comment API)", () => {
      expect(LarkPlugin.comments).toBeUndefined();
    });

    test("facade delegates reads and state updates to the injected client module", async () => {
      writeLarkWorkflowFile(workflowFilePath());
      const issue = newIssue({ id: "recAAA", identifier: "recAAA", state: "Todo" });
      const updates: { recordId: string; stateName: string }[] = [];
      const fake: LarkClientModule = {
        fetchCandidateIssues: () => Promise.resolve(ok([issue])),
        fetchIssuesByStates: (states) =>
          Promise.resolve(states.includes("Todo") ? ok([issue]) : ok([])),
        fetchIssueStatesByIds: (ids) =>
          Promise.resolve(ids.includes("recAAA") ? ok([issue]) : ok([])),
        updateRecordState: (recordId, stateName) => {
          updates.push({ recordId, stateName });
          return Promise.resolve(ok(undefined));
        },
      };
      putEnv("lark_client_module", fake);

      expect(Tracker.adapter()).toBe(LarkPlugin);
      expect(await Tracker.fetchCandidateIssues()).toEqual(ok([issue]));
      expect(await Tracker.fetchIssuesByStates(["Todo"])).toEqual(ok([issue]));
      expect(await Tracker.fetchIssuesByStates(["Missing"])).toEqual(ok([]));
      expect(await Tracker.fetchIssueStatesByIds(["recAAA"])).toEqual(ok([issue]));
      expect(await Tracker.updateIssueState("recAAA", "Done")).toEqual(ok(undefined));
      expect(updates).toEqual([{ recordId: "recAAA", stateName: "Done" }]);
    });

    test("facade reports comments as unsupported instead of faking success", async () => {
      writeLarkWorkflowFile(workflowFilePath());
      const result = await Tracker.createComment("recAAA", "hello");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toEqual({
          tag: "tracker_capability_unsupported",
          code: "unsupported_operation",
          message: "tracker 'lark' does not support comments",
        });
      }
    });

    test("normalizes foreign errors from the injected module", async () => {
      writeLarkWorkflowFile(workflowFilePath());
      const fake: LarkClientModule = {
        fetchCandidateIssues: () => Promise.resolve(ok([])),
        fetchIssuesByStates: () => Promise.resolve(ok([])),
        fetchIssueStatesByIds: () => Promise.resolve(ok([])),
        updateRecordState: () => Promise.resolve(err("boom")),
      };
      putEnv("lark_client_module", fake);

      expect(await Tracker.updateIssueState("recAAA", "Done")).toEqual(
        err({
          tag: "tracker_error",
          code: "unknown",
          message: "Tracker operation failed: :boom",
          detail: "boom",
        }),
      );
    });
  });

  describe("agentTools", () => {
    type ApiCall = { method: string; path: string; body: unknown };

    function recordingApiClient(result: unknown, calls: ApiCall[]) {
      return (method: string, path: string, body: unknown) => {
        calls.push({ method, path, body });
        return result as never;
      };
    }

    const guardClient = () => {
      throw new Error("lark client should not be called");
    };

    test("advertises the lark_api input contract", () => {
      const specs = LarkPlugin.agentTools?.listAgentTools() ?? [];
      expect(specs).toHaveLength(1);
      const spec = specs[0];
      expect(spec?.name).toBe("lark_api");
      const schema = spec?.inputSchema as Record<string, unknown>;
      expect(schema.type).toBe("object");
      expect(schema.required).toEqual(["method", "path"]);
      expect(Object.keys(schema.properties as object)).toEqual(["method", "path", "body"]);
      expect(spec?.description).toContain("Lark");
    });

    test("lark_api returns successful responses and normalizes the method", async () => {
      const calls: ApiCall[] = [];
      const outcome = await LarkPlugin.agentTools?.executeAgentTool(
        "lark_api",
        {
          method: "post",
          path: "/open-apis/bitable/v1/apps/bascnTEST/tables/tblTEST/records/search",
          body: { filter: { conjunction: "or", conditions: [] } },
        },
        {
          larkClient: recordingApiClient(
            ok({ code: 0, msg: "success", data: { items: [] } }),
            calls,
          ),
        },
      );

      expect(calls).toEqual([
        {
          method: "POST",
          path: "/open-apis/bitable/v1/apps/bascnTEST/tables/tblTEST/records/search",
          body: { filter: { conjunction: "or", conditions: [] } },
        },
      ]);
      expect(outcome?.success).toBe(true);
      expect(outcome?.payload).toEqual({ code: 0, msg: "success", data: { items: [] } });
    });

    test("lark_api surfaces Lark business errors as failures", async () => {
      const outcome = await LarkPlugin.agentTools?.executeAgentTool(
        "lark_api",
        { method: "PUT", path: "/open-apis/bitable/v1/apps/a/tables/t/records/r" },
        {
          larkClient: () =>
            err({
              tag: "lark_api_error",
              code: "provider_error",
              message: "Lark API returned error code 1254045: FieldNameNotFound",
              detail: { code: 1254045, msg: "FieldNameNotFound" },
            }),
        },
      );
      expect(outcome?.success).toBe(false);
      expect(outcome?.payload).toEqual({
        error: {
          message: "Lark API returned error code 1254045: FieldNameNotFound",
          code: 1254045,
          msg: "FieldNameNotFound",
        },
      });
    });

    test("lark_api validates arguments before calling Lark", async () => {
      const cases: [unknown, string][] = [
        ["not an object", "`lark_api` expects an object"],
        [{ path: "/open-apis/x" }, "requires a `method` string"],
        [{ method: "TRACE", path: "/open-apis/x" }, "must be one of GET, POST, PUT, PATCH"],
        [{ method: "GET" }, "requires a non-empty `path` string"],
        [
          { method: "GET", path: "https://evil.example/open-apis/x" },
          "must start with `/open-apis/`",
        ],
        [{ method: "GET", path: "/v1/other" }, "must start with `/open-apis/`"],
        [{ method: "GET", path: "/open-apis/x", body: ["bad"] }, "must be a JSON object"],
      ];

      for (const [args, fragment] of cases) {
        const outcome = await LarkPlugin.agentTools?.executeAgentTool("lark_api", args, {
          larkClient: guardClient,
        });
        expect(outcome?.success).toBe(false);
        const payload = outcome?.payload as { error: { message: string } };
        expect(payload.error.message).toContain(fragment);
      }
    });

    test("lark_api formats auth, status, and transport failures", async () => {
      const missingAuth = await LarkPlugin.agentTools?.executeAgentTool(
        "lark_api",
        { method: "GET", path: "/open-apis/x" },
        { larkClient: () => err({ tag: "missing_lark_app_credentials" }) },
      );
      expect((missingAuth?.payload as { error: { message: string } }).error.message).toContain(
        "LARK_APP_SECRET",
      );

      const status = await LarkPlugin.agentTools?.executeAgentTool(
        "lark_api",
        { method: "GET", path: "/open-apis/x" },
        { larkClient: () => err({ tag: "lark_api_status", status: 503 }) },
      );
      expect(status?.payload).toEqual({
        error: { message: "Lark API request failed with HTTP 503.", status: 503 },
      });

      const transport = await LarkPlugin.agentTools?.executeAgentTool(
        "lark_api",
        { method: "GET", path: "/open-apis/x" },
        { larkClient: () => err({ tag: "lark_api_request", reason: "timeout" }) },
      );
      expect(transport?.payload).toEqual({
        error: {
          message: "Lark API request failed before receiving a response.",
          reason: ":timeout",
        },
      });

      const unexpected = await LarkPlugin.agentTools?.executeAgentTool(
        "lark_api",
        { method: "GET", path: "/open-apis/x" },
        { larkClient: () => err("boom") },
      );
      expect(unexpected?.payload).toEqual({
        error: { message: "Lark API tool execution failed.", reason: ":boom" },
      });
    });

    test("lark_api reports missing credentials through the default client", async () => {
      Reflect.deleteProperty(process.env, "LARK_APP_SECRET");
      writeLarkWorkflowFile(workflowFilePath(), { app_secret: undefined });
      const outcome = await LarkPlugin.agentTools?.executeAgentTool("lark_api", {
        method: "GET",
        path: "/open-apis/x",
      });
      expect(outcome?.success).toBe(false);
      expect((outcome?.payload as { error: { message: string } }).error.message).toContain(
        "missing Lark auth",
      );
    });

    test("unknown tool names fail without dispatching", async () => {
      const outcome = await LarkPlugin.agentTools?.executeAgentTool("linear_graphql", {
        query: "query { viewer { id } }",
      });
      expect(outcome?.success).toBe(false);
      expect(outcome?.payload).toEqual({
        error: { message: 'Unsupported dynamic tool: "linear_graphql".' },
      });
    });
  });

  describe("ui", () => {
    test("projectUrl renders the Bitable table URL on the web domain", () => {
      writeLarkWorkflowFile(workflowFilePath());
      expect(LarkPlugin.ui?.projectUrl?.(settingsBang())).toBe(
        "https://feishu.cn/base/bascnTEST?table=tblTEST",
      );

      writeLarkWorkflowFile(workflowFilePath(), {
        endpoint: "https://open.larksuite.com",
      });
      expect(LarkPlugin.ui?.projectUrl?.(settingsBang())).toBe(
        "https://larksuite.com/base/bascnTEST?table=tblTEST",
      );

      writeLarkWorkflowFile(workflowFilePath(), { app_token: undefined });
      expect(LarkPlugin.ui?.projectUrl?.(settingsBang())).toBeNull();
    });

    test("uses the 'Lark record' noun and no plugin prompt template", () => {
      expect(LarkPlugin.ui?.workItemNoun).toBe("Lark record");
      // No plugin template: WORKFLOW.md-less prompts fall back to the
      // provider-neutral "work item" copy.
      expect(LarkPlugin.ui?.defaultPromptTemplate).toBeUndefined();
    });
  });
});
