import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { canonicalize } from "../../src/symphony/path-safety.ts";

// PathSafety has no dedicated ExUnit file; these mirror the path-safety
// behaviors exercised in `workspace_and_config_test.exs`.
describe("PathSafety.canonicalize", () => {
  let testRoot: string;

  beforeEach(() => {
    testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "symphony-path-safety-"));
  });

  afterEach(() => {
    fs.rmSync(testRoot, { recursive: true, force: true });
  });

  test("returns an existing real directory unchanged", () => {
    const dir = path.join(testRoot, "actual-workspaces");
    fs.mkdirSync(dir);

    const result = canonicalize(dir);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toBe(fs.realpathSync(dir));
    }
  });

  test("appends the remainder verbatim once a component does not exist", () => {
    const dir = path.join(testRoot, "actual-workspaces");
    fs.mkdirSync(dir);

    const missing = path.join(dir, "MT-LINK");
    const result = canonicalize(missing);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toBe(path.join(fs.realpathSync(dir), "MT-LINK"));
    }
  });

  test("canonicalizes symlinked roots before the missing leaf", () => {
    const actualRoot = path.join(testRoot, "actual-workspaces");
    const linkedRoot = path.join(testRoot, "linked-workspaces");
    fs.mkdirSync(actualRoot);
    fs.symlinkSync(actualRoot, linkedRoot);

    const result = canonicalize(path.join(linkedRoot, "MT-LINK"));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toBe(path.join(fs.realpathSync(actualRoot), "MT-LINK"));
    }
  });

  test("normalizes `.` and `..` segments via expansion", () => {
    const dir = path.join(testRoot, "actual-workspaces");
    fs.mkdirSync(dir);

    const result = canonicalize(path.join(dir, "..", "actual-workspaces", ".", "MT-1"));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toBe(path.join(fs.realpathSync(dir), "MT-1"));
    }
  });

  test("returns a path_canonicalize_failed error for invalid path segments", () => {
    const invalidSegment = "a".repeat(300);
    const target = path.join(os.tmpdir(), invalidSegment);
    const expandedPath = path.resolve(target);

    const result = canonicalize(target);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toEqual({
        tag: "path_canonicalize_failed",
        expandedPath,
        reason: "enametoolong",
      });
    }
  });
});
