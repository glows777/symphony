import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
// Side-effect import mirrors production entry points: schema casting delegates
// the tracker plugin section to the registered plugin for the configured kind.
import "../../../src/symphony/plugins/index.ts";
import {
  type Settings,
  StringOrMap,
  normalizeStateLimits,
  parse,
  resolveRuntimeTurnSandboxPolicy,
  resolveTurnSandboxPolicy,
  validateStateLimits,
} from "../../../src/symphony/config/schema.ts";

const DEFAULT_WORKSPACE_ROOT = path.join(os.tmpdir(), "symphony_workspaces");

function parseOk(config: Record<string, unknown>): Settings {
  const result = parse(config);
  if (!result.ok) {
    throw new Error(`expected ok, got ${JSON.stringify(result.error)}`);
  }
  return result.value;
}

describe("Config.Schema helpers", () => {
  test("StringOrMap custom type", () => {
    expect(StringOrMap.type()).toBe("map");
    expect(StringOrMap.embedAs("json")).toBe("self");
    expect(StringOrMap.equal({ a: 1 }, { a: 1 })).toBe(true);
    expect(StringOrMap.equal({ a: 1 }, { a: 2 })).toBe(false);

    expect(StringOrMap.cast("value")).toEqual({ ok: true, value: "value" });
    expect(StringOrMap.cast({ a: 1 })).toEqual({ ok: true, value: { a: 1 } });
    expect(StringOrMap.cast(123).ok).toBe(false);

    expect(StringOrMap.load("value")).toEqual({ ok: true, value: "value" });
    expect(StringOrMap.load(123).ok).toBe(false);
    expect(StringOrMap.dump({ a: 1 })).toEqual({ ok: true, value: { a: 1 } });
    expect(StringOrMap.dump(123).ok).toBe(false);
  });

  test("normalize/validate state limits", () => {
    expect(normalizeStateLimits(null)).toEqual({});
    expect(normalizeStateLimits({ "In Progress": 2, todo: 1 })).toEqual({
      todo: 1,
      "in progress": 2,
    });

    expect(validateStateLimits({ "": 1, todo: 0 })).toEqual([
      "state names must not be blank",
      "limits must be positive integers",
    ]);
  });
});

describe("Config.Schema.parse", () => {
  const linearKey = "LINEAR_API_KEY";
  let savedLinear: string | undefined;
  let emptyEnv: string;
  let missingWorkspaceEnv: string;
  let missingSecretEnv: string;

  beforeEach(() => {
    savedLinear = process.env[linearKey];
    const unique = `${process.pid}_${Math.floor(Math.random() * 1e9)}`;
    emptyEnv = `SYMP_EMPTY_SECRET_${unique}`;
    missingWorkspaceEnv = `SYMP_MISSING_WORKSPACE_${unique}`;
    missingSecretEnv = `SYMP_MISSING_SECRET_${unique}`;
    process.env[emptyEnv] = "";
    delete process.env[missingWorkspaceEnv];
    delete process.env[missingSecretEnv];
    process.env[linearKey] = "fallback-linear-token";
  });

  afterEach(() => {
    if (savedLinear === undefined) {
      delete process.env[linearKey];
    } else {
      process.env[linearKey] = savedLinear;
    }
    delete process.env[emptyEnv];
  });

  test("normalizes policy keys and env-backed fallbacks", () => {
    const settings = parseOk({
      tracker: { kind: "linear", api_key: `$${emptyEnv}` },
      workspace: { root: `$${missingWorkspaceEnv}` },
      codex: { approval_policy: { reject: { sandbox_approval: true } } },
    });

    expect(settings.tracker.plugin.api_key).toBeNull();
    expect(settings.workspace.root).toBe(DEFAULT_WORKSPACE_ROOT);
    expect(settings.codex.approvalPolicy).toEqual({ reject: { sandbox_approval: true } });

    const fallback = parseOk({
      tracker: { kind: "linear", api_key: `$${missingSecretEnv}` },
      workspace: { root: "" },
    });
    expect(fallback.tracker.plugin.api_key).toBe("fallback-linear-token");
    expect(fallback.workspace.root).toBe(DEFAULT_WORKSPACE_ROOT);
  });

  test("delegates the tracker plugin section by kind", () => {
    const linear = parseOk({ tracker: { kind: "linear", project_slug: "proj" } });
    expect(linear.tracker.plugin).toEqual({
      endpoint: "https://api.linear.app/graphql",
      api_key: "fallback-linear-token",
      project_slug: "proj",
      assignee: null,
    });

    const memory = parseOk({
      tracker: { kind: "memory", seed_issues: [{ id: "seed-1" }], api_key: "ignored" },
    });
    expect(memory.tracker.plugin).toEqual({ seed_issues: [{ id: "seed-1" }] });

    // Unregistered kinds pass the raw section through untouched; parse
    // succeeds and config.validate() reports the unsupported kind.
    const unknown = parseOk({ tracker: { kind: "jira", base_url: "https://example.test" } });
    expect(unknown.tracker.plugin).toEqual({ kind: "jira", base_url: "https://example.test" });

    const invalid = parse({ tracker: { kind: "linear", api_key: 123 } });
    expect(invalid.ok).toBe(false);
    if (!invalid.ok) {
      expect(invalid.error.message).toContain("tracker.api_key");
    }
  });

  test("reports invalid fields with their path", () => {
    const result = parse({ tracker: { active_states: "," } });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("tracker.active_states");
    }

    const numberError = parse({ agent: { max_concurrent_agents: "bad" } });
    expect(numberError.ok).toBe(false);
    if (!numberError.ok) {
      expect(numberError.error.message).toContain("agent.max_concurrent_agents");
    }

    const portError = parse({ server: { port: -1 } });
    expect(portError.ok).toBe(false);
    if (!portError.ok) {
      expect(portError.error.message).toContain("server.port");
    }
  });

  test("empty codex strings are kept (empty_values: [])", () => {
    const settings = parseOk({ codex: { approval_policy: "", thread_sandbox: "" } });
    expect(settings.codex.approvalPolicy).toBe("");
    expect(settings.codex.threadSandbox).toBe("");
  });

  test("future/opaque policy values pass through", () => {
    const settings = parseOk({
      codex: {
        approval_policy: "future-policy",
        thread_sandbox: "future-sandbox",
        turn_sandbox_policy: { type: "futureSandbox", nested: { flag: true } },
      },
    });
    expect(settings.codex.approvalPolicy).toBe("future-policy");
    expect(settings.codex.threadSandbox).toBe("future-sandbox");
    expect(settings.codex.turnSandboxPolicy).toEqual({
      type: "futureSandbox",
      nested: { flag: true },
    });
  });

  test("per-state agent limits normalize and reject bad values", () => {
    const ok = parseOk({
      agent: {
        max_concurrent_agents: 10,
        max_concurrent_agents_by_state: { todo: 1, "In Progress": 4, "In Review": 2 },
      },
    });
    expect(ok.agent.maxConcurrentAgentsByState).toEqual({
      todo: 1,
      "in progress": 4,
      "in review": 2,
    });

    const bad = parse({
      agent: { max_concurrent_agents_by_state: { Todo: "1", Review: 0, Done: "bad" } },
    });
    expect(bad.ok).toBe(false);
  });
});

describe("Config.Schema sandbox policies", () => {
  function settingsWith(overrides: {
    workspaceRoot?: string;
    turnSandboxPolicy?: Record<string, unknown> | null;
  }): Settings {
    const base = parseOk({});
    return {
      ...base,
      workspace: { root: overrides.workspaceRoot ?? base.workspace.root },
      codex: {
        ...base.codex,
        turnSandboxPolicy:
          overrides.turnSandboxPolicy === undefined ? null : overrides.turnSandboxPolicy,
      },
    };
  }

  test("explicit policy passes through; defaults expand workspace", () => {
    const explicit = { type: "workspaceWrite", writableRoots: ["/tmp/explicit"] };
    expect(
      resolveTurnSandboxPolicy(
        settingsWith({ workspaceRoot: "/tmp/ignored", turnSandboxPolicy: explicit }),
      ),
    ).toEqual(explicit);

    expect(resolveTurnSandboxPolicy(settingsWith({ workspaceRoot: "" }))).toEqual({
      type: "workspaceWrite",
      writableRoots: [path.resolve(DEFAULT_WORKSPACE_ROOT)],
      readOnlyAccess: { type: "fullAccess" },
      networkAccess: false,
      excludeTmpdirEnvVar: false,
      excludeSlashTmp: false,
    });

    expect(
      resolveTurnSandboxPolicy(settingsWith({ workspaceRoot: "/tmp/ignored" }), "/tmp/workspace"),
    ).toEqual({
      type: "workspaceWrite",
      writableRoots: [path.resolve("/tmp/workspace")],
      readOnlyAccess: { type: "fullAccess" },
      networkAccess: false,
      excludeTmpdirEnvVar: false,
      excludeSlashTmp: false,
    });
  });

  test("keeps workspace roots raw while expanding only for local use", () => {
    const settings = parseOk({ workspace: { root: "~/.symphony-workspaces" }, codex: {} });
    expect(settings.workspace.root).toBe("~/.symphony-workspaces");

    expect(resolveTurnSandboxPolicy(settings)).toEqual({
      type: "workspaceWrite",
      writableRoots: [path.resolve("~/.symphony-workspaces")],
      readOnlyAccess: { type: "fullAccess" },
      networkAccess: false,
      excludeTmpdirEnvVar: false,
      excludeSlashTmp: false,
    });

    const remote = resolveRuntimeTurnSandboxPolicy(settings, null, { remote: true });
    expect(remote.ok).toBe(true);
    if (remote.ok) {
      expect(remote.value.writableRoots).toEqual(["~/.symphony-workspaces"]);
    }
  });

  describe("runtime resolution branches", () => {
    let testRoot: string;
    let workspaceRoot: string;

    beforeEach(() => {
      testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "symphony-runtime-sandbox-"));
      workspaceRoot = path.join(testRoot, "workspaces");
      fs.mkdirSync(workspaceRoot);
    });

    afterEach(() => {
      fs.rmSync(testRoot, { recursive: true, force: true });
    });

    test("defaults when omitted, ignores workspace for explicit policies", () => {
      const settings = settingsWith({ workspaceRoot });
      const canonical = fs.realpathSync(workspaceRoot);

      const def = resolveRuntimeTurnSandboxPolicy(settings);
      expect(def.ok).toBe(true);
      if (def.ok) {
        expect(def.value.type).toBe("workspaceWrite");
        expect(def.value.writableRoots).toEqual([canonical]);
      }

      const blank = resolveRuntimeTurnSandboxPolicy(settings, "");
      expect(blank).toEqual(def);

      const readOnly = settingsWith({
        workspaceRoot,
        turnSandboxPolicy: { type: "readOnly", networkAccess: true },
      });
      expect(resolveRuntimeTurnSandboxPolicy(readOnly, 123)).toEqual({
        ok: true,
        value: { type: "readOnly", networkAccess: true },
      });

      const invalid = resolveRuntimeTurnSandboxPolicy(settings, 123);
      expect(invalid.ok).toBe(false);
      if (!invalid.ok) {
        expect(invalid.error).toEqual({
          tag: "unsafe_turn_sandbox_policy",
          reason: { tag: "invalid_workspace_root", value: 123 },
        });
      }
    });
  });
});
