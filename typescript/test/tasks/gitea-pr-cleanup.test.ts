import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  type HttpRequest,
  type Shell,
  closeOpenPullRequests,
  main,
} from "../../src/tasks/gitea-pr-cleanup.ts";

function recordingShell(): Shell & { out: string[]; err: string[] } {
  const shell = {
    out: [] as string[],
    err: [] as string[],
    info(message: string) {
      shell.out.push(message);
    },
    error(message: string) {
      shell.err.push(message);
    },
  };
  return shell;
}

describe("gitea-pr-cleanup", () => {
  let savedToken: string | undefined;

  beforeEach(() => {
    savedToken = process.env.GITEA_API_TOKEN;
  });

  afterEach(() => {
    if (savedToken === undefined) {
      Reflect.deleteProperty(process.env, "GITEA_API_TOKEN");
    } else {
      process.env.GITEA_API_TOKEN = savedToken;
    }
  });

  test("lists open pull requests for the branch and closes each one", async () => {
    process.env.GITEA_API_TOKEN = "test-token";
    const calls: { url: string; init: RequestInit | undefined }[] = [];
    const responses = [
      new Response(JSON.stringify([{ number: 101 }, { number: 102 }]), { status: 200 }),
      new Response("{}", { status: 200 }),
      new Response("{}", { status: 200 }),
    ];
    const request: HttpRequest = async (url, init) => {
      calls.push({ url, init });
      return responses.shift() as Response;
    };
    const shell = recordingShell();

    await closeOpenPullRequests(
      {
        endpoint: "https://gitea.test",
        owner: "acme",
        repo: "symphony",
        branch: "symphony/ENG-7",
      },
      { request, shell },
    );

    expect(calls[0]?.url).toBe(
      "https://gitea.test/api/v1/repos/acme/symphony/pulls?state=open&head=symphony%2FENG-7&limit=50",
    );
    expect(calls[0]?.init?.headers).toMatchObject({
      Accept: "application/json",
      Authorization: "token test-token",
    });
    expect(calls[1]?.init).toMatchObject({
      method: "PATCH",
      body: JSON.stringify({ state: "closed" }),
    });
    expect(calls[2]?.url).toBe("https://gitea.test/api/v1/repos/acme/symphony/pulls/102");
    expect(shell.out).toEqual([
      "Closed Gitea PR #101 for branch symphony/ENG-7",
      "Closed Gitea PR #102 for branch symphony/ENG-7",
    ]);
  });

  test("accepts an endpoint that already includes the API prefix", async () => {
    const calls: string[] = [];
    const request: HttpRequest = async (url) => {
      calls.push(url);
      return new Response("[]", { status: 200 });
    };

    await closeOpenPullRequests(
      {
        endpoint: "https://gitea.test/api/v1/",
        owner: "acme",
        repo: "symphony",
        branch: "main",
        token: "explicit-token",
      },
      { request },
    );

    expect(calls[0]).toStartWith("https://gitea.test/api/v1/repos/acme/symphony/pulls?");
  });

  test("fails closed when listing or closing a pull request fails", async () => {
    const request: HttpRequest = async () => new Response("denied", { status: 403 });
    await expect(
      closeOpenPullRequests(
        {
          endpoint: "https://gitea.test",
          owner: "acme",
          repo: "symphony",
          branch: "symphony/ENG-7",
          token: "test-token",
        },
        { request },
      ),
    ).rejects.toThrow("Gitea pull-request list failed: HTTP 403: denied");
  });

  test("reports CLI argument errors without making a request", async () => {
    const shell = recordingShell();
    const code = await main(["--endpoint", "https://gitea.test"], shell, async () => {
      throw new Error("request should not run");
    });

    expect(code).toBe(2);
    expect(shell.err).toEqual(["endpoint, owner, repo, and a current branch are required"]);
  });
});
