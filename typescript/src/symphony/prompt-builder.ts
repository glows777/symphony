// Literal port of `symphony_elixir/prompt_builder.ts`.
//
// Builds agent prompts from work item data. Elixir uses Solid (Liquid); the
// TS port uses liquidjs with strict variables/filters. Work item fields are
// projected back to the snake_case names the Liquid templates reference —
// the `issue.*` scope is a user contract (WORKFLOW.md templates) and never
// changes; `issue.metadata.*` exposes the plugin-private extension slot.

import { Liquid, type Template } from "liquidjs";
import { workflowPrompt } from "./config.ts";
import type { Issue } from "./plugins/work-item.ts";
import { current as workflowCurrent } from "./workflow.ts";

const engine = new Liquid({ strictVariables: true, strictFilters: true });

export function buildPrompt(issue: Issue, opts: { attempt?: number | null } = {}): string {
  const parsed = parseTemplate(promptTemplate());
  return engine.renderSync(parsed, {
    attempt: opts.attempt ?? null,
    issue: issueScope(issue),
  });
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

function inspect(value: unknown): string {
  return JSON.stringify(value);
}
