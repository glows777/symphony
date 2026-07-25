import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { settingsBang, validate } from "../../../../src/symphony/config.ts";
import { claudeCodeSettings } from "../../../../src/symphony/plugins/agents/claude-code/settings.ts";
import { workflowFilePath } from "../../../../src/symphony/workflow.ts";
import {
  setupWorkflow,
  teardownWorkflow,
  writeWorkflowFile,
} from "../../../support/test-support.ts";

// Exercises the claude_code backend's configSchema (cast/finalize/validate)
// through the real config parse: defaults, explicit values, unknown
// permission_mode rejection, $VAR resolution, and non-positive timeout
// rejection (matching codex's timeout validation).

const ENV_MODEL = "SYMPHONY_TEST_CLAUDE_CODE_MODEL";

describe("Config.claude_code backend", () => {
  let workflowRoot: string;

  beforeEach(() => {
    ({ root: workflowRoot } = setupWorkflow());
  });

  afterEach(() => {
    teardownWorkflow(workflowRoot);
    delete process.env[ENV_MODEL];
  });

  test("applies defaults when the claude_code section is absent", () => {
    writeWorkflowFile(workflowFilePath(), { agent_backend: "claude_code" });
    expect(validate().ok).toBe(true);

    const cc = claudeCodeSettings(settingsBang());
    expect(cc.command).toBe("claude");
    expect(cc.permissionMode).toBe("bypass");
    expect(cc.model).toBeNull();
    expect(cc.allowedTools).toBeNull();
    expect(cc.disallowedTools).toBeNull();
    expect(cc.turnTimeoutMs).toBe(3_600_000);
    expect(cc.readTimeoutMs).toBe(5_000);
  });

  test("casts explicit values", () => {
    writeWorkflowFile(workflowFilePath(), {
      agent_backend: "claude_code",
      claude_code: {
        command: "claude-next",
        permission_mode: "default",
        model: "opus",
        allowed_tools: ["Bash", "Edit"],
        disallowed_tools: ["WebFetch"],
        turn_timeout_ms: 1_000,
        read_timeout_ms: 500,
      },
    });
    expect(validate().ok).toBe(true);

    const cc = claudeCodeSettings(settingsBang());
    expect(cc.command).toBe("claude-next");
    expect(cc.permissionMode).toBe("default");
    expect(cc.model).toBe("opus");
    expect(cc.allowedTools).toEqual(["Bash", "Edit"]);
    expect(cc.disallowedTools).toEqual(["WebFetch"]);
    expect(cc.turnTimeoutMs).toBe(1_000);
    expect(cc.readTimeoutMs).toBe(500);
  });

  test("rejects an unknown permission_mode", () => {
    writeWorkflowFile(workflowFilePath(), {
      agent_backend: "claude_code",
      claude_code: { permission_mode: "yolo" },
    });
    const result = validate();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect((result.error as { tag: string }).tag).toBe("invalid_claude_code_permission_mode");
    }
  });

  test("resolves $VAR references in the model field", () => {
    process.env[ENV_MODEL] = "claude-sonnet-latest";
    writeWorkflowFile(workflowFilePath(), {
      agent_backend: "claude_code",
      claude_code: { model: `$${ENV_MODEL}` },
    });
    expect(validate().ok).toBe(true);
    expect(claudeCodeSettings(settingsBang()).model).toBe("claude-sonnet-latest");
  });

  test("rejects a non-positive turn_timeout_ms or read_timeout_ms", () => {
    writeWorkflowFile(workflowFilePath(), {
      agent_backend: "claude_code",
      claude_code: { turn_timeout_ms: 0 },
    });
    const zero = validate();
    expect(zero.ok).toBe(false);
    if (!zero.ok) {
      expect((zero.error as { tag: string; message: string }).message).toContain("turn_timeout_ms");
    }

    writeWorkflowFile(workflowFilePath(), {
      agent_backend: "claude_code",
      claude_code: { read_timeout_ms: -1 },
    });
    const negative = validate();
    expect(negative.ok).toBe(false);
    if (!negative.ok) {
      expect((negative.error as { tag: string; message: string }).message).toContain(
        "read_timeout_ms",
      );
    }
  });
});
