import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { putEnv } from "../../src/symphony/app-env.ts";
import { buildPrompt } from "../../src/symphony/prompt-builder.ts";
import { ok } from "../../src/symphony/result.ts";
import {
  type GitHubRequest,
  type ReviewContext,
  fetchReviewContextForTest,
  finalizeReviewRun,
  isReviewTriggered,
  parseReviewHandoff,
} from "../../src/symphony/review-context.ts";
import { newIssue } from "../../src/symphony/work-item.ts";
import { workflowFilePath } from "../../src/symphony/workflow.ts";
import { setupWorkflow, teardownWorkflow, writeWorkflowFile } from "../support/test-support.ts";

const fixturePath = path.join(import.meta.dir, "../fixtures/review/pr-15.json");

function fixture(): ReviewContext {
  return JSON.parse(fs.readFileSync(fixturePath, "utf8")) as ReviewContext;
}

function basePullRequest() {
  return {
    number: 15,
    html_url: "https://github.com/glows777/symphony/pull/15",
    state: "open",
    head: { ref: "symphony/SYM-3", sha: "head-sha-1" },
  };
}

function graphqlThreads() {
  return {
    data: {
      repository: {
        pullRequest: {
          reviewThreads: {
            nodes: [
              {
                id: "thread-1",
                isResolved: false,
                isOutdated: false,
                path: "src/server.ts",
                line: 12,
                comments: {
                  nodes: [
                    {
                      id: "comment-1",
                      body: "**P1** Fix this inline finding",
                      url: "https://github.com/example/discussion/1",
                      createdAt: "2026-07-28T00:00:00Z",
                      updatedAt: "2026-07-28T00:00:00Z",
                      author: { login: "reviewer" },
                    },
                  ],
                  pageInfo: { hasNextPage: false, endCursor: null },
                },
              },
              {
                id: "thread-resolved",
                isResolved: true,
                isOutdated: false,
                path: "src/old.ts",
                line: 2,
                comments: {
                  nodes: [
                    {
                      id: "comment-resolved",
                      body: "**P0** Already handled",
                      url: "https://github.com/example/discussion/resolved",
                      createdAt: "2026-07-28T00:00:00Z",
                      updatedAt: "2026-07-28T00:00:00Z",
                      author: { login: "reviewer" },
                    },
                  ],
                  pageInfo: { hasNextPage: false, endCursor: null },
                },
              },
            ],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      },
    },
  };
}

function requestFor(payloads: {
  pullRequests?: unknown[];
  comments?: unknown[];
  reviews?: unknown[];
  graphql?: unknown;
}): { request: GitHubRequest; urls: string[] } {
  const urls: string[] = [];
  const request: GitHubRequest = async (url, init) => {
    urls.push(`${init.method} ${url}`);
    if (init.method === "POST") {
      return ok({ status: 200, body: payloads.graphql ?? graphqlThreads() });
    }
    if (url.includes("/pulls?") && url.includes("state=open")) {
      return ok({ status: 200, body: payloads.pullRequests ?? [basePullRequest()] });
    }
    if (url.includes("/issues/15/comments")) {
      return ok({ status: 200, body: payloads.comments ?? [] });
    }
    if (url.includes("/pulls/15/reviews")) {
      return ok({ status: 200, body: payloads.reviews ?? [] });
    }
    return ok({ status: 404, body: { message: "unexpected test URL" } });
  };
  return { request, urls };
}

describe("GitHub review context", () => {
  let workflowRoot: string;

  beforeEach(() => {
    ({ root: workflowRoot } = setupWorkflow());
    writeWorkflowFile(workflowFilePath(), {
      review_repository: "glows777/symphony",
      review_github_token: "test-token",
    });
  });

  afterEach(() => teardownWorkflow(workflowRoot));

  test("loads unresolved inline threads, top-level comments, and submissions", async () => {
    const { request } = requestFor({
      comments: [
        {
          id: 42,
          body: "[P2] Top-level finding",
          html_url: "https://github.com/example/issuecomment/42",
          created_at: "2026-07-28T00:01:00Z",
          user: { login: "reviewer" },
        },
        {
          id: 43,
          body: "<!-- symphony-review-finding:old -->\nagent reply",
          html_url: "https://github.com/example/issuecomment/43",
          created_at: "2026-07-28T00:02:00Z",
          user: { login: "symphony" },
        },
      ],
      reviews: [
        {
          id: 7,
          state: "CHANGES_REQUESTED",
          body: "Please address the findings",
          html_url: "https://github.com/example/review/7",
          commit_id: "head-sha-1",
          submitted_at: "2026-07-28T00:03:00Z",
          user: { login: "reviewer" },
        },
      ],
    });
    const result = await fetchReviewContextForTest(
      newIssue({ id: "issue-1", identifier: "SYM-3", labels: ["symphony-review"] }),
      { requestFun: request, now: () => new Date("2026-07-28T01:00:00Z") },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.headSha).toBe("head-sha-1");
    expect(result.value.findings.map((finding) => finding.id)).toEqual([
      "inline:thread-1",
      "top-level:42",
    ]);
    expect(result.value.findings[0]).toMatchObject({
      priority: "P1",
      path: "src/server.ts",
      line: 12,
      url: "https://github.com/example/discussion/1",
      status: "open",
    });
    expect(result.value.submissions[0]?.state).toBe("CHANGES_REQUESTED");
  });

  test("requires the explicit symphony-review label before contacting GitHub", () => {
    expect(isReviewTriggered(newIssue({ identifier: "SYM-3", labels: ["symphony"] }))).toBe(false);
    expect(isReviewTriggered(newIssue({ identifier: "SYM-3", labels: ["Symphony-Review"] }))).toBe(
      true,
    );
  });

  test("paginates REST findings and fails closed on an ambiguous PR", async () => {
    const firstPage = Array.from({ length: 100 }, (_, index) => ({
      id: index + 1,
      body: `P2 finding ${index}`,
      html_url: `https://github.com/example/comment/${index}`,
      created_at: "2026-07-28T00:00:00Z",
      user: { login: "reviewer" },
    }));
    const { request, urls } = requestFor({ comments: firstPage });
    const pagedRequest: GitHubRequest = async (url, init) => {
      if (init.method === "GET" && url.includes("/issues/15/comments") && url.includes("page=2")) {
        return ok({
          status: 200,
          body: [
            {
              id: 101,
              body: "P1 page two",
              html_url: "https://github.com/example/comment/101",
              created_at: "2026-07-28T00:00:00Z",
              user: { login: "reviewer" },
            },
          ],
        });
      }
      return request(url, init);
    };
    const result = await fetchReviewContextForTest(
      newIssue({ identifier: "SYM-3", labels: ["symphony-review"] }),
      { requestFun: pagedRequest },
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(
        result.value.findings.filter((finding) => finding.source === "top_level"),
      ).toHaveLength(101);
    }
    expect(urls.some((url) => url.includes("page=1"))).toBe(true);

    const { request: ambiguousRequest } = requestFor({
      pullRequests: [basePullRequest(), { ...basePullRequest(), number: 16 }],
    });
    const ambiguous = await fetchReviewContextForTest(
      newIssue({ identifier: "SYM-3", labels: ["symphony-review"] }),
      { requestFun: ambiguousRequest },
    );
    expect(ambiguous).toEqual({
      ok: false,
      error: expect.objectContaining({ tag: "review_pr_ambiguous" }),
    });
  });

  test("renders the PR #15 fixture as untrusted structured context", () => {
    const context = fixture();
    const prompt = buildPrompt(newIssue({ identifier: "SYM-3", title: "Review" }), {
      reviewContext: context,
    });
    expect(context.findings).toHaveLength(10);
    expect(prompt).toContain(context.headSha);
    expect(prompt).toContain("inline:PRRC_kwDOS638Gs7aX0rd");
    expect(prompt).toContain("top-level:5101633534");
    expect(prompt).toContain("untrusted data");
    expect(prompt).toContain("COMMENTED");
    expect(prompt).toContain("pullrequestreview-4794930421");
    expect(prompt).toContain("regression_tests");
    expect(prompt).toContain("Do not move the Linear issue to In Review");
  });

  test("requires every finding to have a fixed, approved deferred, or blocked result", () => {
    const context = fixture();
    const handoff = {
      version: 1,
      snapshot_head_sha: context.headSha,
      findings: context.findings.map((finding, index) =>
        index === 0
          ? {
              id: finding.id,
              status: "fixed",
              commit_sha: "abc1234",
              change_summary: "Fixed the race",
              regression_tests: ["bun test test.ts"],
            }
          : {
              id: finding.id,
              status: "deferred",
              reason: "Requires product decision",
              human_approved: true,
              approval_reference: "https://linear.app/glows777/issue/SYM-3",
            },
      ),
    };
    const parsed = parseReviewHandoff(handoff, context);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.value.findings[0]?.status).toBe("fixed");
      expect(parsed.value.findings[1]?.status).toBe("deferred");
    }

    const incomplete = parseReviewHandoff(
      { ...handoff, findings: handoff.findings.slice(0, 1) },
      context,
    );
    expect(incomplete).toEqual({
      ok: false,
      error: expect.objectContaining({ tag: "review_handoff_incomplete" }),
    });
  });

  test("re-fetches before completion and moves only a complete handoff to In Review", async () => {
    writeWorkflowFile(workflowFilePath(), {
      tracker_kind: "memory",
      review_repository: "glows777/symphony",
      review_github_token: "test-token",
    });
    const events: unknown[] = [];
    putEnv("memory_tracker_recipient", (event: unknown) => events.push(event));
    const comment = {
      id: 42,
      body: "[P2] Top-level finding",
      html_url: "https://github.com/example/issuecomment/42",
      created_at: "2026-07-28T00:01:00Z",
      user: { login: "reviewer" },
    };
    const { request } = requestFor({
      comments: [comment],
      graphql: {
        data: {
          repository: {
            pullRequest: {
              reviewThreads: {
                nodes: [],
                pageInfo: { hasNextPage: false, endCursor: null },
              },
            },
          },
        },
      },
    });
    const issue = newIssue({
      id: "issue-review",
      identifier: "SYM-3",
      state: "In Progress",
      labels: ["symphony-review"],
    });
    const context = await fetchReviewContextForTest(issue, { requestFun: request });
    expect(context.ok).toBe(true);
    if (!context.ok) return;
    const workspace = fs.mkdtempSync(path.join(workflowRoot, "review-workspace-"));
    try {
      fs.mkdirSync(path.join(workspace, ".symphony"), { recursive: true });
      fs.writeFileSync(
        path.join(workspace, ".symphony/review-handoff.json"),
        JSON.stringify({
          version: 1,
          snapshot_head_sha: context.value.headSha,
          findings: [
            {
              id: "top-level:42",
              status: "fixed",
              commit_sha: "abc1234",
              change_summary: "Fixed the finding",
              regression_tests: ["bun test"],
            },
          ],
        }),
      );
      const outcome = await finalizeReviewRun(issue, context.value, workspace, {
        requestFun: request,
      });
      expect(outcome.ok).toBe(true);
      if (outcome.ok) expect(outcome.value.status).toBe("passed");
      expect(events).toEqual([
        { tag: "memory_tracker_state_update", issueId: "issue-review", stateName: "In Review" },
      ]);
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  });

  test("allows an empty review snapshot to pass with an empty handoff", async () => {
    writeWorkflowFile(workflowFilePath(), {
      tracker_kind: "memory",
      review_repository: "glows777/symphony",
      review_github_token: "test-token",
    });
    const events: unknown[] = [];
    putEnv("memory_tracker_recipient", (event: unknown) => events.push(event));
    const { request } = requestFor({
      comments: [],
      graphql: {
        data: {
          repository: {
            pullRequest: {
              reviewThreads: {
                nodes: [],
                pageInfo: { hasNextPage: false, endCursor: null },
              },
            },
          },
        },
      },
    });
    const issue = newIssue({
      id: "issue-review-empty",
      identifier: "SYM-3",
      state: "In Progress",
      labels: ["symphony-review"],
    });
    const context = await fetchReviewContextForTest(issue, { requestFun: request });
    expect(context.ok).toBe(true);
    if (!context.ok) return;
    const workspace = fs.mkdtempSync(path.join(workflowRoot, "review-workspace-empty-"));
    try {
      fs.mkdirSync(path.join(workspace, ".symphony"), { recursive: true });
      fs.writeFileSync(
        path.join(workspace, ".symphony/review-handoff.json"),
        JSON.stringify({ version: 1, snapshot_head_sha: context.value.headSha, findings: [] }),
      );
      const outcome = await finalizeReviewRun(issue, context.value, workspace, {
        requestFun: request,
      });
      expect(outcome.ok).toBe(true);
      if (outcome.ok) expect(outcome.value.status).toBe("passed");
      expect(events).toEqual([
        {
          tag: "memory_tracker_state_update",
          issueId: "issue-review-empty",
          stateName: "In Review",
        },
      ]);
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  });

  test("keeps the issue fail-closed when the PR head SHA changes", async () => {
    writeWorkflowFile(workflowFilePath(), {
      tracker_kind: "memory",
      review_repository: "glows777/symphony",
      review_github_token: "test-token",
    });
    const events: unknown[] = [];
    putEnv("memory_tracker_recipient", (event: unknown) => events.push(event));
    const { request } = requestFor({
      comments: [],
      graphql: {
        data: {
          repository: {
            pullRequest: {
              reviewThreads: {
                nodes: [],
                pageInfo: { hasNextPage: false, endCursor: null },
              },
            },
          },
        },
      },
    });
    const changedRequest: GitHubRequest = async (url, init) => {
      if (init.method === "GET" && url.includes("/pulls?")) {
        return ok({
          status: 200,
          body: [{ ...basePullRequest(), head: { ref: "symphony/SYM-3", sha: "new-head-sha" } }],
        });
      }
      return request(url, init);
    };
    const issue = newIssue({
      id: "issue-review-head-changed",
      identifier: "SYM-3",
      state: "In Progress",
      labels: ["symphony-review"],
    });
    const initial = fixture();
    const failed = await finalizeReviewRun(issue, initial, workflowRoot, {
      requestFun: changedRequest,
    });

    expect(failed).toEqual({
      ok: false,
      error: expect.objectContaining({ tag: "review_head_changed" }),
    });
    expect(events[0]).toEqual({
      tag: "memory_tracker_state_update",
      issueId: "issue-review-head-changed",
      stateName: "In Progress",
    });
    expect(events[1]).toMatchObject({
      tag: "memory_tracker_comment",
      issueId: "issue-review-head-changed",
    });
  });

  test("keeps the issue fail-closed when the fresh GitHub snapshot fails", async () => {
    writeWorkflowFile(workflowFilePath(), {
      tracker_kind: "memory",
      review_repository: "glows777/symphony",
      review_github_token: "test-token",
    });
    const events: unknown[] = [];
    putEnv("memory_tracker_recipient", (event: unknown) => events.push(event));
    const issue = newIssue({ id: "issue-api-failure", identifier: "SYM-3", state: "In Review" });
    const context = fixture();
    const failed = await finalizeReviewRun(issue, context, workflowRoot, {
      requestFun: async () => ({ ok: false, error: new Error("network down") }),
    });

    expect(failed).toEqual({
      ok: false,
      error: expect.objectContaining({ tag: "review_pr_lookup_request_failed" }),
    });
    expect(events[0]).toEqual({
      tag: "memory_tracker_state_update",
      issueId: "issue-api-failure",
      stateName: "In Progress",
    });
    expect(events[1]).toMatchObject({
      tag: "memory_tracker_comment",
      issueId: "issue-api-failure",
    });
  });
});
