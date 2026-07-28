import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { putEnv } from "../../../../../src/symphony/app-env.ts";
import { settingsBang, validate } from "../../../../../src/symphony/config.ts";
import type { GiteaApiClientFn } from "../../../../../src/symphony/plugins/trackers/gitea/api-tool.ts";
import type { GiteaClientModule } from "../../../../../src/symphony/plugins/trackers/gitea/client.ts";
import { GiteaPlugin } from "../../../../../src/symphony/plugins/trackers/gitea/plugin.ts";
import { ok } from "../../../../../src/symphony/result.ts";
import { newIssue } from "../../../../../src/symphony/work-item.ts";
import { workflowFilePath } from "../../../../../src/symphony/workflow.ts";
import { setupWorkflow, teardownWorkflow } from "../../../../support/test-support.ts";
import { writeGiteaWorkflowFile } from "./gitea-test-support.ts";

describe("Gitea.Plugin", () => {
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

  test("parses, finalizes, validates, and exposes Gitea settings", () => {
    process.env.GITEA_API_TOKEN = "env-token";
    writeGiteaWorkflowFile(workflowFilePath(), { token: "$GITEA_API_TOKEN" });

    const settings = settingsBang();
    expect(settings.tracker.kind).toBe("gitea");
    expect(settings.tracker.plugin).toMatchObject({
      endpoint: "https://gitea.test",
      token: "env-token",
      owner: "acme",
      repo: "symphony",
    });
    expect(validate()).toEqual({ ok: true, value: undefined });
  });

  test("supports the documented token and repository aliases", () => {
    writeGiteaWorkflowFile(workflowFilePath(), {
      endpoint: "https://gitea.test/api/v1/",
      token: undefined,
      api_token: "$GITEA_API_TOKEN",
      owner: undefined,
      user: "acme",
      repo: undefined,
      repository_name: "symphony",
    });
    process.env.GITEA_API_TOKEN = "alias-token";

    const settings = settingsBang();
    expect(settings.tracker.plugin).toMatchObject({
      endpoint: "https://gitea.test/api/v1/",
      token: "alias-token",
      owner: "acme",
      repo: "symphony",
    });
    expect(GiteaPlugin.ui?.projectUrl?.(settings)).toBe("https://gitea.test/acme/symphony");
  });

  test("reports missing endpoint, token, owner, and repository configuration", () => {
    const cases: [Record<string, unknown>, string][] = [
      [{ endpoint: undefined }, "missing_gitea_endpoint"],
      [{ token: undefined }, "missing_gitea_api_token"],
      [{ owner: undefined }, "missing_gitea_owner"],
      [{ repo: undefined }, "missing_gitea_repository"],
    ];

    for (const [overrides, tag] of cases) {
      writeGiteaWorkflowFile(workflowFilePath(), overrides);
      const result = validate();
      expect(result).toMatchObject({ ok: false, error: { tag } });
    }
  });

  test("uses the injected client module for reads and write capabilities", async () => {
    const issue = newIssue({ id: "acme/symphony#1", identifier: "acme/symphony#1", state: "open" });
    const calls: string[] = [];
    const fake: GiteaClientModule = {
      fetchCandidateIssues: () => {
        calls.push("candidate");
        return Promise.resolve(ok([issue]));
      },
      fetchIssuesByStates: (states) => {
        calls.push(`states:${states.join(",")}`);
        return Promise.resolve(ok([issue]));
      },
      fetchIssueStatesByIds: (ids) => {
        calls.push(`ids:${ids.join(",")}`);
        return Promise.resolve(ok([issue]));
      },
      createComment: (issueId, body) => {
        calls.push(`comment:${issueId}:${body}`);
        return ok(undefined);
      },
      updateIssueState: (issueId, state) => {
        calls.push(`state:${issueId}:${state}`);
        return ok(undefined);
      },
    };
    putEnv("gitea_client_module", fake);

    expect(await GiteaPlugin.fetchCandidateIssues()).toEqual(ok([issue]));
    expect(await GiteaPlugin.fetchIssuesByStates(["open"])).toEqual(ok([issue]));
    expect(await GiteaPlugin.fetchIssueStatesByIds(["acme/symphony#1"])).toEqual(ok([issue]));
    expect(await GiteaPlugin.comments?.createComment("acme/symphony#1", "hello")).toEqual(
      ok(undefined),
    );
    expect(await GiteaPlugin.stateUpdates?.updateIssueState("acme/symphony#1", "closed")).toEqual(
      ok(undefined),
    );
    expect(calls).toEqual([
      "candidate",
      "states:open",
      "ids:acme/symphony#1",
      "comment:acme/symphony#1:hello",
      "state:acme/symphony#1:closed",
    ]);
  });

  test("exposes only the constrained gitea_api tool", async () => {
    expect(GiteaPlugin.agentTools?.listAgentTools()).toEqual([
      expect.objectContaining({ name: "gitea_api" }),
    ]);

    const calls: unknown[] = [];
    const giteaClient: GiteaApiClientFn = (method, path, body) => {
      calls.push({ method, path, body });
      return ok({ login: "runner" });
    };
    const success = await GiteaPlugin.agentTools?.executeAgentTool(
      "gitea_api",
      { method: "GET", path: "/api/v1/user" },
      {
        giteaClient,
      },
    );
    expect(success).toEqual({ success: true, payload: { login: "runner" } });
    expect(calls).toEqual([{ method: "GET", path: "/api/v1/user", body: null }]);

    const invalid = await GiteaPlugin.agentTools?.executeAgentTool("gitea_api", {
      method: "GET",
      path: "https://other.example/api/v1/user",
    });
    expect(invalid).toMatchObject({
      success: false,
      payload: { error: { message: expect.stringContaining("start with `/api/v1/`") } },
    });

    const unknown = await GiteaPlugin.agentTools?.executeAgentTool("linear_graphql", {});
    expect(unknown).toEqual({
      success: false,
      payload: { error: { message: 'Unsupported dynamic tool: "linear_graphql".' } },
    });
  });
});
