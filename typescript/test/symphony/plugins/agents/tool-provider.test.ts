import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { trackerToolProvider } from "../../../../src/symphony/plugins/agents/tool-provider.ts";
import { ok } from "../../../../src/symphony/result.ts";
import { workflowFilePath } from "../../../../src/symphony/workflow.ts";
import {
  setupWorkflow,
  teardownWorkflow,
  writeWorkflowFile,
} from "../../../support/test-support.ts";

// The provider re-resolves the active tracker plugin from WORKFLOW.md on every
// call, so each test drives it against the relevant workflow fixture.
describe("Plugins.Agents.ToolProvider", () => {
  let root: string;

  beforeEach(() => {
    ({ root } = setupWorkflow());
  });

  afterEach(() => {
    teardownWorkflow(root);
  });

  test("lists the active plugin's tool specs", () => {
    const specs = trackerToolProvider().listSpecs();
    expect(specs.map((spec) => spec.name)).toEqual(["linear_graphql"]);
  });

  test("advertises no specs when the active plugin has no agent tools", () => {
    writeWorkflowFile(workflowFilePath(), { tracker_kind: "memory" });
    expect(trackerToolProvider().listSpecs()).toEqual([]);
  });

  test("dispatches supported tools through the active plugin", async () => {
    const outcome = await trackerToolProvider({
      linearClient: () => ok({ data: { viewer: { id: "usr_1" } } }),
    }).execute("linear_graphql", { query: "query Viewer { viewer { id } }" });

    expect(outcome.success).toBe(true);
    expect(outcome.payload).toEqual({ data: { viewer: { id: "usr_1" } } });
  });

  test("passes Linear mutations through the ordinary tracker tool", async () => {
    let called = false;
    const outcome = await trackerToolProvider({
      linearClient: (query: string) => {
        called = true;
        expect(query).toContain("issueUpdate");
        return ok({ data: { issueUpdate: { success: true } } });
      },
    }).execute("linear_graphql", {
      query:
        'mutation MoveIssue { issueUpdate(id: "issue-1", input: {stateId: "rework"}) { success } }',
    });

    expect(outcome.success).toBe(true);
    expect(called).toBe(true);
    expect(outcome.payload).toEqual({ data: { issueUpdate: { success: true } } });
  });

  test("passes Linear comment mutations through the ordinary tracker tool", async () => {
    let called = false;
    const outcome = await trackerToolProvider({
      linearClient: (query: string) => {
        called = true;
        expect(query).toContain("commentCreate");
        return ok({ data: { commentCreate: { success: true } } });
      },
    }).execute("linear_graphql", {
      query:
        'mutation Comment { commentCreate(input: {issueId: "issue-1", body: "needs rework"}) { success } }',
    });

    expect(outcome.success).toBe(true);
    expect(called).toBe(true);
    expect(outcome.payload).toEqual({ data: { commentCreate: { success: true } } });
  });

  test("does not mistake query strings or comments for unsupported operations", async () => {
    let called = false;
    const outcome = await trackerToolProvider({
      linearClient: () => {
        called = true;
        return ok({ data: { issue: { id: "issue-1" } } });
      },
    }).execute("linear_graphql", {
      query: 'query ReadIssue { issue(id: "mutation") { id } } # mutation is data',
    });

    expect(outcome.success).toBe(true);
    expect(called).toBe(true);
  });

  test("returns an unsupported-tool payload carrying the supported tool list", async () => {
    const outcome = await trackerToolProvider().execute("not_a_real_tool", {});
    expect(outcome.success).toBe(false);
    expect(outcome.payload).toEqual({
      error: {
        message: 'Unsupported dynamic tool: "not_a_real_tool".',
        supportedTools: ["linear_graphql"],
      },
    });
  });

  test("reports an empty supported list when the active plugin has no agent tools", async () => {
    writeWorkflowFile(workflowFilePath(), { tracker_kind: "memory" });
    const outcome = await trackerToolProvider().execute("linear_graphql", {});
    expect(outcome.success).toBe(false);
    expect(outcome.payload).toEqual({
      error: {
        message: 'Unsupported dynamic tool: "linear_graphql".',
        supportedTools: [],
      },
    });
  });

  test("treats a null tool name as unsupported", async () => {
    const outcome = await trackerToolProvider().execute(null, {});
    expect(outcome.success).toBe(false);
    expect(outcome.payload).toEqual({
      error: {
        message: "Unsupported dynamic tool: null.",
        supportedTools: ["linear_graphql"],
      },
    });
  });
});
