import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { putEnv } from "../../src/symphony/app-env.ts";
import * as Adapter from "../../src/symphony/linear/adapter.ts";
import type { GraphqlOpts, LinearClientModule } from "../../src/symphony/linear/client.ts";
import type { Issue } from "../../src/symphony/linear/issue.ts";
import { newIssue } from "../../src/symphony/linear/issue.ts";
import { LinearPlugin } from "../../src/symphony/plugins/linear/plugin.ts";
import { MemoryPlugin } from "../../src/symphony/plugins/memory/plugin.ts";
import { type Result, err, ok } from "../../src/symphony/result.ts";
import type { MemoryEvent } from "../../src/symphony/tracker/memory.ts";
import * as Memory from "../../src/symphony/tracker/memory.ts";
import * as Tracker from "../../src/symphony/tracker/tracker.ts";
import { workflowFilePath } from "../../src/symphony/workflow.ts";
import { setupWorkflow, teardownWorkflow, writeWorkflowFile } from "../support/test-support.ts";

describe("Tracker", () => {
  let root: string;

  beforeEach(() => {
    ({ root } = setupWorkflow());
  });

  afterEach(() => {
    teardownWorkflow(root);
  });

  test("delegates to memory and linear adapters", async () => {
    const issue = newIssue({ id: "issue-1", identifier: "MT-1", state: "In Progress" });
    const events: MemoryEvent[] = [];
    putEnv("memory_tracker_issues", [issue, { id: "ignored" }]);
    putEnv("memory_tracker_recipient", (event: MemoryEvent) => events.push(event));
    writeWorkflowFile(workflowFilePath(), { tracker_kind: "memory" });

    expect(Tracker.adapter()).toBe(MemoryPlugin);
    expect(await Tracker.fetchCandidateIssues()).toEqual(ok([issue]));
    expect(await Tracker.fetchIssuesByStates([" in progress ", 42 as unknown as string])).toEqual(
      ok([issue]),
    );
    expect(await Tracker.fetchIssueStatesByIds(["issue-1"])).toEqual(ok([issue]));
    expect(await Tracker.createComment("issue-1", "comment")).toEqual(ok(undefined));
    expect(await Tracker.updateIssueState("issue-1", "Done")).toEqual(ok(undefined));

    expect(events).toEqual([
      { tag: "memory_tracker_comment", issueId: "issue-1", body: "comment" },
      { tag: "memory_tracker_state_update", issueId: "issue-1", stateName: "Done" },
    ]);

    writeWorkflowFile(workflowFilePath(), { tracker_kind: "linear" });
    expect(Tracker.adapter()).toBe(LinearPlugin);
  });

  test("linear adapter delegates reads and validates mutation responses", async () => {
    const calls: { query: string; variables: Record<string, unknown> }[] = [];
    let graphqlResult: Result<unknown, unknown> | unknown;
    let graphqlResults: (Result<unknown, unknown> | unknown)[] | null = null;

    const fake: LinearClientModule = {
      fetchCandidateIssues: () => {
        calls.push({ query: "fetch_candidate_issues", variables: {} });
        return Promise.resolve(ok(["candidate"] as unknown as never));
      },
      fetchIssuesByStates: (states) => Promise.resolve(ok(states as unknown as never)),
      fetchIssueStatesByIds: (ids) => Promise.resolve(ok(ids as unknown as never)),
      graphql: (query: string, variables: Record<string, unknown> = {}, _opts?: GraphqlOpts) => {
        calls.push({ query, variables });
        if (graphqlResults !== null) {
          return graphqlResults.shift() as Result<unknown, unknown>;
        }
        return graphqlResult as Result<unknown, unknown>;
      },
    };
    putEnv("linear_client_module", fake);

    expect(await Adapter.fetchCandidateIssues()).toEqual(
      ok(["candidate"]) as unknown as Result<Issue[], unknown>,
    );
    expect(await Adapter.fetchIssuesByStates(["Todo"])).toEqual(
      ok(["Todo"]) as unknown as Result<Issue[], unknown>,
    );
    expect(await Adapter.fetchIssueStatesByIds(["issue-1"])).toEqual(
      ok(["issue-1"]) as unknown as Result<Issue[], unknown>,
    );

    graphqlResult = ok({ data: { commentCreate: { success: true } } });
    expect(await Adapter.createComment("issue-1", "hello")).toEqual(ok(undefined));
    const createCall = calls.at(-1);
    expect(createCall?.query).toContain("commentCreate");
    expect(createCall?.variables).toEqual({ issueId: "issue-1", body: "hello" });

    graphqlResult = ok({ data: { commentCreate: { success: false } } });
    expect(await Adapter.createComment("issue-1", "broken")).toEqual(
      err({ tag: "comment_create_failed" }),
    );

    graphqlResult = err("boom");
    expect(await Adapter.createComment("issue-1", "boom")).toEqual(err("boom"));

    graphqlResult = ok({ data: {} });
    expect(await Adapter.createComment("issue-1", "weird")).toEqual(
      err({ tag: "comment_create_failed" }),
    );

    graphqlResult = "unexpected";
    expect(await Adapter.createComment("issue-1", "odd")).toEqual(
      err({ tag: "comment_create_failed" }),
    );

    // update_issue_state: state lookup then mutation.
    graphqlResults = [
      ok({ data: { issue: { team: { states: { nodes: [{ id: "state-1" }] } } } } }),
      ok({ data: { issueUpdate: { success: true } } }),
    ];
    expect(await Adapter.updateIssueState("issue-1", "Done")).toEqual(ok(undefined));

    graphqlResults = [
      ok({ data: { issue: { team: { states: { nodes: [{ id: "state-1" }] } } } } }),
      ok({ data: { issueUpdate: { success: false } } }),
    ];
    expect(await Adapter.updateIssueState("issue-1", "Broken")).toEqual(
      err({ tag: "issue_update_failed" }),
    );

    graphqlResults = [err("boom")];
    expect(await Adapter.updateIssueState("issue-1", "Boom")).toEqual(err("boom"));

    graphqlResults = [ok({ data: {} })];
    expect(await Adapter.updateIssueState("issue-1", "Missing")).toEqual(
      err({ tag: "state_not_found" }),
    );

    graphqlResults = [
      ok({ data: { issue: { team: { states: { nodes: [{ id: "state-1" }] } } } } }),
      ok({ data: {} }),
    ];
    expect(await Adapter.updateIssueState("issue-1", "Weird")).toEqual(
      err({ tag: "issue_update_failed" }),
    );

    graphqlResults = [
      ok({ data: { issue: { team: { states: { nodes: [{ id: "state-1" }] } } } } }),
      "unexpected",
    ];
    expect(await Adapter.updateIssueState("issue-1", "Odd")).toEqual(
      err({ tag: "issue_update_failed" }),
    );
  });

  test("memory adapter stays quiet without a recipient", async () => {
    expect(await Memory.createComment("issue-1", "quiet")).toEqual(ok(undefined));
    expect(await Memory.updateIssueState("issue-1", "Quiet")).toEqual(ok(undefined));
  });
});
