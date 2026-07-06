import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { settingsBang, validate } from "../../../../src/symphony/config.ts";
import { LarkPlugin } from "../../../../src/symphony/plugins/lark/plugin.ts";
import { larkSettings } from "../../../../src/symphony/plugins/lark/settings.ts";
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
  });
});
