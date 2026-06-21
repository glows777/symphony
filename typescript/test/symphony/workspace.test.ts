import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { canonicalize } from "../../src/symphony/path-safety.ts";
import { workflowFilePath } from "../../src/symphony/workflow.ts";
import { createForIssue, remove, removeIssueWorkspaces } from "../../src/symphony/workspace.ts";
import { setupWorkflow, teardownWorkflow, writeWorkflowFile } from "../support/test-support.ts";

function canonical(p: string): string {
  const result = canonicalize(p);
  if (!result.ok) {
    throw new Error("canonicalize failed");
  }
  return result.value;
}

// Translated from the workspace cases in workspace_and_config_test.exs.
describe("Workspace", () => {
  let workflowRoot: string;
  let testRoot: string;

  beforeEach(() => {
    ({ root: workflowRoot } = setupWorkflow());
    testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "symphony-ws-"));
  });

  afterEach(() => {
    teardownWorkflow(workflowRoot);
    fs.rmSync(testRoot, { recursive: true, force: true });
  });

  // The Elixir test bootstraps via `git clone`; this sandbox's git commit
  // signing is unavailable, so we bootstrap from a template dir to exercise the
  // same behavior (after_create populates the freshly created workspace).
  test("bootstrap can be implemented in an after_create hook", () => {
    const templateRepo = path.join(testRoot, "source");
    const workspaceRoot = path.join(testRoot, "workspaces");
    fs.mkdirSync(path.join(templateRepo, "keep"), { recursive: true });
    fs.writeFileSync(path.join(templateRepo, "keep", "file.txt"), "keep me");
    fs.writeFileSync(path.join(templateRepo, "README.md"), "hook clone\n");

    writeWorkflowFile(workflowFilePath(), {
      workspace_root: workspaceRoot,
      hook_after_create: `cp -R ${templateRepo}/. .`,
    });

    const result = createForIssue("S-1");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(fs.readFileSync(path.join(result.value, "README.md"), "utf8")).toBe("hook clone\n");
      expect(fs.readFileSync(path.join(result.value, "keep", "file.txt"), "utf8")).toBe("keep me");
    }
  });

  test("workspace path is deterministic per issue identifier", () => {
    const workspaceRoot = path.join(testRoot, "workspaces");
    writeWorkflowFile(workflowFilePath(), { workspace_root: workspaceRoot });

    const first = createForIssue("MT/Det");
    const second = createForIssue("MT/Det");
    expect(first.ok && second.ok).toBe(true);
    if (first.ok && second.ok) {
      expect(first.value).toBe(second.value);
      expect(path.basename(first.value)).toBe("MT_Det");
    }
  });

  test("reuses existing issue directory without deleting local changes", () => {
    const workspaceRoot = path.join(testRoot, "workspaces");
    writeWorkflowFile(workflowFilePath(), {
      workspace_root: workspaceRoot,
      hook_after_create: "echo first > README.md",
    });

    const first = createForIssue("MT-REUSE");
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    fs.writeFileSync(path.join(first.value, "README.md"), "changed\n");
    fs.writeFileSync(path.join(first.value, "local-progress.txt"), "in progress\n");

    const second = createForIssue("MT-REUSE");
    expect(second.ok).toBe(true);
    if (second.ok) {
      expect(second.value).toBe(first.value);
      expect(fs.readFileSync(path.join(second.value, "README.md"), "utf8")).toBe("changed\n");
      expect(fs.readFileSync(path.join(second.value, "local-progress.txt"), "utf8")).toBe(
        "in progress\n",
      );
    }
  });

  test("replaces stale non-directory paths", () => {
    const workspaceRoot = path.join(testRoot, "workspaces");
    const staleWorkspace = path.join(workspaceRoot, "MT-STALE");
    fs.mkdirSync(workspaceRoot, { recursive: true });
    fs.writeFileSync(staleWorkspace, "old state\n");
    writeWorkflowFile(workflowFilePath(), { workspace_root: workspaceRoot });

    const result = createForIssue("MT-STALE");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toBe(canonical(staleWorkspace));
      expect(fs.statSync(result.value).isDirectory()).toBe(true);
    }
  });

  test("rejects symlink escapes under the configured root", () => {
    const workspaceRoot = path.join(testRoot, "workspaces");
    const outsideRoot = path.join(testRoot, "outside");
    fs.mkdirSync(workspaceRoot, { recursive: true });
    fs.mkdirSync(outsideRoot, { recursive: true });
    fs.symlinkSync(outsideRoot, path.join(workspaceRoot, "MT-SYM"));
    writeWorkflowFile(workflowFilePath(), { workspace_root: workspaceRoot });

    const result = createForIssue("MT-SYM");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toEqual({
        tag: "workspace_outside_root",
        workspace: canonical(outsideRoot),
        root: canonical(workspaceRoot),
      });
    }
  });

  test("canonicalizes symlinked workspace roots before creating issue directories", () => {
    const actualRoot = path.join(testRoot, "actual-workspaces");
    const linkedRoot = path.join(testRoot, "linked-workspaces");
    fs.mkdirSync(actualRoot, { recursive: true });
    fs.symlinkSync(actualRoot, linkedRoot);
    writeWorkflowFile(workflowFilePath(), { workspace_root: linkedRoot });

    const result = createForIssue("MT-LINK");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toBe(canonical(path.join(actualRoot, "MT-LINK")));
      expect(fs.statSync(result.value).isDirectory()).toBe(true);
    }
  });

  test("remove rejects the workspace root itself with a distinct error", () => {
    const workspaceRoot = path.join(testRoot, "root-remove");
    fs.mkdirSync(workspaceRoot, { recursive: true });
    writeWorkflowFile(workflowFilePath(), { workspace_root: workspaceRoot });

    const canonicalRoot = canonical(workspaceRoot);
    const result = remove(workspaceRoot);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toEqual({
        tag: "workspace_equals_root",
        workspace: canonicalRoot,
        root: canonicalRoot,
      });
      expect(result.output).toBe("");
    }
  });

  test("surfaces after_create hook failures", () => {
    const workspaceRoot = path.join(testRoot, "workspaces");
    writeWorkflowFile(workflowFilePath(), {
      workspace_root: workspaceRoot,
      hook_after_create: "echo nope && exit 17",
    });

    const result = createForIssue("MT-FAIL");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const error = result.error as { tag: string; hookName: string; status: number };
      expect(error.tag).toBe("workspace_hook_failed");
      expect(error.hookName).toBe("after_create");
      expect(error.status).toBe(17);
    }
  });

  test("surfaces after_create hook timeouts", () => {
    const workspaceRoot = path.join(testRoot, "workspaces");
    writeWorkflowFile(workflowFilePath(), {
      workspace_root: workspaceRoot,
      hook_timeout_ms: 10,
      hook_after_create: "sleep 1",
    });

    const result = createForIssue("MT-TIMEOUT");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toEqual({
        tag: "workspace_hook_timeout",
        hookName: "after_create",
        timeoutMs: 10,
      });
    }
  });

  test("creates an empty directory when no bootstrap hook is configured", () => {
    const workspaceRoot = path.join(testRoot, "workspaces");
    writeWorkflowFile(workflowFilePath(), { workspace_root: workspaceRoot });

    const workspace = path.join(workspaceRoot, "MT-608");
    const result = createForIssue("MT-608");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toBe(canonical(workspace));
      expect(fs.readdirSync(result.value)).toEqual([]);
    }
  });

  test("removes all workspaces for a closed issue identifier", () => {
    const workspaceRoot = path.join(testRoot, "cleanup");
    const target = path.join(workspaceRoot, "S_1");
    const untouched = path.join(workspaceRoot, "OTHER-1");
    fs.mkdirSync(target, { recursive: true });
    fs.mkdirSync(untouched, { recursive: true });
    fs.writeFileSync(path.join(target, "marker.txt"), "stale");
    fs.writeFileSync(path.join(untouched, "marker.txt"), "keep");
    writeWorkflowFile(workflowFilePath(), { workspace_root: workspaceRoot });

    removeIssueWorkspaces("S_1");
    expect(fs.existsSync(target)).toBe(false);
    expect(fs.existsSync(untouched)).toBe(true);
  });

  test("cleanup handles a missing workspace root and ignores non-string identifiers", () => {
    const missingRoot = path.join(testRoot, "missing-workspaces");
    writeWorkflowFile(workflowFilePath(), { workspace_root: missingRoot });
    expect(() => removeIssueWorkspaces("S-2")).not.toThrow();
    expect(() => removeIssueWorkspaces(null)).not.toThrow();
  });

  test("remove returns an empty list for a missing directory", () => {
    const randomPath = path.join(testRoot, "missing");
    expect(remove(randomPath)).toEqual({ ok: true, value: [] });
  });

  test("hooks support multiline scripts and run at lifecycle boundaries", () => {
    const workspaceRoot = path.join(testRoot, "workspaces");
    const beforeRemoveMarker = path.join(testRoot, "before_remove.log");
    const afterCreateCounter = path.join(testRoot, "after_create.count");
    fs.mkdirSync(workspaceRoot, { recursive: true });

    writeWorkflowFile(workflowFilePath(), {
      workspace_root: workspaceRoot,
      hook_after_create: `echo after_create > after_create.log\necho call >> "${afterCreateCounter}"`,
      hook_before_remove: `echo before_remove > "${beforeRemoveMarker}"`,
    });

    const first = createForIssue("MT-HOOKS");
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(fs.readFileSync(path.join(first.value, "after_create.log"), "utf8")).toBe(
      "after_create\n",
    );

    createForIssue("MT-HOOKS");
    expect(fs.readFileSync(afterCreateCounter, "utf8").trim().split("\n")).toHaveLength(1);

    removeIssueWorkspaces("MT-HOOKS");
    expect(fs.readFileSync(beforeRemoveMarker, "utf8")).toBe("before_remove\n");
    expect(fs.existsSync(first.value)).toBe(false);
  });

  test("remove continues when the before_remove hook fails", () => {
    const workspaceRoot = path.join(testRoot, "workspaces");
    fs.mkdirSync(workspaceRoot, { recursive: true });
    writeWorkflowFile(workflowFilePath(), {
      workspace_root: workspaceRoot,
      hook_before_remove: "echo failure && exit 17",
    });

    const created = createForIssue("MT-HOOKS-FAIL");
    expect(created.ok).toBe(true);
    removeIssueWorkspaces("MT-HOOKS-FAIL");
    if (created.ok) {
      expect(fs.existsSync(created.value)).toBe(false);
    }
  });

  test("remove continues when the before_remove hook fails with large output", () => {
    const workspaceRoot = path.join(testRoot, "workspaces");
    fs.mkdirSync(workspaceRoot, { recursive: true });
    writeWorkflowFile(workflowFilePath(), {
      workspace_root: workspaceRoot,
      hook_before_remove: "i=0; while [ $i -lt 3000 ]; do printf a; i=$((i+1)); done; exit 17",
    });

    const created = createForIssue("MT-HOOKS-LARGE-FAIL");
    expect(created.ok).toBe(true);
    removeIssueWorkspaces("MT-HOOKS-LARGE-FAIL");
    if (created.ok) {
      expect(fs.existsSync(created.value)).toBe(false);
    }
  });
});
