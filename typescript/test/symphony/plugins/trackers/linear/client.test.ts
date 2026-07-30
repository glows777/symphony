import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { logger } from "../../../../../src/symphony/logger.ts";
import {
  type GraphqlFun,
  type RequestFun,
  fetchIssueStatesByIdsForTest,
  fetchIssuesByStates,
  graphql,
  mergeIssuePagesForTest,
  normalizeIssueForTest,
} from "../../../../../src/symphony/plugins/trackers/linear/client.ts";
import type { TrackerError } from "../../../../../src/symphony/plugins/trackers/types.ts";
import { ok } from "../../../../../src/symphony/result.ts";
import { newIssue } from "../../../../../src/symphony/work-item.ts";
import {
  setupWorkflow,
  teardownWorkflow,
  writeWorkflowFile,
} from "../../../../support/test-support.ts";

// Translated from the Linear client cases in workspace_and_config_test.exs.
describe("Linear.Client", () => {
  let root: string;
  let workflowFile: string;

  beforeEach(() => {
    ({ root, workflowFile } = setupWorkflow());
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
        expect(result.error).toEqual({
          tag: "linear_api_status",
          code: "provider_status",
          message: "Linear GraphQL request failed with HTTP 400",
          status: 400,
        } as TrackerError);
      }

      const logged = errorSpy.mock.calls.map((c) => String(c[0])).join("\n");
      expect(logged).toContain("Linear GraphQL request failed status=400");
      expect(logged).toContain("BAD_USER_INPUT");
    } finally {
      errorSpy.mockRestore();
    }
  });

  test("serializes transport failure diagnostics for graphql request errors", async () => {
    const rawEndpoint = "https://linear-user:linear-pass@api.linear.app/graphql?api_key=secret";
    writeWorkflowFile(workflowFile, {
      tracker_endpoint: rawEndpoint,
    });
    const errorSpy = spyOn(logger, "error").mockImplementation(() => {});
    try {
      const cause = Object.assign(
        new Error("getaddrinfo ENOTFOUND api.linear.app Authorization=token api_key=secret"),
        {
          code: "ENOTFOUND",
          syscall: "getaddrinfo",
          hostname: "api.linear.app",
        },
      );
      const error = new TypeError(`fetch failed for ${rawEndpoint} with Authorization=token`, {
        cause,
      });
      const requestFun: RequestFun = () => ({ ok: false, error });

      const result = await graphql("query Viewer { viewer { id } }", {}, { requestFun });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        const errorWithReason = result.error as TrackerError & { reason: unknown };
        expect(() => JSON.stringify(errorWithReason.reason)).not.toThrow();
        expect(result.error).toMatchObject({
          tag: "linear_api_request",
          code: "transport_failed",
          message: "Linear GraphQL request failed before receiving a response",
          reason: {
            phase: "request",
            request: {
              endpoint: "https://api.linear.app/graphql",
              operationName: "Viewer",
            },
            error: {
              type: "TypeError",
              message:
                "fetch failed for https://api.linear.app/graphql with Authorization=<redacted>",
              cause: {
                type: "Error",
                message:
                  "getaddrinfo ENOTFOUND api.linear.app Authorization=<redacted> api_key=<redacted>",
                code: "ENOTFOUND",
                syscall: "getaddrinfo",
                hostname: "api.linear.app",
              },
            },
          },
        } as TrackerError & { reason: unknown });
      }

      const logged = errorSpy.mock.calls.map((c) => String(c[0])).join("\n");
      expect(logged).toContain(
        '"message":"fetch failed for https://api.linear.app/graphql with Authorization=<redacted>"',
      );
      expect(logged).toContain('"code":"ENOTFOUND"');
      expect(logged).toContain('"endpoint":"https://api.linear.app/graphql"');
      expect(logged).not.toContain("linear-user");
      expect(logged).not.toContain("linear-pass");
      expect(logged).not.toContain("api_key=secret");
      expect(logged).not.toContain("Authorization=token");
    } finally {
      errorSpy.mockRestore();
    }
  });

  test("sanitizes non-error transport failures before logging", async () => {
    const errorSpy = spyOn(logger, "error").mockImplementation(() => {});
    try {
      const circular: Record<string, unknown> = {
        api_key: "secret",
        nested: ["Authorization=token", 1n],
      };
      circular.self = circular;
      const requestFun: RequestFun = () => ({
        ok: false,
        error: ["Authorization=secret", 1n, circular],
      });

      const result = await graphql("query Viewer { viewer { id } }", {}, { requestFun });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        const errorWithReason = result.error as TrackerError & { reason: unknown };
        expect(() => JSON.stringify(errorWithReason.reason)).not.toThrow();
        expect(result.error).toMatchObject({
          tag: "linear_api_request",
          code: "transport_failed",
          message: "Linear GraphQL request failed before receiving a response",
          reason: {
            phase: "request",
            request: {
              endpoint: "https://api.linear.app/graphql",
              operationName: "Viewer",
            },
            error: {
              type: "Array",
              value: [
                "Authorization=<redacted>",
                "1",
                {
                  api_key: "<redacted>",
                  nested: ["Authorization=<redacted>", "1"],
                  self: { type: "Circular" },
                },
              ],
            },
          },
        } as TrackerError & { reason: unknown });
      }

      const logged = errorSpy.mock.calls.map((c) => String(c[0])).join("\n");
      expect(logged).toContain('"type":"Array"');
      expect(logged).toContain('"api_key":"<redacted>"');
      expect(logged).not.toContain("Authorization=secret");
      expect(logged).not.toContain("Authorization=token");
      expect(logged).not.toContain('"api_key":"secret"');
    } finally {
      errorSpy.mockRestore();
    }
  });

  test("returns transport failure instead of throwing for bigint rejections", async () => {
    const errorSpy = spyOn(logger, "error").mockImplementation(() => {});
    try {
      const requestFun: RequestFun = () => ({ ok: false, error: 1n });

      const result = await graphql("query Viewer { viewer { id } }", {}, { requestFun });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        const errorWithReason = result.error as TrackerError & { reason: unknown };
        expect(() => JSON.stringify(errorWithReason.reason)).not.toThrow();
        expect(result.error).toMatchObject({
          tag: "linear_api_request",
          code: "transport_failed",
          message: "Linear GraphQL request failed before receiving a response",
          reason: {
            error: {
              type: "bigint",
              value: "1",
            },
          },
        } as TrackerError & { reason: unknown });
      }
    } finally {
      errorSpy.mockRestore();
    }
  });

  test("returns empty results for empty inputs", async () => {
    expect(await fetchIssuesByStates([])).toEqual(ok([]));
  });
});
