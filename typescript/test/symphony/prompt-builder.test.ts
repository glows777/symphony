import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import path from "node:path";
import { workflowPrompt } from "../../src/symphony/config.ts";
import { newIssue } from "../../src/symphony/linear/issue.ts";
import { buildPrompt } from "../../src/symphony/prompt-builder.ts";
import { setWorkflowFilePath, workflowFilePath } from "../../src/symphony/workflow.ts";
import { setupWorkflow, teardownWorkflow, writeWorkflowFile } from "../support/test-support.ts";

// Translated from the prompt-builder cases in core_test.exs.
describe("PromptBuilder.build_prompt", () => {
  let root: string;

  beforeEach(() => {
    ({ root } = setupWorkflow());
  });

  afterEach(() => {
    teardownWorkflow(root);
  });

  test("renders issue and attempt values from the workflow template", () => {
    writeWorkflowFile(workflowFilePath(), {
      prompt:
        "Ticket {{ issue.identifier }} {{ issue.title }} labels={{ issue.labels }} attempt={{ attempt }}",
    });

    const issue = newIssue({
      identifier: "S-1",
      title: "Refactor backend request path",
      description: "Replace transport layer",
      state: "Todo",
      url: "https://example.org/issues/S-1",
      labels: ["backend"],
    });

    const prompt = buildPrompt(issue, { attempt: 3 });
    expect(prompt).toContain("Ticket S-1 Refactor backend request path");
    expect(prompt).toContain("labels=backend");
    expect(prompt).toContain("attempt=3");
  });

  test("renders datetime fields without crashing", () => {
    writeWorkflowFile(workflowFilePath(), {
      prompt:
        "Ticket {{ issue.identifier }} created={{ issue.created_at }} updated={{ issue.updated_at }}",
    });

    const issue = newIssue({
      identifier: "MT-697",
      title: "Live smoke",
      labels: [],
      createdAt: new Date("2026-02-26T18:06:48Z"),
      updatedAt: new Date("2026-02-26T18:07:03Z"),
    });

    const prompt = buildPrompt(issue);
    expect(prompt).toContain("Ticket MT-697");
    expect(prompt).toContain("created=2026-02-26T18:06:48Z");
    expect(prompt).toContain("updated=2026-02-26T18:07:03Z");
  });

  test("normalizes nested date-like values, maps, and structs in issue fields", () => {
    writeWorkflowFile(workflowFilePath(), { prompt: "Ticket {{ issue.identifier }}" });

    const issue = newIssue({
      identifier: "MT-701",
      title: "Serialize nested values",
      // labels intentionally holds mixed non-string values (as in the Elixir test).
      labels: [new Date("2026-02-27T12:34:56Z"), { phase: "test" }] as unknown as string[],
    });

    expect(buildPrompt(issue)).toBe("Ticket MT-701");
  });

  test("uses strict variable rendering", () => {
    writeWorkflowFile(workflowFilePath(), {
      prompt: "Work on ticket {{ missing.ticket_id }} and follow these steps.",
    });

    const issue = newIssue({ identifier: "MT-123", title: "Investigate", labels: ["bug"] });
    expect(() => buildPrompt(issue)).toThrow();
  });

  test("surfaces invalid template content with prompt context", () => {
    writeWorkflowFile(workflowFilePath(), { prompt: "{% if issue.identifier %}" });

    const issue = newIssue({ identifier: "MT-999", title: "Broken prompt", labels: [] });
    expect(() => buildPrompt(issue)).toThrow(/template_parse_error:.*template="/s);
  });

  test("uses the default template when the workflow prompt is blank", () => {
    writeWorkflowFile(workflowFilePath(), { prompt: "   \n" });

    const issue = newIssue({
      identifier: "MT-777",
      title: "Make fallback prompt useful",
      description: "Include enough issue context to start working.",
      state: "In Progress",
      labels: ["prompt"],
    });

    const prompt = buildPrompt(issue);
    expect(prompt).toContain("You are working on a Linear issue.");
    expect(prompt).toContain("Identifier: MT-777");
    expect(prompt).toContain("Title: Make fallback prompt useful");
    expect(prompt).toContain("Body:");
    expect(prompt).toContain("Include enough issue context to start working.");
    expect(workflowPrompt()).toContain("{{ issue.identifier }}");
    expect(workflowPrompt()).toContain("{{ issue.title }}");
    expect(workflowPrompt()).toContain("{{ issue.description }}");
  });

  test("default template handles a missing issue body", () => {
    writeWorkflowFile(workflowFilePath(), { prompt: "" });

    const issue = newIssue({
      identifier: "MT-778",
      title: "Handle empty body",
      description: null,
      state: "Todo",
      labels: [],
    });

    const prompt = buildPrompt(issue);
    expect(prompt).toContain("Identifier: MT-778");
    expect(prompt).toContain("Title: Handle empty body");
    expect(prompt).toContain("No description provided.");
  });

  test("reports workflow load failures separately from template parse errors", () => {
    const missing = path.join(path.dirname(workflowFilePath()), "missing-workflow.md");
    setWorkflowFilePath(missing);

    const issue = newIssue({ identifier: "MT-780", title: "Workflow unavailable", labels: [] });
    expect(() => buildPrompt(issue)).toThrow(/workflow_unavailable:/);
  });
});
