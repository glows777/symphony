import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { deleteEnv } from "../../src/symphony/app-env.ts";
import {
  clearWorkflowFilePath,
  current,
  load,
  setWorkflowFilePath,
  workflowFilePath,
} from "../../src/symphony/workflow.ts";

// Direct coverage for workflow.ts (Elixir parity: workflow is not in the
// ignore_modules list). The store path is covered in workflow-store.test.ts.
describe("Workflow", () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "symphony-workflow-unit-"));
  });

  afterEach(() => {
    deleteEnv("workflow_file_path");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("workflow file path defaults to WORKFLOW.md in cwd when app env is unset", () => {
    clearWorkflowFilePath();
    expect(workflowFilePath()).toBe(path.join(process.cwd(), "WORKFLOW.md"));
  });

  test("workflow file path resolves from app env when set", () => {
    setWorkflowFilePath("/tmp/app/WORKFLOW.md");
    expect(workflowFilePath()).toBe("/tmp/app/WORKFLOW.md");
  });

  test("load accepts prompt-only files without front matter", () => {
    const file = path.join(dir, "PROMPT_ONLY_WORKFLOW.md");
    fs.writeFileSync(file, "Prompt only\n");

    const result = load(file);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual({
        config: {},
        prompt: "Prompt only",
        promptTemplate: "Prompt only",
      });
    }
  });

  test("load accepts unterminated front matter with an empty prompt", () => {
    const file = path.join(dir, "UNTERMINATED_WORKFLOW.md");
    fs.writeFileSync(file, "---\ntracker:\n  kind: linear\n");

    const result = load(file);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual({
        config: { tracker: { kind: "linear" } },
        prompt: "",
        promptTemplate: "",
      });
    }
  });

  test("load splits front matter from the markdown prompt body", () => {
    const file = path.join(dir, "FULL_WORKFLOW.md");
    fs.writeFileSync(file, "---\ntracker:\n  kind: linear\n---\n\nDo the work.\n");

    const result = load(file);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.config).toEqual({ tracker: { kind: "linear" } });
      expect(result.value.prompt).toBe("Do the work.");
      expect(result.value.promptTemplate).toBe("Do the work.");
    }
  });

  test("load treats blank front matter as an empty config map", () => {
    const file = path.join(dir, "BLANK_FRONT_MATTER.md");
    fs.writeFileSync(file, "---\n\n---\nBody\n");

    const result = load(file);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.config).toEqual({});
      expect(result.value.prompt).toBe("Body");
    }
  });

  test("load rejects non-map front matter", () => {
    const file = path.join(dir, "INVALID_FRONT_MATTER_WORKFLOW.md");
    fs.writeFileSync(file, "---\n- not-a-map\n---\nPrompt body\n");

    const result = load(file);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toEqual({ tag: "workflow_front_matter_not_a_map" });
    }
  });

  test("load surfaces YAML parse errors as workflow_parse_error", () => {
    const file = path.join(dir, "BROKEN_WORKFLOW.md");
    fs.writeFileSync(file, "---\ntracker: [\n---\nBroken prompt\n");

    const result = load(file);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect((result.error as { tag: string }).tag).toBe("workflow_parse_error");
    }
  });

  test("load reports a missing file with the enoent reason", () => {
    const missing = path.join(dir, "MISSING_WORKFLOW.md");
    const result = load(missing);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toEqual({
        tag: "missing_workflow_file",
        path: missing,
        reason: "enoent",
      });
    }
  });

  test("current() loads directly when no store is running", () => {
    const file = path.join(dir, "WORKFLOW.md");
    fs.writeFileSync(file, "Prompt only\n");
    setWorkflowFilePath(file);

    const result = current();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect((result.value as { prompt: string }).prompt).toBe("Prompt only");
    }
  });
});
