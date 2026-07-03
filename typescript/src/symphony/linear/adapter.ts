// Literal port of `symphony_elixir/linear/adapter.ex`.
//
// Linear-backed tracker adapter. Reads delegate to the configured client module
// (overridable via the `linear_client_module` app-env, default Client);
// mutations validate the GraphQL response.

import { getEnv } from "../app-env.ts";
import { type Result, err, ok } from "../result.ts";
import { Client, type LinearClientModule } from "./client.ts";
import type { Issue } from "./issue.ts";

const CREATE_COMMENT_MUTATION = `mutation SymphonyCreateComment($issueId: String!, $body: String!) {
  commentCreate(input: {issueId: $issueId, body: $body}) {
    success
  }
}`;

const UPDATE_STATE_MUTATION = `mutation SymphonyUpdateIssueState($issueId: String!, $stateId: String!) {
  issueUpdate(id: $issueId, input: {stateId: $stateId}) {
    success
  }
}`;

const STATE_LOOKUP_QUERY = `query SymphonyResolveStateId($issueId: String!, $stateName: String!) {
  issue(id: $issueId) {
    team {
      states(filter: {name: {eq: $stateName}}, first: 1) {
        nodes {
          id
        }
      }
    }
  }
}`;

function clientModule(): LinearClientModule {
  return getEnv<LinearClientModule>("linear_client_module", Client);
}

export function fetchCandidateIssues(): Promise<Result<Issue[], unknown>> {
  return Promise.resolve(clientModule().fetchCandidateIssues());
}

export function fetchIssuesByStates(states: string[]): Promise<Result<Issue[], unknown>> {
  return Promise.resolve(clientModule().fetchIssuesByStates(states));
}

export function fetchIssueStatesByIds(ids: string[]): Promise<Result<Issue[], unknown>> {
  return Promise.resolve(clientModule().fetchIssueStatesByIds(ids));
}

export async function createComment(
  issueId: string,
  body: string,
): Promise<Result<undefined, unknown>> {
  const response = await clientModule().graphql(CREATE_COMMENT_MUTATION, { issueId, body });
  if (isOkResult(response)) {
    const success = getInPath(response.value, ["data", "commentCreate", "success"]) === true;
    return success ? ok(undefined) : err(commentCreateFailedError());
  }
  if (isErrResult(response)) {
    return err(response.error);
  }
  return err(commentCreateFailedError());
}

export async function updateIssueState(
  issueId: string,
  stateName: string,
): Promise<Result<undefined, unknown>> {
  const stateId = await resolveStateId(issueId, stateName);
  if (!stateId.ok) {
    return err(stateId.error);
  }
  const response = await clientModule().graphql(UPDATE_STATE_MUTATION, {
    issueId,
    stateId: stateId.value,
  });
  if (isOkResult(response)) {
    const success = getInPath(response.value, ["data", "issueUpdate", "success"]) === true;
    return success ? ok(undefined) : err(issueUpdateFailedError());
  }
  if (isErrResult(response)) {
    return err(response.error);
  }
  return err(issueUpdateFailedError());
}

async function resolveStateId(
  issueId: string,
  stateName: string,
): Promise<Result<string, unknown>> {
  const response = await clientModule().graphql(STATE_LOOKUP_QUERY, { issueId, stateName });
  if (isErrResult(response)) {
    return err(response.error);
  }
  if (isOkResult(response)) {
    const stateId = getInPath(response.value, [
      "data",
      "issue",
      "team",
      "states",
      "nodes",
      0,
      "id",
    ]);
    if (typeof stateId === "string") {
      return ok(stateId);
    }
  }
  return err({
    tag: "state_not_found",
    code: "provider_error",
    message: `Linear workflow state ${JSON.stringify(stateName)} not found`,
  });
}

// Legacy tags preserved; `code`/`message` follow the TrackerError convention
// from plugins/types.ts.

function commentCreateFailedError() {
  return {
    tag: "comment_create_failed",
    code: "provider_error",
    message: "Linear comment creation failed",
  } as const;
}

function issueUpdateFailedError() {
  return {
    tag: "issue_update_failed",
    code: "provider_error",
    message: "Linear issue state update failed",
  } as const;
}

function isOkResult(value: unknown): value is { ok: true; value: unknown } {
  return typeof value === "object" && value !== null && (value as { ok?: unknown }).ok === true;
}

function isErrResult(value: unknown): value is { ok: false; error: unknown } {
  return typeof value === "object" && value !== null && (value as { ok?: unknown }).ok === false;
}

function getInPath(value: unknown, keys: (string | number)[]): unknown {
  let current: unknown = value;
  for (const key of keys) {
    if (typeof key === "number") {
      if (!Array.isArray(current)) {
        return undefined;
      }
      current = current[key];
    } else if (typeof current === "object" && current !== null && !Array.isArray(current)) {
      current = (current as Record<string, unknown>)[key];
    } else {
      return undefined;
    }
  }
  return current;
}
