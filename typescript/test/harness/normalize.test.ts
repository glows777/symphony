import { describe, expect, test } from "bun:test";
import { normalize } from "../../harness/normalize.ts";

describe("normalize", () => {
  test("redacts known volatile keys", () => {
    const input = {
      generated_at: "2026-06-15T03:00:00Z",
      session_id: "abc123",
      counts: { running: 2 },
    };
    expect(normalize(input)).toEqual({
      generated_at: "<TIMESTAMP>",
      session_id: "<SESSION>",
      counts: { running: 2 },
    });
  });

  test("redacts ISO timestamps and UUIDs inside string values", () => {
    const input = {
      note: "started at 2026-06-15T03:00:00.123Z for 550e8400-e29b-41d4-a716-446655440000",
    };
    expect(normalize(input)).toEqual({
      note: "started at <TIMESTAMP> for <UUID>",
    });
  });

  test("redacts configured path prefixes", () => {
    const input = { workspace_path: "/home/user/ws/SYM-1/repo" };
    const out = normalize(input, { pathPrefixes: { "/home/user/ws": "<WORKSPACE>" } });
    expect(out).toEqual({ workspace_path: "<WORKSPACE>/SYM-1/repo" });
  });

  test("recurses through arrays and is non-mutating", () => {
    const input = { running: [{ session_id: "x", turn_count: 1 }] };
    const out = normalize(input);
    expect(out).toEqual({ running: [{ session_id: "<SESSION>", turn_count: 1 }] });
    expect(input.running[0]?.session_id).toBe("x");
  });

  test("leaves primitives and nulls untouched", () => {
    expect(normalize({ a: null, b: 3, c: true })).toEqual({ a: null, b: 3, c: true });
  });
});
