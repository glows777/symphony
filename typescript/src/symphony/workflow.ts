// Literal port of `symphony_elixir/workflow.ex`.
//
// Loads workflow configuration and prompt from WORKFLOW.md (YAML front matter +
// markdown prompt body). When the WorkflowStore process is running, reads go
// through its cache; otherwise the file is loaded directly.

import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { deleteEnv, fetchEnv, putEnv } from "./app-env.ts";
import type { JsonMap } from "./config/schema.ts";
import { type Result, err, ok } from "./result.ts";
import { getRunningStore } from "./workflow-store.ts";

const WORKFLOW_FILE_NAME = "WORKFLOW.md";

export type LoadedWorkflow = {
  config: JsonMap;
  prompt: string;
  promptTemplate: string;
};

export function workflowFilePath(): string {
  return fetchEnv<string>("workflow_file_path") ?? path.join(process.cwd(), WORKFLOW_FILE_NAME);
}

export function setWorkflowFilePath(p: string): void {
  putEnv("workflow_file_path", p);
  maybeReloadStore();
}

export function clearWorkflowFilePath(): void {
  deleteEnv("workflow_file_path");
  maybeReloadStore();
}

export function current(): Result<LoadedWorkflow, unknown> {
  const store = getRunningStore();
  return store ? store.current() : load();
}

export function load(p: string = workflowFilePath()): Result<LoadedWorkflow, unknown> {
  let content: string;
  try {
    content = fs.readFileSync(p, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return err({
      tag: "missing_workflow_file",
      path: p,
      reason: code ? code.toLowerCase() : "unknown",
    });
  }
  return parse(content);
}

function parse(content: string): Result<LoadedWorkflow, unknown> {
  const { frontMatterLines, promptLines } = splitFrontMatter(content);

  const frontMatter = frontMatterYamlToMap(frontMatterLines);
  if (!frontMatter.ok) {
    return frontMatter;
  }

  const prompt = promptLines.join("\n").trim();
  return ok({ config: frontMatter.value, prompt, promptTemplate: prompt });
}

function splitFrontMatter(content: string): { frontMatterLines: string[]; promptLines: string[] } {
  const lines = content.split(/\r\n|\r|\n/);

  if (lines[0] !== "---") {
    return { frontMatterLines: [], promptLines: lines };
  }

  const tail = lines.slice(1);
  const closingIndex = tail.indexOf("---");
  if (closingIndex === -1) {
    return { frontMatterLines: tail, promptLines: [] };
  }
  return {
    frontMatterLines: tail.slice(0, closingIndex),
    promptLines: tail.slice(closingIndex + 1),
  };
}

function frontMatterYamlToMap(lines: string[]): Result<JsonMap, unknown> {
  const yaml = lines.join("\n");

  if (yaml.trim() === "") {
    return ok({});
  }

  let decoded: unknown;
  try {
    decoded = YAML.parse(yaml);
  } catch (error) {
    return err({ tag: "workflow_parse_error", reason: error });
  }

  if (isPlainMap(decoded)) {
    return ok(decoded);
  }
  return err({ tag: "workflow_front_matter_not_a_map" });
}

function isPlainMap(value: unknown): value is JsonMap {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function maybeReloadStore(): void {
  const store = getRunningStore();
  if (store) {
    store.forceReload();
  }
}
