// Literal port of `symphony_elixir/codex/dynamic_tool.ex`.
//
// Executes client-side tool calls requested by Codex app-server turns. The only
// tool is `linear_graphql`. Elixir atoms that cross these boundaries are modeled
// as strings; `inspect` is reproduced contextually (tool names render quoted,
// reason atoms render `:name`). Jason.encode! -> JSON.stringify(_, null, 2).

import { graphql as clientGraphql } from "../linear/client.ts";
import { type Result, err, ok } from "../result.ts";

const LINEAR_GRAPHQL_TOOL = "linear_graphql";
const LINEAR_GRAPHQL_DESCRIPTION =
  "Execute a raw GraphQL query or mutation against Linear using Symphony's configured auth.\n";
const LINEAR_GRAPHQL_INPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["query"],
  properties: {
    query: {
      type: "string",
      description: "GraphQL query or mutation document to execute against Linear.",
    },
    variables: {
      type: ["object", "null"],
      description: "Optional GraphQL variables object.",
      additionalProperties: true,
    },
  },
};

export type DynamicToolResponse = {
  success: boolean;
  output: string;
  contentItems: { type: "inputText"; text: string }[];
};

export type LinearClientFn = (
  query: string,
  variables: Record<string, unknown>,
  opts: unknown[],
) => Result<unknown, unknown> | Promise<Result<unknown, unknown>>;

export type ExecuteOpts = { linearClient?: LinearClientFn };

export async function execute(
  tool: string | null,
  args: unknown,
  opts: ExecuteOpts = {},
): Promise<DynamicToolResponse> {
  if (tool === LINEAR_GRAPHQL_TOOL) {
    return executeLinearGraphql(args, opts);
  }
  return failureResponse({
    error: {
      message: `Unsupported dynamic tool: ${inspectToolName(tool)}.`,
      supportedTools: supportedToolNames(),
    },
  });
}

export function toolSpecs(): Record<string, unknown>[] {
  return [
    {
      name: LINEAR_GRAPHQL_TOOL,
      description: LINEAR_GRAPHQL_DESCRIPTION,
      inputSchema: LINEAR_GRAPHQL_INPUT_SCHEMA,
    },
  ];
}

async function executeLinearGraphql(
  args: unknown,
  opts: ExecuteOpts,
): Promise<DynamicToolResponse> {
  const linearClient: LinearClientFn =
    opts.linearClient ?? ((query, variables) => clientGraphql(query, variables));

  const normalized = normalizeLinearGraphqlArguments(args);
  if (!normalized.ok) {
    return failureResponse(toolErrorPayload(normalized.error));
  }
  const response = await linearClient(normalized.value.query, normalized.value.variables, []);
  if (isOkResult(response)) {
    return graphqlResponse(response.value);
  }
  if (isErrResult(response)) {
    return failureResponse(toolErrorPayload(response.error));
  }
  return failureResponse(toolErrorPayload(response));
}

type NormalizedArgs = { query: string; variables: Record<string, unknown> };

function normalizeLinearGraphqlArguments(args: unknown): Result<NormalizedArgs, unknown> {
  if (typeof args === "string") {
    const trimmed = args.trim();
    return trimmed === "" ? err({ tag: "missing_query" }) : ok({ query: trimmed, variables: {} });
  }
  if (isObject(args)) {
    const query = normalizeQuery(args);
    if (!query.ok) {
      return err(query.error);
    }
    const variables = normalizeVariables(args);
    if (!variables.ok) {
      return err(variables.error);
    }
    return ok({ query: query.value, variables: variables.value });
  }
  return err({ tag: "invalid_arguments" });
}

function normalizeQuery(args: Record<string, unknown>): Result<string, unknown> {
  const query = args.query;
  if (typeof query === "string") {
    const trimmed = query.trim();
    return trimmed === "" ? err({ tag: "missing_query" }) : ok(trimmed);
  }
  return err({ tag: "missing_query" });
}

function normalizeVariables(
  args: Record<string, unknown>,
): Result<Record<string, unknown>, unknown> {
  const variables = args.variables ?? {};
  if (isObject(variables)) {
    return ok(variables);
  }
  return err({ tag: "invalid_variables" });
}

function graphqlResponse(response: unknown): DynamicToolResponse {
  const errors = isObject(response) ? response.errors : undefined;
  const success = !(Array.isArray(errors) && errors.length > 0);
  return dynamicToolResponse(success, encodePayload(response));
}

function failureResponse(payload: unknown): DynamicToolResponse {
  return dynamicToolResponse(false, encodePayload(payload));
}

function dynamicToolResponse(success: boolean, output: string): DynamicToolResponse {
  return {
    success,
    output,
    contentItems: [{ type: "inputText", text: output }],
  };
}

function encodePayload(payload: unknown): string {
  if (isObject(payload) || Array.isArray(payload)) {
    return JSON.stringify(payload, null, 2);
  }
  return inspectReason(payload);
}

function toolErrorPayload(reason: unknown): Record<string, unknown> {
  const tag = isObject(reason) ? reason.tag : undefined;
  switch (tag) {
    case "missing_query":
      return { error: { message: "`linear_graphql` requires a non-empty `query` string." } };
    case "invalid_arguments":
      return {
        error: {
          message:
            "`linear_graphql` expects either a GraphQL query string or an object with `query` and optional `variables`.",
        },
      };
    case "invalid_variables":
      return {
        error: { message: "`linear_graphql.variables` must be a JSON object when provided." },
      };
    case "missing_linear_api_token":
      return {
        error: {
          message:
            "Symphony is missing Linear auth. Set `linear.api_key` in `WORKFLOW.md` or export `LINEAR_API_KEY`.",
        },
      };
    case "linear_api_status":
      return {
        error: {
          message: `Linear GraphQL request failed with HTTP ${(reason as { status: number }).status}.`,
          status: (reason as { status: number }).status,
        },
      };
    case "linear_api_request":
      return {
        error: {
          message: "Linear GraphQL request failed before receiving a successful response.",
          reason: inspectReason((reason as { reason: unknown }).reason),
        },
      };
    default:
      return {
        error: { message: "Linear GraphQL tool execution failed.", reason: inspectReason(reason) },
      };
  }
}

function supportedToolNames(): string[] {
  return toolSpecs().map((spec) => spec.name as string);
}

// ---- helpers ---------------------------------------------------------------

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isOkResult(value: unknown): value is { ok: true; value: unknown } {
  return isObject(value) && value.ok === true;
}

function isErrResult(value: unknown): value is { ok: false; error: unknown } {
  return isObject(value) && value.ok === false;
}

// Elixir `inspect` of a binary tool name: quoted.
function inspectToolName(name: unknown): string {
  return JSON.stringify(name);
}

// Elixir `inspect` of an atom reason (`:timeout`) — strings render `:name`.
function inspectReason(reason: unknown): string {
  if (typeof reason === "string") {
    return `:${reason}`;
  }
  return JSON.stringify(reason) ?? String(reason);
}
