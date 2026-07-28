// Guards `examples/linear.workflow.md` against drift: the shipped example must
// stay parseable by the config schema, pass the Linear plugin's semantic
// validation, and render through the Liquid prompt builder (which runs with
// strictVariables/strictFilters, so a typo in an `issue.*` path is a throw).

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import path from "node:path";
import { deleteEnv } from "../../src/symphony/app-env.ts";
import { settings, validate } from "../../src/symphony/config.ts";
import { newIssue } from "../../src/symphony/plugins/work-item.ts";
import { buildPrompt } from "../../src/symphony/prompt-builder.ts";
import { setWorkflowFilePath } from "../../src/symphony/workflow.ts";

const EXAMPLE = path.join(import.meta.dir, "..", "..", "examples", "linear.workflow.md");

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

describe("examples/linear.workflow.md", () => {
  let previousApiKey: string | undefined;

  beforeEach(() => {
    previousApiKey = process.env.LINEAR_API_KEY;
    process.env.LINEAR_API_KEY = "lin_api_example";
    setWorkflowFilePath(EXAMPLE);
  });

  afterEach(() => {
    deleteEnv("workflow_file_path");
    if (previousApiKey === undefined) {
      Reflect.deleteProperty(process.env, "LINEAR_API_KEY");
    } else {
      process.env.LINEAR_API_KEY = previousApiKey;
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
    // the example overrides it on purpose. Keys are Codex's camelCase.
    expect(parsed.value.codex.turnSandboxPolicy).toMatchObject({
      type: "workspaceWrite",
      networkAccess: true,
    });
  });

  test("renders the prompt for a fully populated issue", () => {
    const prompt = buildPrompt(sampleIssue({ branchName: "eng-123-retry-backoff" }), {
      attempt: null,
    });

    expect(prompt).toContain("Identifier: ENG-123");
    expect(prompt).toContain("Port the retry backoff to the new scheduler");
    expect(prompt).toContain("Labels: symphony, backend");
    expect(prompt).toContain("Branch suggested by Linear: eng-123-retry-backoff");
    expect(prompt).toContain("The old backoff is duplicated across two call sites.");
    expect(prompt).toContain('"id": "issue-uuid"');
    // The control-loop section is the part the agent must not miss.
    expect(prompt).toContain("In Review");
    expect(prompt).not.toContain("Retry context");
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

    expect(prompt).toContain("**No description was provided.**");
    expect(prompt).toContain("ENG-100 (state: Done)");
    expect(prompt).not.toContain("Branch suggested by Linear");
  });

  test("renders retry guidance when the attempt counter is set", () => {
    const prompt = buildPrompt(sampleIssue(), { attempt: 3 });
    expect(prompt).toContain("Retry context");
    expect(prompt).toContain("This is attempt #3");
  });
});
