import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import {
  type GraphqlFun,
  type RequestFun,
  fetchIssueStatesByIdsForTest,
  fetchIssuesByStates,
  graphql,
  mergeIssuePagesForTest,
  normalizeIssueForTest,
} from "../../../src/symphony/linear/client.ts";
import { newIssue } from "../../../src/symphony/linear/issue.ts";
import { logger } from "../../../src/symphony/logger.ts";
import { ok } from "../../../src/symphony/result.ts";
import { setupWorkflow, teardownWorkflow } from "../../support/test-support.ts";

// Translated from the Linear client cases in workspace_and_config_test.exs.
describe("Linear.Client", () => {
  let root: string;

  beforeEach(() => {
    ({ root } = setupWorkflow());
  });

  afterEach(() => {
    teardownWorkflow(root);
  });

  test("normalizes blockers from inverse relations", () => {
    const rawIssue = {
      id: "issue-1",
      identifier: "MT-1",
      title: "Blocked todo",
      description: "Needs dependency",
      priority: 2,
      state: { name: "Todo" },
      branchName: "mt-1",
      url: "https://example.org/issues/MT-1",
      assignee: { id: "user-1" },
      labels: { nodes: [{ name: "Backend" }] },
      inverseRelations: {
        nodes: [
          {
            type: "blocks",
            issue: { id: "issue-2", identifier: "MT-2", state: { name: "In Progress" } },
          },
          {
            type: "relatesTo",
            issue: { id: "issue-3", identifier: "MT-3", state: { name: "Done" } },
          },
        ],
      },
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-02T00:00:00Z",
    };

    const issue = normalizeIssueForTest(rawIssue, "user-1");
    expect(issue).not.toBeNull();
    if (!issue) {
      return;
    }
    expect(issue.blockedBy).toEqual([{ id: "issue-2", identifier: "MT-2", state: "In Progress" }]);
    expect(issue.labels).toEqual(["backend"]);
    expect(issue.priority).toBe(2);
    expect(issue.state).toBe("Todo");
    expect(issue.assigneeId).toBe("user-1");
    expect(issue.assignedToWorker).toBe(true);
  });

  test("marks explicitly unassigned issues as not routed to worker", () => {
    const rawIssue = {
      id: "issue-99",
      identifier: "MT-99",
      title: "Someone else's task",
      state: { name: "Todo" },
      assignee: { id: "user-2" },
    };
    const issue = normalizeIssueForTest(rawIssue, "user-1");
    expect(issue?.assignedToWorker).toBe(false);
  });

  test("pagination merge helper preserves issue ordering", () => {
    const page1 = [
      newIssue({ id: "issue-1", identifier: "MT-1" }),
      newIssue({ id: "issue-2", identifier: "MT-2" }),
    ];
    const page2 = [newIssue({ id: "issue-3", identifier: "MT-3" })];

    const merged = mergeIssuePagesForTest([page1, page2]);
    expect(merged.map((i) => i.identifier)).toEqual(["MT-1", "MT-2", "MT-3"]);
  });

  test("paginates issue state fetches by id beyond one page", async () => {
    const issueIds = Array.from({ length: 55 }, (_, i) => `issue-${i + 1}`);
    const firstBatch = issueIds.slice(0, 50);
    const secondBatch = issueIds.slice(50);

    const rawIssue = (issueId: string) => {
      const suffix = issueId.replace(/^issue-/, "");
      return {
        id: issueId,
        identifier: `MT-${suffix}`,
        title: `Issue ${suffix}`,
        description: `Description ${suffix}`,
        state: { name: "In Progress" },
        labels: { nodes: [] },
        inverseRelations: { nodes: [] },
      };
    };

    const calls: { query: string; variables: Record<string, unknown> }[] = [];
    const graphqlFun: GraphqlFun = (query, variables) => {
      calls.push({ query, variables });
      const ids = variables.ids as string[];
      return ok({ data: { issues: { nodes: ids.map(rawIssue) } } });
    };

    const result = await fetchIssueStatesByIdsForTest(issueIds, graphqlFun);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.map((i) => i.id)).toEqual(issueIds);
    }

    expect(calls).toHaveLength(2);
    expect(calls[0]?.query).toContain("SymphonyLinearIssuesById");
    expect(calls[0]?.variables).toEqual({ ids: firstBatch, first: 50, relationFirst: 50 });
    expect(calls[1]?.variables).toEqual({ ids: secondBatch, first: 5, relationFirst: 50 });
  });

  test("logs response bodies for non-200 graphql responses", async () => {
    const errorSpy = spyOn(logger, "error").mockImplementation(() => {});
    try {
      const requestFun: RequestFun = () =>
        ok({
          status: 400,
          body: {
            errors: [
              {
                message: 'Variable "$ids" got invalid value',
                extensions: { code: "BAD_USER_INPUT" },
              },
            ],
          },
        });

      const result = await graphql("query Viewer { viewer { id } }", {}, { requestFun });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toEqual({ tag: "linear_api_status", status: 400 });
      }

      const logged = errorSpy.mock.calls.map((c) => String(c[0])).join("\n");
      expect(logged).toContain("Linear GraphQL request failed status=400");
      expect(logged).toContain("BAD_USER_INPUT");
    } finally {
      errorSpy.mockRestore();
    }
  });

  test("returns empty results for empty inputs", async () => {
    expect(await fetchIssuesByStates([])).toEqual(ok([]));
  });
});
