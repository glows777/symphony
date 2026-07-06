import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  type LinearClientFn,
  execute,
  toolSpecs,
} from "../../../src/symphony/codex/dynamic-tool.ts";
import { err, ok } from "../../../src/symphony/result.ts";
import { workflowFilePath } from "../../../src/symphony/workflow.ts";
import { setupWorkflow, teardownWorkflow, writeWorkflowFile } from "../../support/test-support.ts";
import { writeLarkWorkflowFile } from "../plugins/lark/lark-test-support.ts";

type Call = { query: string; variables: Record<string, unknown>; opts: unknown[] };

function recordingClient(result: ReturnType<LinearClientFn>, calls: Call[]): LinearClientFn {
  return (query, variables, opts) => {
    calls.push({ query, variables, opts });
    return result;
  };
}

// Translated from dynamic_tool_test.exs. The dispatcher resolves the active
// plugin's agent tools from WORKFLOW.md, so each test runs against the default
// linear-kind workflow fixture.
describe("Codex.DynamicTool", () => {
  let root: string;

  beforeEach(() => {
    ({ root } = setupWorkflow());
  });

  afterEach(() => {
    teardownWorkflow(root);
  });

  test("advertises no tools when the active plugin has none", async () => {
    writeWorkflowFile(workflowFilePath(), { tracker_kind: "memory" });
    expect(toolSpecs()).toEqual([]);

    const response = await execute("linear_graphql", { query: "query { viewer { id } }" });
    expect(response.success).toBe(false);
    expect(JSON.parse(response.output)).toEqual({
      error: {
        message: 'Unsupported dynamic tool: "linear_graphql".',
        supportedTools: [],
      },
    });
  });
  test("advertises lark_api for lark-kind workflows without dispatcher changes", async () => {
    writeLarkWorkflowFile(workflowFilePath());
    const specs = toolSpecs();
    expect(specs.map((spec) => spec.name)).toEqual(["lark_api"]);

    const response = await execute("linear_graphql", { query: "query { viewer { id } }" });
    expect(response.success).toBe(false);
    expect(JSON.parse(response.output)).toEqual({
      error: {
        message: 'Unsupported dynamic tool: "linear_graphql".',
        supportedTools: ["lark_api"],
      },
    });
  });

  test("tool_specs advertises the linear_graphql input contract", () => {
    const specs = toolSpecs();
    expect(specs).toHaveLength(1);
    const spec = specs[0] as Record<string, unknown>;
    expect(spec.name).toBe("linear_graphql");
    const schema = spec.inputSchema as Record<string, unknown>;
    expect(schema.type).toBe("object");
    expect(schema.required).toEqual(["query"]);
    expect(Object.keys(schema.properties as object)).toEqual(["query", "variables"]);
    expect(spec.description as string).toContain("Linear");
  });

  test("unsupported tools return a failure payload with the supported tool list", async () => {
    const response = await execute("not_a_real_tool", {});
    expect(response.success).toBe(false);
    expect(JSON.parse(response.output)).toEqual({
      error: {
        message: 'Unsupported dynamic tool: "not_a_real_tool".',
        supportedTools: ["linear_graphql"],
      },
    });
    expect(response.contentItems).toEqual([{ type: "inputText", text: response.output }]);
  });

  test("linear_graphql returns successful GraphQL responses as tool text", async () => {
    const calls: Call[] = [];
    const response = await execute(
      "linear_graphql",
      { query: "query Viewer { viewer { id } }", variables: { includeTeams: false } },
      { linearClient: recordingClient(ok({ data: { viewer: { id: "usr_123" } } }), calls) },
    );

    expect(calls).toEqual([
      { query: "query Viewer { viewer { id } }", variables: { includeTeams: false }, opts: [] },
    ]);
    expect(response.success).toBe(true);
    expect(JSON.parse(response.output)).toEqual({ data: { viewer: { id: "usr_123" } } });
    expect(response.contentItems).toEqual([{ type: "inputText", text: response.output }]);
  });

  test("linear_graphql accepts a raw GraphQL query string", async () => {
    const calls: Call[] = [];
    const response = await execute("linear_graphql", "  query Viewer { viewer { id } }  ", {
      linearClient: recordingClient(ok({ data: { viewer: { id: "usr_456" } } }), calls),
    });

    expect(calls[0]).toEqual({ query: "query Viewer { viewer { id } }", variables: {}, opts: [] });
    expect(response.success).toBe(true);
  });

  test("linear_graphql ignores legacy operationName arguments", async () => {
    const calls: Call[] = [];
    const response = await execute(
      "linear_graphql",
      { query: "query Viewer { viewer { id } }", operationName: "Viewer" },
      { linearClient: recordingClient(ok({ data: { viewer: { id: "usr_789" } } }), calls) },
    );

    expect(calls[0]).toEqual({ query: "query Viewer { viewer { id } }", variables: {}, opts: [] });
    expect(response.success).toBe(true);
  });

  test("linear_graphql passes multi-operation documents through unchanged", async () => {
    const calls: Call[] = [];
    const query = "query Viewer { viewer { id } }\nquery Teams { teams { nodes { id } } }\n";
    const response = await execute(
      "linear_graphql",
      { query },
      {
        linearClient: recordingClient(
          ok({
            errors: [
              { message: "Must provide operation name if query contains multiple operations." },
            ],
          }),
          calls,
        ),
      },
    );

    expect(calls[0]?.query).toBe(query.trim());
    expect(response.success).toBe(false);
  });

  test("linear_graphql rejects blank raw query strings even with the default client", async () => {
    const response = await execute("linear_graphql", "   ");
    expect(response.success).toBe(false);
    expect(JSON.parse(response.output)).toEqual({
      error: { message: "`linear_graphql` requires a non-empty `query` string." },
    });
  });

  test("linear_graphql marks GraphQL error responses as failures while preserving the body", async () => {
    const response = await execute(
      "linear_graphql",
      { query: "mutation BadMutation { nope }" },
      { linearClient: () => ok({ errors: [{ message: "Unknown field `nope`" }], data: null }) },
    );
    expect(response.success).toBe(false);
    expect(JSON.parse(response.output)).toEqual({
      data: null,
      errors: [{ message: "Unknown field `nope`" }],
    });
  });

  test("linear_graphql validates required arguments before calling Linear", async () => {
    const guard: LinearClientFn = () => {
      throw new Error("linear client should not be called");
    };

    const missing = await execute(
      "linear_graphql",
      { variables: { commentId: "comment-1" } },
      { linearClient: guard },
    );
    expect(missing.success).toBe(false);
    expect(JSON.parse(missing.output)).toEqual({
      error: { message: "`linear_graphql` requires a non-empty `query` string." },
    });

    const blank = await execute("linear_graphql", { query: "   " }, { linearClient: guard });
    expect(blank.success).toBe(false);
  });

  test("linear_graphql rejects invalid argument types", async () => {
    const response = await execute("linear_graphql", ["not", "valid"], {
      linearClient: () => {
        throw new Error("should not be called");
      },
    });
    expect(response.success).toBe(false);
    expect(JSON.parse(response.output)).toEqual({
      error: {
        message:
          "`linear_graphql` expects either a GraphQL query string or an object with `query` and optional `variables`.",
      },
    });
  });

  test("linear_graphql rejects invalid variables", async () => {
    const response = await execute(
      "linear_graphql",
      { query: "query Viewer { viewer { id } }", variables: ["bad"] },
      {
        linearClient: () => {
          throw new Error("should not be called");
        },
      },
    );
    expect(response.success).toBe(false);
    expect(JSON.parse(response.output)).toEqual({
      error: { message: "`linear_graphql.variables` must be a JSON object when provided." },
    });
  });

  test("linear_graphql formats transport and auth failures", async () => {
    const missingToken = await execute(
      "linear_graphql",
      { query: "query Viewer { viewer { id } }" },
      { linearClient: () => err({ tag: "missing_linear_api_token" }) },
    );
    expect(JSON.parse(missingToken.output)).toEqual({
      error: {
        message:
          "Symphony is missing Linear auth. Set `linear.api_key` in `WORKFLOW.md` or export `LINEAR_API_KEY`.",
      },
    });

    const statusError = await execute(
      "linear_graphql",
      { query: "query Viewer { viewer { id } }" },
      { linearClient: () => err({ tag: "linear_api_status", status: 503 }) },
    );
    expect(JSON.parse(statusError.output)).toEqual({
      error: { message: "Linear GraphQL request failed with HTTP 503.", status: 503 },
    });

    const requestError = await execute(
      "linear_graphql",
      { query: "query Viewer { viewer { id } }" },
      { linearClient: () => err({ tag: "linear_api_request", reason: "timeout" }) },
    );
    expect(JSON.parse(requestError.output)).toEqual({
      error: {
        message: "Linear GraphQL request failed before receiving a successful response.",
        reason: ":timeout",
      },
    });
  });

  test("linear_graphql formats unexpected failures from the client", async () => {
    const response = await execute(
      "linear_graphql",
      { query: "query Viewer { viewer { id } }" },
      { linearClient: () => err("boom") },
    );
    expect(response.success).toBe(false);
    expect(JSON.parse(response.output)).toEqual({
      error: { message: "Linear GraphQL tool execution failed.", reason: ":boom" },
    });
  });

  test("linear_graphql falls back to inspect for non-JSON payloads", async () => {
    const response = await execute(
      "linear_graphql",
      { query: "query Viewer { viewer { id } }" },
      { linearClient: () => ok("ok") },
    );
    expect(response.success).toBe(true);
    expect(response.output).toBe(":ok");
  });
});
