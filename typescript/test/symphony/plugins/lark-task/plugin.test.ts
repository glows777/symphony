import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { putEnv } from "../../../../src/symphony/app-env.ts";
import { settingsBang, validate } from "../../../../src/symphony/config.ts";
import type { LarkTaskClientModule } from "../../../../src/symphony/plugins/lark-task/client.ts";
import { LarkTaskPlugin } from "../../../../src/symphony/plugins/lark-task/plugin.ts";
import { larkTaskSettings } from "../../../../src/symphony/plugins/lark-task/settings.ts";
import { newIssue } from "../../../../src/symphony/plugins/work-item.ts";
import { err, ok } from "../../../../src/symphony/result.ts";
import * as Tracker from "../../../../src/symphony/tracker/tracker.ts";
import { workflowFilePath } from "../../../../src/symphony/workflow.ts";
import { setupWorkflow, teardownWorkflow } from "../../../support/test-support.ts";
import { writeLarkTaskWorkflowFile } from "./lark-task-test-support.ts";

function stubClient(overrides: Partial<LarkTaskClientModule> = {}): LarkTaskClientModule {
  return {
    fetchCandidateIssues: () => Promise.resolve(ok([])),
    fetchIssuesByStates: () => Promise.resolve(ok([])),
    fetchIssueStatesByIds: () => Promise.resolve(ok([])),
    updateTaskState: () => Promise.resolve(ok(undefined)),
    createTaskComment: () => Promise.resolve(ok(undefined)),
    ...overrides,
  };
}

describe("LarkTask.Plugin", () => {
  let root: string;

  beforeEach(() => {
    ({ root } = setupWorkflow());
  });

  afterEach(() => {
    teardownWorkflow(root);
  });

  describe("configSchema", () => {
    test("kind lark-task parses and validates with the required config", () => {
      writeLarkTaskWorkflowFile(workflowFilePath());
      expect(validate()).toEqual({ ok: true, value: undefined });

      const lark = larkTaskSettings(settingsBang());
      expect(lark.endpoint).toBe("https://open.feishu.cn");
      expect(lark.appId).toBe("cli_test_app");
      expect(lark.appSecret).toBe("test-secret");
      expect(lark.tasklistGuid).toBe("tlg-TEST");
      expect(lark.assignee).toBeNull();
    });

    test("cast defaults the endpoint and reports invalid types", () => {
      writeLarkTaskWorkflowFile(workflowFilePath(), { endpoint: undefined });
      expect(larkTaskSettings(settingsBang()).endpoint).toBe("https://open.feishu.cn");

      writeLarkTaskWorkflowFile(workflowFilePath(), { tasklist_guid: 42 });
      const invalid = validate();
      expect(invalid.ok).toBe(false);
      if (!invalid.ok) {
        const error = invalid.error as { tag: string; message: string };
        expect(error.tag).toBe("invalid_workflow_config");
        expect(error.message).toContain("tracker.tasklist_guid");
      }
    });

    test("finalize resolves $VAR references and the LARK_APP_SECRET fallback", () => {
      const unique = `${process.pid}_${Math.floor(Math.random() * 1e9)}`;
      const secretEnv = `SYMP_LARK_TASK_SECRET_${unique}`;
      process.env[secretEnv] = "resolved-secret";
      try {
        writeLarkTaskWorkflowFile(workflowFilePath(), { app_secret: `$${secretEnv}` });
        expect(larkTaskSettings(settingsBang()).appSecret).toBe("resolved-secret");
      } finally {
        Reflect.deleteProperty(process.env, secretEnv);
      }

      process.env.LARK_APP_SECRET = "canonical-secret";
      try {
        writeLarkTaskWorkflowFile(workflowFilePath(), { app_secret: undefined });
        expect(larkTaskSettings(settingsBang()).appSecret).toBe("canonical-secret");
        expect(validate()).toEqual({ ok: true, value: undefined });
      } finally {
        Reflect.deleteProperty(process.env, "LARK_APP_SECRET");
      }
    });

    test("validate reports missing credentials and tasklist_guid", () => {
      Reflect.deleteProperty(process.env, "LARK_APP_SECRET");
      const cases: [Record<string, unknown>, string, string][] = [
        [{ app_id: undefined }, "missing_lark_task_credentials", "missing_credentials"],
        [{ app_secret: undefined }, "missing_lark_task_credentials", "missing_credentials"],
        [{ tasklist_guid: undefined }, "missing_lark_task_tasklist", "missing_config"],
      ];

      for (const [overrides, tag, code] of cases) {
        writeLarkTaskWorkflowFile(workflowFilePath(), overrides);
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
    test("implements every optional capability, including comments", () => {
      expect(LarkTaskPlugin.comments).toBeDefined();
      expect(LarkTaskPlugin.stateUpdates).toBeDefined();
      expect(LarkTaskPlugin.agentTools).toBeDefined();
      expect(LarkTaskPlugin.ui).toBeDefined();
    });

    test("facade delegates reads and writes to the injected client module", async () => {
      writeLarkTaskWorkflowFile(workflowFilePath());
      const issue = newIssue({ id: "guid-1", identifier: "guid-1", state: "Todo" });
      const updates: { taskGuid: string; stateName: string }[] = [];
      const comments: { taskGuid: string; body: string }[] = [];
      putEnv(
        "lark_task_client_module",
        stubClient({
          fetchCandidateIssues: () => Promise.resolve(ok([issue])),
          fetchIssuesByStates: (states) =>
            Promise.resolve(states.includes("Todo") ? ok([issue]) : ok([])),
          fetchIssueStatesByIds: (ids) =>
            Promise.resolve(ids.includes("guid-1") ? ok([issue]) : ok([])),
          updateTaskState: (taskGuid, stateName) => {
            updates.push({ taskGuid, stateName });
            return Promise.resolve(ok(undefined));
          },
          createTaskComment: (taskGuid, body) => {
            comments.push({ taskGuid, body });
            return Promise.resolve(ok(undefined));
          },
        }),
      );

      expect(Tracker.adapter()).toBe(LarkTaskPlugin);
      expect(await Tracker.fetchCandidateIssues()).toEqual(ok([issue]));
      expect(await Tracker.fetchIssuesByStates(["Todo"])).toEqual(ok([issue]));
      expect(await Tracker.fetchIssuesByStates(["Missing"])).toEqual(ok([]));
      expect(await Tracker.fetchIssueStatesByIds(["guid-1"])).toEqual(ok([issue]));
      expect(await Tracker.updateIssueState("guid-1", "Done")).toEqual(ok(undefined));
      expect(await Tracker.createComment("guid-1", "All done.")).toEqual(ok(undefined));
      expect(updates).toEqual([{ taskGuid: "guid-1", stateName: "Done" }]);
      expect(comments).toEqual([{ taskGuid: "guid-1", body: "All done." }]);
    });

    test("normalizes foreign errors from the injected module", async () => {
      writeLarkTaskWorkflowFile(workflowFilePath());
      putEnv(
        "lark_task_client_module",
        stubClient({
          updateTaskState: () => Promise.resolve(err("boom")),
          createTaskComment: () => Promise.resolve(err("kaput")),
        }),
      );

      expect(await Tracker.updateIssueState("guid-1", "Done")).toEqual(
        err({
          tag: "tracker_error",
          code: "unknown",
          message: "Tracker operation failed: :boom",
          detail: "boom",
        }),
      );
      expect(await Tracker.createComment("guid-1", "hello")).toEqual(
        err({
          tag: "tracker_error",
          code: "unknown",
          message: "Tracker operation failed: :kaput",
          detail: "kaput",
        }),
      );
    });
  });

  describe("agentTools", () => {
    test("advertises the shared lark_api input contract", () => {
      const specs = LarkTaskPlugin.agentTools?.listAgentTools() ?? [];
      expect(specs).toHaveLength(1);
      const spec = specs[0];
      expect(spec?.name).toBe("lark_api");
      const schema = spec?.inputSchema as Record<string, unknown>;
      expect(schema.type).toBe("object");
      expect(schema.required).toEqual(["method", "path"]);
    });

    test("lark_api executes against the injected client with lark_task errors", async () => {
      const calls: { method: string; path: string; body: unknown }[] = [];
      const outcome = await LarkTaskPlugin.agentTools?.executeAgentTool(
        "lark_api",
        { method: "post", path: "/open-apis/task/v2/comments", body: { content: "hi" } },
        {
          larkClient: (method: string, path: string, body: unknown) => {
            calls.push({ method, path, body });
            return ok({ code: 0, msg: "success", data: { comment: { id: "1" } } });
          },
        },
      );
      expect(calls).toEqual([
        { method: "POST", path: "/open-apis/task/v2/comments", body: { content: "hi" } },
      ]);
      expect(outcome?.success).toBe(true);

      const failure = await LarkTaskPlugin.agentTools?.executeAgentTool(
        "lark_api",
        { method: "GET", path: "/open-apis/task/v2/tasks/guid-1" },
        {
          larkClient: () =>
            err({
              tag: "lark_task_api_error",
              code: "provider_error",
              message: "Lark API returned error code 190004: no permission",
              detail: { code: 190004, msg: "no permission" },
            }),
        },
      );
      expect(failure?.success).toBe(false);
      expect(failure?.payload).toEqual({
        error: {
          message: "Lark API returned error code 190004: no permission",
          code: 190004,
          msg: "no permission",
        },
      });
    });

    test("unknown tool names fail without dispatching", async () => {
      const outcome = await LarkTaskPlugin.agentTools?.executeAgentTool("linear_graphql", {
        query: "query { viewer { id } }",
      });
      expect(outcome?.success).toBe(false);
      expect(outcome?.payload).toEqual({
        error: { message: 'Unsupported dynamic tool: "linear_graphql".' },
      });
    });
  });

  describe("ui", () => {
    test("projectUrl renders the tasklist applink on the tenant domain", () => {
      writeLarkTaskWorkflowFile(workflowFilePath());
      expect(LarkTaskPlugin.ui?.projectUrl?.(settingsBang())).toBe(
        "https://applink.feishu.cn/client/todo/task_list?guid=tlg-TEST",
      );

      writeLarkTaskWorkflowFile(workflowFilePath(), { endpoint: "https://open.larksuite.com" });
      expect(LarkTaskPlugin.ui?.projectUrl?.(settingsBang())).toBe(
        "https://applink.larksuite.com/client/todo/task_list?guid=tlg-TEST",
      );

      writeLarkTaskWorkflowFile(workflowFilePath(), { tasklist_guid: undefined });
      expect(LarkTaskPlugin.ui?.projectUrl?.(settingsBang())).toBeNull();
    });

    test("uses the 'Lark task' noun and no plugin prompt template", () => {
      expect(LarkTaskPlugin.ui?.workItemNoun).toBe("Lark task");
      expect(LarkTaskPlugin.ui?.defaultPromptTemplate).toBeUndefined();
    });
  });
});
