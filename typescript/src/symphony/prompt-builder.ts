// Literal port of `symphony_elixir/prompt_builder.ts`.
//
// Builds agent prompts from work item data. Elixir uses Solid (Liquid); the
// TS port uses liquidjs with strict variables/filters. Work item fields are
// projected back to the snake_case names the Liquid templates reference —
// the `issue.*` scope is a user contract (WORKFLOW.md templates) and never
// changes; `issue.metadata.*` exposes the plugin-private extension slot.

import { Liquid, type Template } from "liquidjs";
import { workflowPrompt } from "./config.ts";
import type { Issue } from "./work-item.ts";
import { current as workflowCurrent } from "./workflow.ts";

const engine = new Liquid({ strictVariables: true, strictFilters: true });

export function buildPrompt(
  issue: Issue,
  opts: { attempt?: number | null; review?: boolean } = {},
): string {
  const parsed = parseTemplate(promptTemplate());
  const rendered = engine.renderSync(parsed, {
    attempt: opts.attempt ?? null,
    issue: issueScope(issue),
  });
  if (opts.review !== true) {
    return rendered;
  }
  return `${rendered.trimEnd()}\n\n${reviewAgentPrompt()}`;
}

function promptTemplate(): string {
  const workflow = workflowCurrent();
  if (!workflow.ok) {
    throw new Error(`workflow_unavailable: ${inspect(workflow.error)}`);
  }
  const prompt = workflow.value.promptTemplate;
  return prompt.trim() === "" ? workflowPrompt() : prompt;
}

function parseTemplate(prompt: string): Template[] {
  try {
    return engine.parse(prompt);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`template_parse_error: ${message} template=${JSON.stringify(prompt)}`);
  }
}

function issueScope(issue: Issue): Record<string, unknown> {
  return toSolidMap({
    id: issue.id,
    identifier: issue.identifier,
    title: issue.title,
    description: issue.description,
    priority: issue.priority,
    state: issue.state,
    branch_name: issue.branchName,
    url: issue.url,
    assignee_id: issue.assigneeId,
    blocked_by: issue.blockedBy,
    labels: issue.labels,
    assigned_to_worker: issue.assignedToWorker,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    metadata: issue.metadata,
  });
}

function toSolidMap(map: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(map)) {
    out[String(key)] = toSolidValue(value);
  }
  return out;
}

function toSolidValue(value: unknown): unknown {
  if (value instanceof Date) {
    // Mirrors DateTime/NaiveDateTime/Date/Time -> ISO 8601 (no microseconds).
    return value.toISOString().replace(/\.\d{3}Z$/, "Z");
  }
  if (Array.isArray(value)) {
    return value.map(toSolidValue);
  }
  if (value !== null && typeof value === "object") {
    return toSolidMap(value as Record<string, unknown>);
  }
  return value;
}

function reviewAgentPrompt(): string {
  return [
    "## Symphony Review Agent",
    "",
    "You are a Review Agent started because this issue just moved from `In Progress` or `Rework` to `Human Review`.",
    "Use the normal tracker tool, workspace, shell, hooks, and repository state available to this run.",
    "",
    "Review scope:",
    "",
    "- Read the Linear issue description, comments, workpad, current status, linked PRs, and relevant discussion with `linear_graphql` as needed.",
    "- Inspect the local code diff and related backend/frontend behavior directly in the workspace.",
    "- Run focused tests or browser checks when they are needed to verify the review conclusion.",
    "- Do not expect or create a review handoff file. No GitHub review context is injected by Symphony.",
    "",
    "Review decision:",
    "",
    "- Verify both the issue's acceptance criteria and the implementation. An unmet acceptance criterion or any actionable defect that requires code or test changes means the task needs rework; style preferences and optional improvements do not.",
    "- If the task is incomplete or has an actionable defect, use the configured tracker tool to write a concise Chinese review conclusion and concrete findings on the Linear issue, then update the issue state to `Rework`. `Rework` is the only return state for problems.",
    "- If no rework is needed, use the configured tracker tool to write the review conclusion on the Linear issue and leave the issue in `Human Review` for the normal human approval path.",
    "- Do not finish with only a chat summary: the review is incomplete until the required Linear comment and, when applicable, the successful `Rework` state update have been performed. If a write fails, retry or report the write failure instead of claiming the review is complete.",
    "- This Review Agent is explicitly authorized to write the review conclusion and change the issue to `Rework`; read-only code-review guidance does not override these required tracker actions.",
  ].join("\n");
}

function inspect(value: unknown): string {
  return JSON.stringify(value);
}
