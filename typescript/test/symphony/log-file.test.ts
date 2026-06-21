import { describe, expect, test } from "bun:test";
import path from "node:path";
import { defaultLogFile } from "../../src/symphony/log-file.ts";

// Translated from log_file_test.exs.
describe("LogFile", () => {
  test("default_log_file/0 uses the current working directory", () => {
    expect(defaultLogFile()).toBe(path.join(process.cwd(), "log/symphony.log"));
  });

  test("default_log_file/1 builds the log path under a custom root", () => {
    expect(defaultLogFile("/tmp/symphony-logs")).toBe("/tmp/symphony-logs/log/symphony.log");
  });
});
