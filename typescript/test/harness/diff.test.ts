import { describe, expect, test } from "bun:test";
import { diff, formatDifferences } from "../../harness/diff.ts";

describe("diff", () => {
  test("returns no differences for structurally equal values", () => {
    expect(diff({ a: 1, b: [1, 2] }, { a: 1, b: [1, 2] })).toEqual([]);
  });

  test("detects a changed leaf with its path", () => {
    expect(diff({ counts: { running: 1 } }, { counts: { running: 2 } })).toEqual([
      { path: "counts.running", kind: "changed", expected: 1, actual: 2 },
    ]);
  });

  test("detects missing and extra object keys", () => {
    const out = diff({ a: 1 }, { b: 2 });
    expect(out).toEqual([
      { path: "a", kind: "missing", expected: 1 },
      { path: "b", kind: "extra", actual: 2 },
    ]);
  });

  test("detects array length and element differences", () => {
    const out = diff([1, 2], [1, 3, 4]);
    expect(out).toEqual([
      { path: "[1]", kind: "changed", expected: 2, actual: 3 },
      { path: "[2]", kind: "extra", actual: 4 },
    ]);
  });

  test("detects type mismatches", () => {
    expect(diff({ a: 1 }, { a: "1" })).toEqual([
      { path: "a", kind: "type", expected: 1, actual: "1" },
    ]);
  });

  test("formats differences as a readable report", () => {
    const report = formatDifferences(diff({ a: 1 }, { a: 2 }));
    expect(report).toContain("~ a: expected 1, got 2");
    expect(formatDifferences([])).toBe("no differences");
  });
});
