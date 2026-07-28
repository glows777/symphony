// Guards the repository's own `WORKFLOW.md` (Linear + codex) against drift: it
// must stay parseable by the config schema, pass the Linear plugin's semantic
// validation, and render through the Liquid prompt builder — which runs with
// strictVariables/strictFilters, so a typo'd `issue.*` path is a throw, not a
// blank. Also covers `examples/local.workflow.md`, the credential-free memory
// tracker config the local acceptance run uses.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import path from "node:path";
import { deleteEnv } from "../../src/symphony/app-env.ts";
import { settings, validate } from "../../src/symphony/config.ts";
import { buildPrompt } from "../../src/symphony/prompt-builder.ts";
import { newIssue } from "../../src/symphony/work-item.ts";
import { setWorkflowFilePath } from "../../src/symphony/workflow.ts";

const REPO = path.join(import.meta.dir, "..", "..");
const WORKFLOW = path.join(REPO, "WORKFLOW.md");
const LOCAL_WORKFLOW = path.join(REPO, "examples", "local.workflow.md");

function sampleIssue(overrides: Record<string, unknown> = {}) {
  return newIssue({
    id: "issue-uuid",
    identifier: "ENG-123",
    title: "Port the retry backoff to the new scheduler",
    description: "The old backoff is duplicated across two call sites.",
    priority: 2,
    state: "Todo",
    url: "https://linear.app/acme/issue/ENG-123",
    labels: ["symphony", "backend"],
    ...overrides,
  });
}

describe("WORKFLOW.md (Linear + codex)", () => {
  let savedApiKey: string | undefined;

  beforeEach(() => {
    savedApiKey = process.env.LINEAR_API_KEY;
    process.env.LINEAR_API_KEY = "lin_api_example";
    setWorkflowFilePath(WORKFLOW);
  });

  afterEach(() => {
    deleteEnv("workflow_file_path");
    if (savedApiKey === undefined) {
      Reflect.deleteProperty(process.env, "LINEAR_API_KEY");
    } else {
      process.env.LINEAR_API_KEY = savedApiKey;
    }
  });

  test("parses into settings with the documented values", () => {
    const parsed = settings();
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) {
      return;
    }

    const config = parsed.value;
    expect(config.tracker.kind).toBe("linear");
    expect(config.tracker.requiredLabels).toEqual(["symphony"]);
    expect(config.tracker.activeStates).toEqual(["Todo", "In Progress"]);
    // "In Review" is deliberately in neither list: parked, not terminal.
    expect(config.tracker.terminalStates).not.toContain("In Review");
    expect(config.agent.backend).toBe("codex");
    expect(config.agent.maxConcurrentAgentsByState).toEqual({ todo: 2, "in progress": 3 });
    expect(config.hooks.afterCreate).toContain("git clone");
    expect(config.hooks.beforeRun).not.toBeNull();
    expect(config.hooks.beforeRemove).toContain("gh pr");
  });

  test("resolves the api key from the environment rather than the file", () => {
    const parsed = settings();
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) {
      return;
    }
    expect(parsed.value.tracker.plugin.api_key).toBe("lin_api_example");
  });

  test("passes tracker and backend semantic validation", () => {
    expect(validate()).toEqual({ ok: true, value: undefined });
  });

  test("enables network access in the turn sandbox policy", () => {
    const parsed = settings();
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) {
      return;
    }
    // The built-in default is networkAccess:false, which cannot push a branch;
    // this file overrides it on purpose. Keys are Codex's camelCase.
    expect(parsed.value.codex.turnSandboxPolicy).toMatchObject({
      type: "workspaceWrite",
      networkAccess: true,
    });
  });

  test("the sandbox's writable root matches workspace.root verbatim", () => {
    const parsed = settings();
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) {
      return;
    }
    // These two are written independently — workspace.root expands "$VAR",
    // the sandbox policy map does not — and a mismatch surfaces only as a
    // permission error from inside Codex's sandbox. Pin them together.
    const writableRoots = parsed.value.codex.turnSandboxPolicy?.writableRoots;
    expect(writableRoots).toEqual([parsed.value.workspace.root]);
  });

  test("carries no baked-in credential", () => {
    // The file is committed, so the api key must come from the environment and
    // nowhere else: with the variable unset there is no key left to find, and
    // validation fails on exactly that.
    Reflect.deleteProperty(process.env, "LINEAR_API_KEY");

    const parsed = settings();
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) {
      return;
    }
    expect(parsed.value.tracker.plugin.api_key).toBeNull();
    expect(validate()).toMatchObject({
      ok: false,
      error: { tag: "missing_linear_api_token" },
    });
  });

  test("renders the prompt for a fully populated issue", () => {
    const prompt = buildPrompt(sampleIssue({ branchName: "eng-123-retry-backoff" }), {
      attempt: null,
    });

    expect(prompt).toContain("编号:ENG-123");
    expect(prompt).toContain("Port the retry backoff to the new scheduler");
    expect(prompt).toContain("标签:symphony, backend");
    expect(prompt).toContain("Linear 建议的分支名:eng-123-retry-backoff");
    expect(prompt).toContain("The old backoff is duplicated across two call sites.");
    expect(prompt).toContain('"id": "issue-uuid"');
    // The control-loop section is the part the agent must not miss.
    expect(prompt).toContain("In Review");
    expect(prompt).not.toContain("重试上下文");
  });

  test("renders the missing-description and blocker branches", () => {
    const prompt = buildPrompt(
      sampleIssue({
        description: null,
        branchName: null,
        blockedBy: [{ id: "blocker-uuid", identifier: "ENG-100", state: "Done" }],
      }),
      { attempt: null },
    );

    expect(prompt).toContain("**这张卡没有写描述。**");
    expect(prompt).toContain("ENG-100(状态:Done)");
    expect(prompt).not.toContain("Linear 建议的分支名");
  });

  test("renders retry guidance when the attempt counter is set", () => {
    const prompt = buildPrompt(sampleIssue(), { attempt: 3 });
    expect(prompt).toContain("重试上下文");
    expect(prompt).toContain("这是第 3 次尝试");
  });
});

describe("examples/local.workflow.md (memory tracker + codex)", () => {
  beforeEach(() => {
    setWorkflowFilePath(LOCAL_WORKFLOW);
  });

  afterEach(() => {
    deleteEnv("workflow_file_path");
  });

  test("still parses and validates credential-free", () => {
    const parsed = settings();
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) {
      return;
    }
    expect(parsed.value.tracker.kind).toBe("memory");
    expect(parsed.value.agent.backend).toBe("codex");
    expect(validate()).toEqual({ ok: true, value: undefined });
  });

  test("renders its prompt", () => {
    const prompt = buildPrompt(newIssue({ identifier: "LOCAL-1", title: "Smoke" }), {
      attempt: null,
    });
    expect(prompt).toContain("LOCAL-1");
  });
});
