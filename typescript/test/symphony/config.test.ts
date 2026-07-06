import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  codexTurnSandboxPolicy,
  maxConcurrentAgentsForState,
  settingsBang,
  validate,
} from "../../src/symphony/config.ts";
import { canonicalize } from "../../src/symphony/path-safety.ts";
import { linearSettings } from "../../src/symphony/plugins/linear/settings.ts";
import { workflowFilePath } from "../../src/symphony/workflow.ts";
import { setupWorkflow, teardownWorkflow, writeWorkflowFile } from "../support/test-support.ts";

const DEFAULT_WORKSPACE_ROOT = path.join(os.tmpdir(), "symphony_workspaces");

function expandedCanonical(p: string): string {
  const result = canonicalize(path.resolve(p));
  if (!result.ok) {
    throw new Error("canonicalize failed");
  }
  return result.value;
}

describe("Config", () => {
  let root: string;
  let savedLinear: string | undefined;

  beforeEach(() => {
    savedLinear = process.env.LINEAR_API_KEY;
    ({ root } = setupWorkflow());
  });

  afterEach(() => {
    if (savedLinear === undefined) {
      Reflect.deleteProperty(process.env, "LINEAR_API_KEY");
    } else {
      process.env.LINEAR_API_KEY = savedLinear;
    }
    teardownWorkflow(root);
  });

  test("reads defaults for optional settings", () => {
    Reflect.deleteProperty(process.env, "LINEAR_API_KEY");
    writeWorkflowFile(workflowFilePath(), {
      workspace_root: null,
      max_concurrent_agents: null,
      codex_approval_policy: null,
      codex_thread_sandbox: null,
      codex_turn_sandbox_policy: null,
      codex_turn_timeout_ms: null,
      codex_read_timeout_ms: null,
      codex_stall_timeout_ms: null,
      tracker_api_token: null,
      tracker_project_slug: null,
    });

    const config = settingsBang();
    expect(linearSettings(config).endpoint).toBe("https://api.linear.app/graphql");
    expect(linearSettings(config).apiKey).toBeNull();
    expect(linearSettings(config).projectSlug).toBeNull();
    expect(config.tracker.requiredLabels).toEqual([]);
    expect(config.workspace.root).toBe(DEFAULT_WORKSPACE_ROOT);
    expect(config.worker.maxConcurrentAgentsPerHost).toBeNull();
    expect(config.agent.maxConcurrentAgents).toBe(10);
    expect(config.codex.command).toBe("codex app-server");
    expect(config.codex.approvalPolicy).toEqual({
      reject: { sandbox_approval: true, rules: true, mcp_elicitations: true },
    });
    expect(config.codex.threadSandbox).toBe("workspace-write");

    expect(codexTurnSandboxPolicy()).toEqual({
      type: "workspaceWrite",
      writableRoots: [expandedCanonical(DEFAULT_WORKSPACE_ROOT)],
      readOnlyAccess: { type: "fullAccess" },
      networkAccess: false,
      excludeTmpdirEnvVar: false,
      excludeSlashTmp: false,
    });

    expect(config.codex.turnTimeoutMs).toBe(3_600_000);
    expect(config.codex.readTimeoutMs).toBe(5_000);
    expect(config.codex.stallTimeoutMs).toBe(300_000);
  });

  test("normalizes required labels (trim/downcase/uniq)", () => {
    writeWorkflowFile(workflowFilePath(), {
      tracker_required_labels: [" Symphony ", "SYMPHONY", "JavaScript"],
    });
    expect(settingsBang().tracker.requiredLabels).toEqual(["symphony", "javascript"]);

    writeWorkflowFile(workflowFilePath(), { tracker_required_labels: [" "] });
    expect(settingsBang().tracker.requiredLabels).toEqual([""]);
  });

  test("keeps codex command verbatim with embedded quotes", () => {
    writeWorkflowFile(workflowFilePath(), {
      codex_command: `codex --config 'model="gpt-5.5"' app-server`,
    });
    expect(settingsBang().codex.command).toBe(`codex --config 'model="gpt-5.5"' app-server`);
  });

  test("validate! reports invalid fields with their path", () => {
    const cases: [Record<string, unknown>, string][] = [
      [{ tracker_active_states: "," }, "tracker.active_states"],
      [{ max_concurrent_agents: "bad" }, "agent.max_concurrent_agents"],
      [{ worker_max_concurrent_agents_per_host: 0 }, "worker.max_concurrent_agents_per_host"],
      [{ codex_turn_timeout_ms: "bad" }, "codex.turn_timeout_ms"],
      [{ codex_read_timeout_ms: "bad" }, "codex.read_timeout_ms"],
      [{ codex_stall_timeout_ms: "bad" }, "codex.stall_timeout_ms"],
      [{ codex_turn_sandbox_policy: "bad" }, "codex.turn_sandbox_policy"],
    ];

    for (const [overrides, fragment] of cases) {
      writeWorkflowFile(workflowFilePath(), overrides);
      const result = validate();
      expect(result.ok).toBe(false);
      if (!result.ok) {
        const error = result.error as { tag: string; message: string };
        expect(error.tag).toBe("invalid_workflow_config");
        expect(error.message).toContain(fragment);
      }
    }
  });

  test("validates the tracker kind through the plugin registry", () => {
    writeWorkflowFile(workflowFilePath(), { tracker_kind: "memory", tracker_api_token: null });
    expect(validate().ok).toBe(true);

    writeWorkflowFile(workflowFilePath(), { tracker_kind: "jira" });
    const unsupported = validate();
    expect(unsupported.ok).toBe(false);
    if (!unsupported.ok) {
      const error = unsupported.error as { tag: string; message: string };
      expect(error.tag).toBe("unsupported_tracker_kind");
      expect(error.message).toContain('"jira"');
    }

    Reflect.deleteProperty(process.env, "LINEAR_API_KEY");
    writeWorkflowFile(workflowFilePath(), { tracker_kind: "linear", tracker_api_token: null });
    const missingToken = validate();
    expect(missingToken.ok).toBe(false);
    if (!missingToken.ok) {
      expect((missingToken.error as { tag: string }).tag).toBe("missing_linear_api_token");
    }
  });

  test("empty codex strings are accepted; future policies pass through", () => {
    writeWorkflowFile(workflowFilePath(), { codex_approval_policy: "" });
    expect(validate().ok).toBe(true);
    expect(settingsBang().codex.approvalPolicy).toBe("");

    writeWorkflowFile(workflowFilePath(), { codex_thread_sandbox: "" });
    expect(validate().ok).toBe(true);
    expect(settingsBang().codex.threadSandbox).toBe("");

    writeWorkflowFile(workflowFilePath(), {
      codex_approval_policy: "future-policy",
      codex_thread_sandbox: "future-sandbox",
      codex_turn_sandbox_policy: { type: "futureSandbox", nested: { flag: true } },
    });
    const config = settingsBang();
    expect(config.codex.approvalPolicy).toBe("future-policy");
    expect(config.codex.threadSandbox).toBe("future-sandbox");
    expect(validate().ok).toBe(true);
    expect(codexTurnSandboxPolicy()).toEqual({ type: "futureSandbox", nested: { flag: true } });
  });

  test("resolves $VAR references for env-backed secret and path values", () => {
    const unique = `${process.pid}_${Math.floor(Math.random() * 1e9)}`;
    const workspaceEnv = `SYMP_WORKSPACE_ROOT_${unique}`;
    const apiKeyEnv = `SYMP_LINEAR_API_KEY_${unique}`;
    const workspaceRoot = path.join("/tmp", "symphony-workspace-root");
    process.env[workspaceEnv] = workspaceRoot;
    process.env[apiKeyEnv] = "resolved-secret";

    try {
      writeWorkflowFile(workflowFilePath(), {
        tracker_api_token: `$${apiKeyEnv}`,
        workspace_root: `$${workspaceEnv}`,
        codex_command: "~/bin/codex app-server",
      });
      const config = settingsBang();
      expect(linearSettings(config).apiKey).toBe("resolved-secret");
      expect(config.workspace.root).toBe(path.resolve(workspaceRoot));
      expect(config.codex.command).toBe("~/bin/codex app-server");
    } finally {
      Reflect.deleteProperty(process.env, workspaceEnv);
      Reflect.deleteProperty(process.env, apiKeyEnv);
    }
  });

  test("no longer resolves legacy env: references", () => {
    writeWorkflowFile(workflowFilePath(), {
      tracker_api_token: "env:SOME_KEY",
      workspace_root: "env:SOME_ROOT",
    });
    const config = settingsBang();
    expect(linearSettings(config).apiKey).toBe("env:SOME_KEY");
    expect(config.workspace.root).toBe("env:SOME_ROOT");
  });

  test("supports per-state max concurrent agent overrides", () => {
    fs.writeFileSync(
      workflowFilePath(),
      [
        "---",
        "agent:",
        "  max_concurrent_agents: 10",
        "  max_concurrent_agents_by_state:",
        "    todo: 1",
        '    "In Progress": 4',
        '    "In Review": 2',
        "---",
        "",
      ].join("\n"),
    );

    expect(settingsBang().agent.maxConcurrentAgents).toBe(10);
    expect(maxConcurrentAgentsForState("Todo")).toBe(1);
    expect(maxConcurrentAgentsForState("In Progress")).toBe(4);
    expect(maxConcurrentAgentsForState("In Review")).toBe(2);
    expect(maxConcurrentAgentsForState("Closed")).toBe(10);
    expect(maxConcurrentAgentsForState(42)).toBe(10);

    writeWorkflowFile(workflowFilePath(), { worker_max_concurrent_agents_per_host: 2 });
    expect(validate().ok).toBe(true);
    expect(settingsBang().worker.maxConcurrentAgentsPerHost).toBe(2);
  });
});
