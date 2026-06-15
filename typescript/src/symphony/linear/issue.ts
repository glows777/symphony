// Literal port of `symphony_elixir/linear/issue.ex`.
//
// Normalized Linear issue representation used by the orchestrator. Elixir struct
// fields (snake_case) are mapped to idiomatic camelCase here; the snake_case
// shape is reconstructed at serialization boundaries (Liquid template vars,
// JSON-API) to preserve parity. See MIGRATION.md.

export type Issue = {
  id: string | null;
  identifier: string | null;
  title: string | null;
  description: string | null;
  priority: number | null;
  state: string | null;
  branchName: string | null;
  url: string | null;
  assigneeId: string | null;
  blockedBy: string[];
  labels: string[];
  assignedToWorker: boolean;
  createdAt: Date | null;
  updatedAt: Date | null;
};

// Mirrors the Elixir `defstruct` defaults.
export function newIssue(attrs: Partial<Issue> = {}): Issue {
  return {
    id: null,
    identifier: null,
    title: null,
    description: null,
    priority: null,
    state: null,
    branchName: null,
    url: null,
    assigneeId: null,
    blockedBy: [],
    labels: [],
    assignedToWorker: true,
    createdAt: null,
    updatedAt: null,
    ...attrs,
  };
}

export function labelNames(issue: Issue): string[] {
  return issue.labels;
}

export function routable(issue: Issue, requiredLabels: string[]): boolean {
  if (!issue.assignedToWorker) {
    return false;
  }
  const issueLabels = new Set(issue.labels.map(normalizeLabel));
  return requiredLabels.every((label) => issueLabels.has(normalizeLabel(label)));
}

function normalizeLabel(label: string): string {
  return label.trim().toLowerCase();
}
