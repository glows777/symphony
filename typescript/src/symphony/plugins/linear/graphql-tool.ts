// The `linear_graphql` agent-facing dynamic tool, exposed through the Linear
// plugin's agentTools capability. Argument normalization and the error payload
// copy moved here verbatim from codex/dynamic-tool.ts (originally a literal
// port of `symphony_elixir/codex/dynamic_tool.ex`); protocol encoding stays in
// the dispatcher.

import { type Result, err, ok } from "../../result.ts";
import type { AgentToolExecuteOpts, AgentToolOutcome, AgentToolSpec } from "../types.ts";
import { graphql as clientGraphql } from "./client.ts";

export const LINEAR_GRAPHQL_TOOL = "linear_graphql";
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

export type LinearClientFn = (
  query: string,
  variables: Record<string, unknown>,
  opts: unknown[],
) => Result<unknown, unknown> | Promise<Result<unknown, unknown>>;

export const linearGraphqlToolSpec: AgentToolSpec = {
  name: LINEAR_GRAPHQL_TOOL,
  description: LINEAR_GRAPHQL_DESCRIPTION,
  inputSchema: LINEAR_GRAPHQL_INPUT_SCHEMA,
};

export async function executeLinearGraphql(
  args: unknown,
  opts: AgentToolExecuteOpts = {},
): Promise<AgentToolOutcome> {
  const linearClient: LinearClientFn =
    (opts.linearClient as LinearClientFn | undefined) ??
    ((query, variables) => clientGraphql(query, variables));

  const normalized = normalizeLinearGraphqlArguments(args);
  if (!normalized.ok) {
    return { success: false, payload: toolErrorPayload(normalized.error) };
  }
  const response = await linearClient(normalized.value.query, normalized.value.variables, []);
  if (isOkResult(response)) {
    return graphqlOutcome(response.value);
  }
  if (isErrResult(response)) {
    return { success: false, payload: toolErrorPayload(response.error) };
  }
  return { success: false, payload: toolErrorPayload(response) };
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

function graphqlOutcome(response: unknown): AgentToolOutcome {
  const errors = isObject(response) ? response.errors : undefined;
  const success = !(Array.isArray(errors) && errors.length > 0);
  return { success, payload: response };
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

// Elixir `inspect` of an atom reason (`:timeout`) — strings render `:name`.
function inspectReason(reason: unknown): string {
  if (typeof reason === "string") {
    return `:${reason}`;
  }
  return JSON.stringify(reason) ?? String(reason);
}
