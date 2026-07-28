import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  type RequestFun,
  createComment,
  fetchCandidateIssues,
  fetchIssueComments,
  fetchIssueLabels,
  fetchIssueStatesByIds,
  fetchIssuesByStates,
  fetchRepositoryLabels,
  normalizeIssueForTest,
  replaceIssueLabels,
  updateIssueState,
} from "../../../../../src/symphony/plugins/trackers/gitea/client.ts";
import { workflowFilePath } from "../../../../../src/symphony/workflow.ts";
import { setupWorkflow, teardownWorkflow } from "../../../../support/test-support.ts";
import { writeGiteaWorkflowFile } from "./gitea-test-support.ts";

type Call = {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
};

function fakeTransport(
  calls: Call[],
  responses: { status: number; body: unknown; headers?: Record<string, string> }[],
): RequestFun {
  return (method, url, headers, body) => {
    calls.push({ method, url, headers, body });
    const response = responses.shift();
    if (response === undefined) {
      throw new Error("unexpected extra Gitea API request");
    }
    return { ok: true, value: response };
  };
}

function rawIssue(number: number, overrides: Record<string, unknown> = {}) {
  return {
    id: number + 1000,
    number,
    title: `Issue ${number}`,
    body: `Body ${number}`,
    state: "open",
    labels: [{ id: number, name: "Symphony" }],
    assignee: { id: 7, login: "runner" },
    assignees: [{ id: 7, login: "runner" }],
    html_url: `https://gitea.test/acme/symphony/issues/${number}`,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-02T00:00:00Z",
    ...overrides,
  };
}

describe("Gitea.Client", () => {
  let root: string;
  let savedToken: string | undefined;

  beforeEach(() => {
    savedToken = process.env.GITEA_API_TOKEN;
    Reflect.deleteProperty(process.env, "GITEA_API_TOKEN");
    ({ root } = setupWorkflow());
    writeGiteaWorkflowFile(workflowFilePath());
  });

  afterEach(() => {
    if (savedToken === undefined) {
      Reflect.deleteProperty(process.env, "GITEA_API_TOKEN");
    } else {
      process.env.GITEA_API_TOKEN = savedToken;
    }
    teardownWorkflow(root);
  });

  test("normalizes a Gitea issue into a stable, routable WorkItem", () => {
    const issue = normalizeIssueForTest(
      rawIssue(7, { labels: [{ name: "Symphony" }, { name: "Urgent" }] }),
    );

    expect(issue).not.toBeNull();
    expect(issue).toMatchObject({
      id: "acme/symphony#7",
      identifier: "acme/symphony#7",
      title: "Issue 7",
      description: "Body 7",
      state: "open",
      assigneeId: "7",
      labels: ["symphony", "urgent"],
      assignedToWorker: true,
      url: "https://gitea.test/acme/symphony/issues/7",
      metadata: {
        provider: "gitea",
        owner: "acme",
        repository: "symphony",
        issue_number: 7,
        gitea_id: "1007",
        gitea_state: "open",
      },
    });
    expect(issue?.createdAt).toEqual(new Date("2026-01-01T00:00:00Z"));
    expect(issue?.updatedAt).toEqual(new Date("2026-01-02T00:00:00Z"));
  });

  test("marks issues assigned to another Gitea user as not routable", () => {
    const other = rawIssue(8, {
      assignee: { id: 8, login: "other" },
      assignees: [{ id: 8, login: "other" }],
    });
    expect(normalizeIssueForTest(other, "runner")?.assignedToWorker).toBe(false);
    expect(normalizeIssueForTest(other, "8")?.assignedToWorker).toBe(true);
  });

  test("paginates candidate issues and applies labels plus assignee rules", async () => {
    writeGiteaWorkflowFile(workflowFilePath(), {
      required_labels: ["symphony", "backend"],
      assignee: "runner",
    });
    const calls: Call[] = [];
    const requestFun = fakeTransport(calls, [
      {
        status: 200,
        body: [
          rawIssue(1, { labels: [{ name: "Symphony" }, { name: "Backend" }] }),
          rawIssue(2, { labels: [{ name: "Symphony" }] }),
          rawIssue(3, {
            labels: [{ name: "Symphony" }, { name: "Backend" }],
            assignee: { id: 8, login: "other" },
            assignees: [{ id: 8, login: "other" }],
          }),
        ],
        headers: {
          "x-total-count": "4",
          link: '<https://gitea.test/api/v1/repos/acme/symphony/issues?state=open&type=issues&page=2&limit=50>; rel="next"',
        },
      },
      {
        status: 200,
        body: [rawIssue(4, { labels: [{ name: "Symphony" }, { name: "Backend" }] })],
        headers: { "x-total-count": "4" },
      },
    ]);

    const result = await fetchCandidateIssues({ requestFun });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.map((issue) => issue.identifier)).toEqual([
        "acme/symphony#1",
        "acme/symphony#4",
      ]);
    }
    expect(calls.map((call) => call.url)).toEqual([
      "https://gitea.test/api/v1/repos/acme/symphony/issues?state=open&type=issues&page=1&limit=50",
      "https://gitea.test/api/v1/repos/acme/symphony/issues?state=open&type=issues&page=2&limit=50",
    ]);
    expect(calls[0]?.headers.Authorization).toBe("token test-token");
  });

  test("accepts an empty issue page without making extra requests", async () => {
    const calls: Call[] = [];
    const result = await fetchIssuesByStates(["open"], {
      requestFun: fakeTransport(calls, [{ status: 200, body: [] }]),
    });

    expect(result).toEqual({ ok: true, value: [] });
    expect(calls).toHaveLength(1);
  });

  test("projects workflow state names onto Gitea open and closed", async () => {
    writeGiteaWorkflowFile(workflowFilePath(), {
      active_states: ["Todo", "In Progress"],
      terminal_states: ["Done"],
    });
    const calls: Call[] = [];
    const requestFun = fakeTransport(calls, [
      { status: 200, body: [rawIssue(9, { state: "closed" })] },
    ]);

    const result = await fetchIssuesByStates(["Done"], { requestFun });

    expect(result).toEqual({
      ok: true,
      value: [expect.objectContaining({ id: "acme/symphony#9", state: "Done" })],
    });
    expect(calls[0]?.url).toContain("state=closed");
  });

  test("refreshes issue states by repository issue number in request order", async () => {
    writeGiteaWorkflowFile(workflowFilePath(), {
      active_states: ["open"],
      terminal_states: ["closed"],
    });
    const calls: Call[] = [];
    const requestFun = fakeTransport(calls, [
      { status: 200, body: rawIssue(2, { state: "closed" }) },
      { status: 200, body: rawIssue(1, { state: "open" }) },
    ]);

    const result = await fetchIssueStatesByIds(["acme/symphony#2", "acme/symphony#1"], {
      requestFun,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.map((issue) => [issue.id, issue.state])).toEqual([
        ["acme/symphony#2", "closed"],
        ["acme/symphony#1", "open"],
      ]);
    }
    expect(calls.map((call) => call.url)).toEqual([
      "https://gitea.test/api/v1/repos/acme/symphony/issues/2",
      "https://gitea.test/api/v1/repos/acme/symphony/issues/1",
    ]);
  });

  test("creates comments and updates issue state through official routes", async () => {
    const calls: Call[] = [];
    const requestFun = fakeTransport(calls, [
      { status: 201, body: { id: 90 } },
      { status: 201, body: rawIssue(7, { state: "closed" }) },
    ]);

    expect(await createComment("acme/symphony#7", "Agent update", { requestFun })).toEqual({
      ok: true,
      value: undefined,
    });
    expect(await updateIssueState("acme/symphony#7", "closed", { requestFun })).toEqual({
      ok: true,
      value: undefined,
    });
    expect(calls[0]).toMatchObject({
      method: "POST",
      url: "https://gitea.test/api/v1/repos/acme/symphony/issues/7/comments",
      body: { body: "Agent update" },
    });
    expect(calls[1]).toMatchObject({
      method: "PATCH",
      url: "https://gitea.test/api/v1/repos/acme/symphony/issues/7",
      body: { state: "closed" },
    });
  });

  test("rejects foreign issue identifiers and invalid write payloads", async () => {
    const foreign = await createComment("other/symphony#7", "Agent update", {
      requestFun: () => {
        throw new Error("must not contact the wrong repository");
      },
    });
    expect(foreign).toMatchObject({ ok: false, error: { tag: "gitea_invalid_issue_id" } });

    const commentError = await createComment("acme/symphony#7", "Agent update", {
      requestFun: () => ({
        ok: true,
        value: { status: 201, body: { message: "comment rejected" } },
      }),
    });
    expect(commentError).toMatchObject({
      ok: false,
      error: { tag: "gitea_api_error", code: "provider_error" },
    });

    const issueError = await updateIssueState("acme/symphony#7", "closed", {
      requestFun: () => ({ ok: true, value: { status: 200, body: { unexpected: true } } }),
    });
    expect(issueError).toMatchObject({
      ok: false,
      error: { tag: "gitea_invalid_payload", code: "invalid_payload" },
    });
  });

  test("reads and replaces repository and issue labels", async () => {
    const calls: Call[] = [];
    const requestFun = fakeTransport(calls, [
      {
        status: 200,
        body: [{ id: 1, name: "one" }],
        headers: { "x-total-count": "51" },
      },
      { status: 200, body: [{ id: 2, name: "two" }], headers: { "x-total-count": "51" } },
      { status: 200, body: [{ id: 1, name: "one" }] },
      { status: 200, body: [{ id: 1, name: "one" }] },
    ]);

    expect((await fetchRepositoryLabels({ requestFun })).ok).toBe(true);
    expect((await fetchIssueLabels("acme/symphony#7", { requestFun })).ok).toBe(true);
    expect(await replaceIssueLabels("acme/symphony#7", ["one", 2], { requestFun })).toEqual({
      ok: true,
      value: [{ id: 1, name: "one" }],
    });
    expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual([
      "GET https://gitea.test/api/v1/repos/acme/symphony/labels?page=1&limit=50",
      "GET https://gitea.test/api/v1/repos/acme/symphony/labels?page=2&limit=50",
      "GET https://gitea.test/api/v1/repos/acme/symphony/issues/7/labels",
      "PUT https://gitea.test/api/v1/repos/acme/symphony/issues/7/labels",
    ]);
    expect(calls[3]?.body).toEqual({ labels: ["one", 2] });
  });

  test("reads issue comments and follows Link pagination", async () => {
    const calls: Call[] = [];
    const requestFun = fakeTransport(calls, [
      {
        status: 200,
        body: [{ id: 1, body: "first" }],
        headers: {
          link: '<https://gitea.test/api/v1/repos/acme/symphony/issues/7/comments?page=2>; rel="next"',
        },
      },
      { status: 200, body: [{ id: 2, body: "second" }] },
    ]);

    const result = await fetchIssueComments("acme/symphony#7", { requestFun });

    expect(result).toEqual({
      ok: true,
      value: [
        { id: 1, body: "first" },
        { id: 2, body: "second" },
      ],
    });
    expect(calls.map((call) => call.url)).toEqual([
      "https://gitea.test/api/v1/repos/acme/symphony/issues/7/comments",
      "https://gitea.test/api/v1/repos/acme/symphony/issues/7/comments?page=2",
    ]);
  });

  test("normalizes missing credentials, transport, HTTP, and payload failures", async () => {
    writeGiteaWorkflowFile(workflowFilePath(), { token: undefined });
    const missing = await fetchCandidateIssues();
    expect(missing).toMatchObject({ ok: false, error: { tag: "missing_gitea_api_token" } });

    writeGiteaWorkflowFile(workflowFilePath());
    const transport = await fetchIssuesByStates(["open"], {
      requestFun: () => ({ ok: false, error: "timeout" }),
    });
    expect(transport).toMatchObject({ ok: false, error: { code: "transport_failed" } });

    const denied = await fetchIssuesByStates(["open"], {
      requestFun: () => ({
        ok: true,
        value: { status: 403, body: { message: "permission denied" } },
      }),
    });
    expect(denied).toMatchObject({
      ok: false,
      error: {
        tag: "gitea_api_status",
        code: "provider_status",
        status: 403,
        detail: { body: { message: "permission denied" } },
      },
    });

    const notFound = await fetchIssueStatesByIds(["acme/symphony#404"], {
      requestFun: () => ({
        ok: true,
        value: { status: 404, body: { message: "issue not found" } },
      }),
    });
    expect(notFound).toMatchObject({
      ok: false,
      error: {
        tag: "gitea_api_status",
        code: "provider_status",
        status: 404,
        detail: { body: { message: "issue not found" } },
      },
    });

    const providerError = await fetchIssuesByStates(["open"], {
      requestFun: () => ({
        ok: true,
        value: { status: 200, body: { message: "business error" } },
      }),
    });
    expect(providerError).toMatchObject({
      ok: false,
      error: {
        tag: "gitea_api_error",
        code: "provider_error",
        detail: { body: { message: "business error" } },
      },
    });

    const invalid = await fetchIssuesByStates(["open"], {
      requestFun: () => ({ ok: true, value: { status: 200, body: { unexpected: true } } }),
    });
    expect(invalid).toMatchObject({ ok: false, error: { code: "invalid_payload" } });

    const invalidStatus = await fetchIssuesByStates(["open"], {
      requestFun: () => ({
        ok: true,
        value: { status: 99, body: [] },
      }),
    });
    expect(invalidStatus).toMatchObject({ ok: false, error: { code: "invalid_payload" } });
  });
});
