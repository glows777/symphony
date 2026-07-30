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
  request,
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

const STATE_LABELS = {
  Todo: "symphony/state-todo",
  "In Progress": "symphony/state-in-progress",
  "Human Review": "symphony/state-review",
  Rework: "symphony/state-rework",
  Done: "symphony/state-done",
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
          link: '<https://gitea.test/api/v1/repos/acme/symphony/issues?state=open&page=2&limit=50>; rel="next"',
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
      "https://gitea.test/api/v1/repos/acme/symphony/issues?state=open&page=1&limit=50",
      "https://gitea.test/api/v1/repos/acme/symphony/issues?state=open&page=2&limit=50",
    ]);
    expect(calls[0]?.headers.Authorization).toBe("token test-token");
  });

  test("resolves assignee me from the authenticated Gitea user", async () => {
    writeGiteaWorkflowFile(workflowFilePath(), { assignee: "me" });
    const calls: Call[] = [];
    const result = await fetchCandidateIssues({
      requestFun: fakeTransport(calls, [
        {
          status: 200,
          body: { id: 7, login: "runner", username: "runner" },
        },
        {
          status: 200,
          body: [
            rawIssue(9),
            rawIssue(10, { assignee: null, assignees: [] }),
            rawIssue(11, {
              assignee: { id: 8, login: "other" },
              assignees: [{ id: 8, login: "other" }],
            }),
          ],
        },
      ]),
    });

    expect(result).toEqual({
      ok: true,
      value: [expect.objectContaining({ identifier: "acme/symphony#9" })],
    });
    expect(calls.map((call) => call.url)).toEqual([
      "https://gitea.test/api/v1/user",
      "https://gitea.test/api/v1/repos/acme/symphony/issues?state=open&page=1&limit=50",
    ]);
  });

  test("filters pull requests when the Gitea instance rejects type=issues", async () => {
    writeGiteaWorkflowFile(workflowFilePath(), {
      required_labels: ["symphony", "backend"],
      assignee: "runner",
    });
    const calls: Call[] = [];
    const result = await fetchCandidateIssues({
      requestFun: fakeTransport(calls, [
        {
          status: 200,
          body: [
            rawIssue(5, { labels: [{ name: "Symphony" }, { name: "Backend" }] }),
            rawIssue(6, {
              labels: [{ name: "Symphony" }, { name: "Backend" }],
              pull_request: { url: "https://gitea.test/acme/symphony/pulls/6" },
            }),
          ],
        },
      ]),
    });

    expect(result).toEqual({
      ok: true,
      value: [expect.objectContaining({ identifier: "acme/symphony#5" })],
    });
    expect(calls.map((call) => call.url)).toEqual([
      "https://gitea.test/api/v1/repos/acme/symphony/issues?state=open&page=1&limit=50",
    ]);
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
      state_labels: STATE_LABELS,
    });
    const calls: Call[] = [];
    const requestFun = fakeTransport(calls, [
      {
        status: 200,
        body: [
          rawIssue(9, {
            state: "closed",
            labels: [{ name: "Symphony" }, { name: "symphony/state-done" }],
          }),
        ],
      },
    ]);

    const result = await fetchIssuesByStates(["Done"], { requestFun });

    expect(result).toEqual({
      ok: true,
      value: [expect.objectContaining({ id: "acme/symphony#9", state: "Done" })],
    });
    expect(calls[0]?.url).toContain("state=closed");
  });

  test("projects configured state labels without folding open workflow states", () => {
    writeGiteaWorkflowFile(workflowFilePath(), {
      active_states: ["Todo", "In Progress", "Rework"],
      terminal_states: ["Done"],
      state_labels: STATE_LABELS,
    });

    expect(
      normalizeIssueForTest(
        rawIssue(10, {
          labels: [{ name: "Symphony" }, { name: "symphony/state-in-progress" }],
        }),
      )?.state,
    ).toBe("In Progress");
    expect(
      normalizeIssueForTest(
        rawIssue(11, {
          labels: [{ name: "Symphony" }, { name: "symphony/state-review" }],
        }),
      )?.state,
    ).toBe("Human Review");
    expect(
      normalizeIssueForTest(
        rawIssue(12, {
          state: "closed",
          labels: [{ name: "Symphony" }, { name: "symphony/state-done" }],
        }),
      )?.state,
    ).toBe("Done");
  });

  test("filters candidates by configured state labels while keeping required labels separate", async () => {
    writeGiteaWorkflowFile(workflowFilePath(), {
      active_states: ["Todo", "In Progress", "Rework"],
      terminal_states: ["Done"],
      required_labels: ["symphony"],
      state_labels: STATE_LABELS,
    });
    const calls: Call[] = [];
    const requestFun = fakeTransport(calls, [
      {
        status: 200,
        body: [
          rawIssue(20, {
            labels: [{ name: "Symphony" }, { name: "symphony/state-todo" }],
          }),
          rawIssue(21, {
            labels: [{ name: "Symphony" }, { name: "symphony/state-review" }],
          }),
          rawIssue(22, {
            labels: [{ name: "Backend" }, { name: "symphony/state-in-progress" }],
          }),
          rawIssue(23, {
            labels: [{ name: "Symphony" }, { name: "symphony/state-in-progress" }],
          }),
        ],
      },
    ]);

    const result = await fetchCandidateIssues({ requestFun });

    expect(result).toEqual({
      ok: true,
      value: [
        expect.objectContaining({ id: "acme/symphony#20", state: "Todo" }),
        expect.objectContaining({ id: "acme/symphony#23", state: "In Progress" }),
      ],
    });
    expect(calls).toHaveLength(1);
  });

  test("persists stateUpdates through configured labels across the next refresh", async () => {
    writeGiteaWorkflowFile(workflowFilePath(), {
      active_states: ["Todo", "In Progress", "Rework"],
      terminal_states: ["Done"],
      state_labels: STATE_LABELS,
    });
    const calls: Call[] = [];
    const requestFun = fakeTransport(calls, [
      {
        status: 200,
        body: rawIssue(30, {
          labels: [
            { id: 1, name: "Symphony" },
            { id: 3, name: "symphony/state-in-progress" },
          ],
        }),
      },
      {
        status: 200,
        body: [
          { id: 3, name: "symphony/state-in-progress" },
          { id: 4, name: "symphony/state-review" },
          { id: 5, name: "symphony/state-done" },
        ],
      },
      {
        status: 200,
        body: rawIssue(30, {
          labels: [
            { id: 1, name: "Symphony" },
            { id: 3, name: "symphony/state-in-progress" },
          ],
        }),
      },
      {
        status: 200,
        body: [
          { id: 1, name: "Symphony" },
          { id: 2, name: "Backend" },
          { id: 3, name: "symphony/state-in-progress" },
        ],
      },
      {
        status: 200,
        body: [
          { id: 1, name: "Symphony" },
          { id: 2, name: "Backend" },
          { id: 3, name: "symphony/state-in-progress" },
          { id: 4, name: "symphony/state-review" },
        ],
      },
      { status: 204, body: null },
      {
        status: 200,
        body: rawIssue(30, {
          labels: [
            { id: 1, name: "Symphony" },
            { id: 2, name: "Backend" },
            { id: 4, name: "symphony/state-review" },
          ],
        }),
      },
      {
        status: 200,
        body: rawIssue(30, {
          labels: [
            { id: 1, name: "Symphony" },
            { id: 2, name: "Backend" },
            { id: 4, name: "symphony/state-review" },
          ],
        }),
      },
    ]);

    expect(await updateIssueState("acme/symphony#30", "Human Review", { requestFun })).toEqual({
      ok: true,
      value: undefined,
    });
    const refreshed = await fetchIssueStatesByIds(["acme/symphony#30"], { requestFun });

    expect(refreshed).toEqual({
      ok: true,
      value: [
        expect.objectContaining({
          id: "acme/symphony#30",
          state: "Human Review",
          labels: ["symphony", "backend", "symphony/state-review"],
        }),
      ],
    });
    expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual([
      "GET https://gitea.test/api/v1/repos/acme/symphony/issues/30",
      "GET https://gitea.test/api/v1/repos/acme/symphony/labels?page=1&limit=50",
      "PATCH https://gitea.test/api/v1/repos/acme/symphony/issues/30",
      "GET https://gitea.test/api/v1/repos/acme/symphony/issues/30/labels",
      "POST https://gitea.test/api/v1/repos/acme/symphony/issues/30/labels",
      "DELETE https://gitea.test/api/v1/repos/acme/symphony/issues/30/labels/3",
      "GET https://gitea.test/api/v1/repos/acme/symphony/issues/30",
      "GET https://gitea.test/api/v1/repos/acme/symphony/issues/30",
    ]);
    expect(calls[2]?.body).toEqual({ state: "open" });
    expect(calls[4]?.body).toEqual({ labels: [4] });
    expect(calls.some((call) => call.method === "PUT")).toBe(false);
  });

  test("writes terminal state labels and removes stale active state labels", async () => {
    writeGiteaWorkflowFile(workflowFilePath(), {
      active_states: ["Todo", "In Progress", "Rework"],
      terminal_states: ["Done"],
      state_labels: STATE_LABELS,
    });
    const calls: Call[] = [];

    expect(
      await updateIssueState("acme/symphony#31", "Done", {
        requestFun: fakeTransport(calls, [
          {
            status: 200,
            body: rawIssue(31, {
              labels: [
                { id: 1, name: "Symphony" },
                { id: 2, name: "symphony/state-todo" },
                { id: 3, name: "symphony/state-in-progress" },
              ],
            }),
          },
          {
            status: 200,
            body: [
              { id: 2, name: "symphony/state-todo" },
              { id: 3, name: "symphony/state-in-progress" },
              { id: 4, name: "symphony/state-done" },
            ],
          },
          {
            status: 200,
            body: rawIssue(31, {
              state: "closed",
              labels: [
                { id: 1, name: "Symphony" },
                { id: 2, name: "symphony/state-todo" },
                { id: 3, name: "symphony/state-in-progress" },
              ],
            }),
          },
          {
            status: 200,
            body: [
              { id: 1, name: "Symphony" },
              { id: 2, name: "symphony/state-todo" },
              { id: 3, name: "symphony/state-in-progress" },
            ],
          },
          {
            status: 200,
            body: [
              { id: 1, name: "Symphony" },
              { id: 2, name: "symphony/state-todo" },
              { id: 3, name: "symphony/state-in-progress" },
              { id: 4, name: "symphony/state-done" },
            ],
          },
          { status: 204, body: null },
          { status: 204, body: null },
          {
            status: 200,
            body: rawIssue(31, {
              state: "closed",
              labels: [
                { id: 1, name: "Symphony" },
                { id: 4, name: "symphony/state-done" },
              ],
            }),
          },
        ]),
      }),
    ).toEqual({ ok: true, value: undefined });

    expect(calls.map((call) => call.method)).toEqual([
      "GET",
      "GET",
      "PATCH",
      "GET",
      "POST",
      "DELETE",
      "DELETE",
      "GET",
    ]);
    expect(calls[2]?.body).toEqual({ state: "closed" });
    expect(calls[4]?.body).toEqual({ labels: [4] });
  });

  test("rolls back native state when label reconciliation fails after PATCH", async () => {
    writeGiteaWorkflowFile(workflowFilePath(), {
      active_states: ["Todo", "In Progress", "Rework"],
      terminal_states: ["Done"],
      state_labels: STATE_LABELS,
    });
    const calls: Call[] = [];
    const issueLabels = [{ id: 3, name: "symphony/state-in-progress" }];
    const requestFun = fakeTransport(calls, [
      { status: 200, body: rawIssue(32, { labels: issueLabels }) },
      {
        status: 200,
        body: [
          { id: 3, name: "symphony/state-in-progress" },
          { id: 4, name: "symphony/state-done" },
        ],
      },
      { status: 200, body: rawIssue(32, { state: "closed", labels: issueLabels }) },
      { status: 200, body: issueLabels },
      { status: 500, body: { message: "label write failed" } },
      { status: 200, body: issueLabels },
      { status: 500, body: { message: "label write failed" } },
      { status: 200, body: issueLabels },
      { status: 500, body: { message: "label write failed" } },
      { status: 200, body: rawIssue(32, { state: "open", labels: issueLabels }) },
    ]);

    const result = await updateIssueState("acme/symphony#32", "Done", { requestFun });

    expect(result).toMatchObject({
      ok: false,
      error: {
        tag: "gitea_state_label_update_failed",
        detail: {
          cause: { tag: "gitea_state_label_reconcile_failed" },
          rollback: { ok: true },
        },
      },
    });
    expect(calls.map((call) => call.method)).toEqual([
      "GET",
      "GET",
      "PATCH",
      "GET",
      "POST",
      "GET",
      "POST",
      "GET",
      "POST",
      "PATCH",
    ]);
    expect(calls[2]?.body).toEqual({ state: "closed" });
    expect(calls[9]?.body).toEqual({ state: "open" });
  });

  test("handles duplicate, stale, and unknown state labels deterministically", () => {
    writeGiteaWorkflowFile(workflowFilePath(), {
      active_states: ["Todo", "In Progress", "Rework"],
      terminal_states: ["Done"],
      state_labels: STATE_LABELS,
    });

    expect(
      normalizeIssueForTest(
        rawIssue(40, {
          labels: [
            { name: "Symphony" },
            { name: "symphony/state-review" },
            { name: "symphony/state-in-progress" },
          ],
        }),
      )?.state,
    ).toBe("In Progress");
    expect(
      normalizeIssueForTest(
        rawIssue(41, {
          labels: [{ name: "Symphony" }, { name: "symphony/state-unknown" }],
        }),
      )?.state,
    ).toBe("Todo");
    expect(
      normalizeIssueForTest(
        rawIssue(42, {
          state: "closed",
          labels: [{ name: "Symphony" }, { name: "symphony/state-in-progress" }],
        }),
      )?.state,
    ).toBe("Done");
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

  test("skips missing issues while preserving the remaining refresh results", async () => {
    const calls: Call[] = [];
    const result = await fetchIssueStatesByIds(["acme/symphony#404", "acme/symphony#1"], {
      requestFun: fakeTransport(calls, [
        { status: 404, body: { message: "issue not found" } },
        { status: 200, body: rawIssue(1) },
      ]),
    });

    expect(result).toMatchObject({
      ok: true,
      value: [expect.objectContaining({ id: "acme/symphony#1" })],
    });
    expect(calls).toHaveLength(2);
  });

  test("creates comments and updates issue state through official routes", async () => {
    const calls: Call[] = [];
    const requestFun = fakeTransport(calls, [
      { status: 201, body: { id: 90 } },
      { status: 200, body: rawIssue(7) },
      {
        status: 200,
        body: [
          { id: 1, name: "symphony/state-open" },
          { id: 2, name: "symphony/state-closed" },
        ],
      },
      { status: 201, body: rawIssue(7, { state: "closed" }) },
      { status: 200, body: [{ id: 7, name: "Symphony" }] },
      {
        status: 200,
        body: [
          { id: 7, name: "Symphony" },
          { id: 2, name: "symphony/state-closed" },
        ],
      },
      {
        status: 200,
        body: rawIssue(7, {
          state: "closed",
          labels: [
            { id: 7, name: "Symphony" },
            { id: 2, name: "symphony/state-closed" },
          ],
        }),
      },
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
    expect(calls[3]).toMatchObject({
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

  test("rejects redirects at the authenticated API boundary", async () => {
    const originalFetch = globalThis.fetch;
    let fetchOptions: RequestInit | undefined;
    globalThis.fetch = (async (_input, options) => {
      fetchOptions = options;
      return new Response("[]", { status: 200 });
    }) as typeof fetch;

    try {
      expect(await request("GET", "/api/v1/repos/acme/symphony/issues")).toEqual({
        ok: true,
        value: [],
      });
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(fetchOptions?.redirect).toBe("error");
  });

  test("bounds pagination when the provider keeps returning unique next links", async () => {
    let calls = 0;
    const result = await fetchIssueComments("acme/symphony#7", {
      requestFun: (_method, _url, _headers, _body) => {
        calls += 1;
        return {
          ok: true,
          value: {
            status: 200,
            body: [{ id: calls, body: `comment ${calls}` }],
            headers: {
              link: `<https://gitea.test/api/v1/repos/acme/symphony/issues/7/comments?page=${calls + 1}>; rel="next"`,
            },
          },
        };
      },
    });

    expect(result).toMatchObject({ ok: false, error: { tag: "gitea_pagination_limit" } });
    expect(calls).toBe(100);
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
    expect(notFound).toEqual({ ok: true, value: [] });

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
