import { describe, expect, test } from "bun:test";
import { main } from "../src/cli.ts";

// Smoke test confirming the scaffold's test runner and module resolution work.
// Replaced by the real cli_test translation in Phase 6.
describe("scaffold", () => {
  test("cli stub reports not-yet-implemented", () => {
    expect(main([])).toBe(1);
  });
});
