import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { WorkflowStore, getRunningStore } from "../../src/symphony/workflow-store.ts";
import { current, setWorkflowFilePath, workflowFilePath } from "../../src/symphony/workflow.ts";
import { setupWorkflow, teardownWorkflow, writeWorkflowFile } from "../support/test-support.ts";

function loadedPrompt(result: ReturnType<typeof current>): string | null {
  if (result.ok) {
    return (result.value as { prompt: string }).prompt;
  }
  return null;
}

// Translated from the workflow-store cases in extensions_test.exs.
describe("WorkflowStore", () => {
  let root: string;

  beforeEach(() => {
    ({ root } = setupWorkflow());
  });

  afterEach(() => {
    getRunningStore()?.stop();
    teardownWorkflow(root);
  });

  test("reloads changes, keeps last good workflow, and falls back when stopped", () => {
    const started = WorkflowStore.startLink();
    expect(started.ok).toBe(true);
    expect(loadedPrompt(current())).toBe("You are an agent for this repository.");

    writeWorkflowFile(workflowFilePath(), { prompt: "Second prompt" });
    getRunningStore()?.poll();
    expect(loadedPrompt(current())).toBe("Second prompt");

    fs.writeFileSync(workflowFilePath(), "---\ntracker: [\n---\nBroken prompt\n");
    expect(WorkflowStore.forceReload().ok).toBe(false);
    expect(loadedPrompt(current())).toBe("Second prompt");

    const thirdWorkflow = path.join(path.dirname(workflowFilePath()), "THIRD_WORKFLOW.md");
    writeWorkflowFile(thirdWorkflow, { prompt: "Third prompt" });
    setWorkflowFilePath(thirdWorkflow);
    expect(loadedPrompt(current())).toBe("Third prompt");

    getRunningStore()?.stop();
    // With the store stopped, current() falls back to a direct load.
    expect(loadedPrompt(current())).toBe("Third prompt");
    expect(WorkflowStore.forceReload().ok).toBe(true);
  });

  test("init stops on missing workflow file", () => {
    const missingPath = path.join(path.dirname(workflowFilePath()), "MISSING_WORKFLOW.md");
    setWorkflowFilePath(missingPath);

    const result = WorkflowStore.init();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toEqual({
        tag: "missing_workflow_file",
        path: missingPath,
        reason: "enoent",
      });
    }
  });

  test("poll callback covers missing-file and broken-file error paths", () => {
    const existingPath = workflowFilePath();
    const manualPath = path.join(path.dirname(existingPath), "MANUAL_WORKFLOW.md");
    const missingPath = path.join(path.dirname(existingPath), "MANUAL_MISSING_WORKFLOW.md");

    setWorkflowFilePath(missingPath);
    const reload = WorkflowStore.forceReload();
    expect(reload.ok).toBe(false);
    if (!reload.ok) {
      expect(reload.error).toEqual({
        tag: "missing_workflow_file",
        path: missingPath,
        reason: "enoent",
      });
    }

    writeWorkflowFile(manualPath, { prompt: "Manual workflow prompt" });
    setWorkflowFilePath(manualPath);

    const started = WorkflowStore.startLink();
    expect(started.ok).toBe(true);
    if (!started.ok) {
      return;
    }
    const store = started.value;

    let state = store.getState();
    fs.writeFileSync(manualPath, "---\ntracker: [\n---\nBroken prompt\n");
    state = store.handlePoll(state);
    expect(state.workflow.prompt).toBe("Manual workflow prompt");
    expect(state.stamp).not.toBeNull();

    setWorkflowFilePath(missingPath);
    state = store.handlePoll(state);
    expect(state.workflow.prompt).toBe("Manual workflow prompt");

    setWorkflowFilePath(manualPath);
    fs.rmSync(manualPath);
    state = store.handlePoll(state);
    expect(state.workflow.prompt).toBe("Manual workflow prompt");

    store.stop();
    setWorkflowFilePath(existingPath);
  });
});
