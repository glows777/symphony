import { describe, expect, test } from "bun:test";
import {
  isIssue,
  isWorkItem,
  labelNames,
  newIssue,
  newWorkItem,
  routable,
} from "../../../src/symphony/plugins/work-item.ts";

// Translated from the "linear issue helpers" / "linear issue routing" tests in
// workspace_and_config_test.exs; extended for the WorkItem generalization.
describe("Plugins.WorkItem", () => {
  test("issue helpers expose labels and assignment", () => {
    const issue = newIssue({
      id: "abc",
      labels: ["frontend", "infra"],
      assignedToWorker: false,
    });

    expect(labelNames(issue)).toEqual(["frontend", "infra"]);
    expect(issue.labels).toEqual(["frontend", "infra"]);
    expect(issue.assignedToWorker).toBe(false);
  });

  test("routing requires every configured label (case/space-insensitive)", () => {
    const issue = newIssue({ labels: [" Symphony ", "JavaScript"], assignedToWorker: true });

    expect(routable(issue, [])).toBe(true);
    expect(routable(issue, ["symphony"])).toBe(true);
    expect(routable(issue, ["SYMPHONY", "javascript"])).toBe(true);
    expect(routable(issue, ["symph"])).toBe(false);
    expect(routable(issue, [" "])).toBe(false);
    expect(routable(issue, ["symphony", "security"])).toBe(false);
    expect(routable({ ...issue, assignedToWorker: false }, ["symphony"])).toBe(false);
  });

  test("defaults mirror the Elixir defstruct", () => {
    const issue = newIssue();
    expect(issue.assignedToWorker).toBe(true);
    expect(issue.labels).toEqual([]);
    expect(issue.blockedBy).toEqual([]);
    expect(issue.id).toBeNull();
    expect(issue.createdAt).toBeNull();
    expect(issue.metadata).toEqual({});
  });

  test("newWorkItem brands items and carries plugin metadata", () => {
    const item = newWorkItem({ id: "slack-1", metadata: { channel: "C123", thread_ts: "1.2" } });
    expect(isWorkItem(item)).toBe(true);
    expect(item.metadata).toEqual({ channel: "C123", thread_ts: "1.2" });

    // The legacy aliases are the same functions, not copies.
    expect(isIssue).toBe(isWorkItem);
    expect(isWorkItem({ ...item })).toBe(false);
    expect(isWorkItem({ id: "slack-1" })).toBe(false);
  });
});
