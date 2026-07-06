// Normalized work item representation used by the orchestrator. Originally
// ported from `symphony_elixir/linear/issue.ex` as the Linear-specific Issue
// struct; generalized for the tracker plugin architecture (see MIGRATION.md ->
// Post-cutover divergence). Elixir struct fields (snake_case) are mapped to
// idiomatic camelCase here; the snake_case shape is reconstructed at
// serialization boundaries (Liquid template vars, JSON-API) to preserve
// parity — those wire names (including the `issue` template scope) are a user
// contract and never change.
//
// Field notes for plugin authors: `id`, `identifier`, `title`, and `state`
// are required by the scheduling core (see SPEC §4.1.1 / §11.1); everything
// else degrades gracefully when absent. `metadata` is the plugin-private
// extension slot (e.g. a chat channel/thread id) — core code never reads it,
// but prompt templates can via `issue.metadata.*`.

import type { JsonMap } from "../config/schema.ts";

export type Blocker = {
  id: string | null;
  identifier: string | null;
  state: string | null;
};

export type WorkItem = {
  id: string | null;
  identifier: string | null;
  title: string | null;
  description: string | null;
  priority: number | null;
  state: string | null;
  branchName: string | null;
  url: string | null;
  assigneeId: string | null;
  blockedBy: Blocker[];
  labels: string[];
  assignedToWorker: boolean;
  createdAt: Date | null;
  updatedAt: Date | null;
  metadata: JsonMap;
};

// Brands objects created via `newWorkItem` so the memory tracker can
// distinguish real work items from arbitrary maps (mirrors Elixir's nominal
// `%Issue{}` match). A WeakSet keeps the brand out of the serialized data
// shape. Every plugin's normalize path must construct items through
// `newWorkItem` so the brand is applied.
const workItemRegistry = new WeakSet<object>();

// Mirrors the Elixir `defstruct` defaults.
export function newWorkItem(attrs: Partial<WorkItem> = {}): WorkItem {
  const item: WorkItem = {
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
    metadata: {},
    ...attrs,
  };
  workItemRegistry.add(item);
  return item;
}

export function isWorkItem(value: unknown): value is WorkItem {
  return typeof value === "object" && value !== null && workItemRegistry.has(value);
}

export function labelNames(item: WorkItem): string[] {
  return item.labels;
}

export function routable(item: WorkItem, requiredLabels: string[]): boolean {
  if (!item.assignedToWorker) {
    return false;
  }
  const itemLabels = new Set(item.labels.map(normalizeLabel));
  return requiredLabels.every((label) => itemLabels.has(normalizeLabel(label)));
}

function normalizeLabel(label: string): string {
  return label.trim().toLowerCase();
}

// ---- compatibility aliases ---------------------------------------------------
// `Issue` is the historical name (and remains the wire format: Liquid scope,
// JSON-API field prefixes, snapshots). Existing core code keeps using it;
// plugin-facing code prefers `WorkItem`.

export type Issue = WorkItem;
export const newIssue = newWorkItem;
export const isIssue = isWorkItem;
