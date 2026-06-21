import { describe, expect, test } from "bun:test";
import { labelNames, newIssue, routable } from "../../../src/symphony/linear/issue.ts";

// Translated from the "linear issue helpers" / "linear issue routing" tests in
// workspace_and_config_test.exs.
describe("Linear.Issue", () => {
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
  });
});
