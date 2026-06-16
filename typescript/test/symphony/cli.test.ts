import { describe, expect, test } from "bun:test";
import path from "node:path";
import { type Deps, evaluate, main } from "../../src/cli.ts";
import { err, ok } from "../../src/symphony/result.ts";

// Translated from cli_test.exs. The Elixir `deps` map becomes an injected Deps
// object; `send(parent, ...)` assertions become recorded-call checks.

const ACK_FLAG = "--i-understand-that-this-will-be-running-without-the-usual-guardrails";

type Calls = {
  fileChecked: string[];
  workflowSet: string[];
  logsRoot: string[];
  portSet: number[];
  started: number;
};

function makeDeps(overrides: Partial<Deps>, calls: Calls): Deps {
  return {
    fileRegular: (filePath) => {
      calls.fileChecked.push(filePath);
      return true;
    },
    setWorkflowFilePath: (filePath) => {
      calls.workflowSet.push(filePath);
    },
    setLogsRoot: (filePath) => {
      calls.logsRoot.push(filePath);
    },
    setServerPortOverride: (port) => {
      calls.portSet.push(port);
    },
    ensureAllStarted: () => {
      calls.started += 1;
      return ok([]);
    },
    ...overrides,
  };
}

function freshCalls(): Calls {
  return { fileChecked: [], workflowSet: [], logsRoot: [], portSet: [], started: 0 };
}

describe("CLI", () => {
  test("returns the guardrails acknowledgement banner when the flag is missing", async () => {
    const calls = freshCalls();
    const result = await evaluate(["WORKFLOW.md"], makeDeps({}, calls));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain(
        "This Symphony implementation is a low key engineering preview.",
      );
      expect(result.error).toContain("Codex will run without any guardrails.");
      expect(result.error).toContain(
        "SymphonyElixir is not a supported product and is presented as-is.",
      );
      expect(result.error).toContain(ACK_FLAG);
    }
    expect(calls.fileChecked).toEqual([]);
    expect(calls.workflowSet).toEqual([]);
    expect(calls.logsRoot).toEqual([]);
    expect(calls.portSet).toEqual([]);
    expect(calls.started).toBe(0);
  });

  test("defaults to WORKFLOW.md when workflow path is missing", async () => {
    const calls = freshCalls();
    const deps = makeDeps({ fileRegular: (p) => path.basename(p) === "WORKFLOW.md" }, calls);
    expect(await evaluate([ACK_FLAG], deps)).toEqual(ok(undefined));
  });

  test("uses an explicit workflow path override when provided", async () => {
    const calls = freshCalls();
    const expanded = path.resolve("tmp/custom/WORKFLOW.md");
    const deps = makeDeps(
      {
        fileRegular: (p) => {
          calls.fileChecked.push(p);
          return p === expanded;
        },
      },
      calls,
    );
    expect(await evaluate([ACK_FLAG, "tmp/custom/WORKFLOW.md"], deps)).toEqual(ok(undefined));
    expect(calls.fileChecked).toContain(expanded);
    expect(calls.workflowSet).toEqual([expanded]);
  });

  test("accepts --logs-root and passes an expanded root", async () => {
    const calls = freshCalls();
    const result = await evaluate(
      [ACK_FLAG, "--logs-root", "tmp/custom-logs", "WORKFLOW.md"],
      makeDeps({}, calls),
    );
    expect(result).toEqual(ok(undefined));
    expect(calls.logsRoot).toEqual([path.resolve("tmp/custom-logs")]);
  });

  test("returns not found when workflow file does not exist", async () => {
    const result = await evaluate(
      [ACK_FLAG, "WORKFLOW.md"],
      makeDeps({ fileRegular: () => false }, freshCalls()),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("Workflow file not found:");
    }
  });

  test("returns startup error when app cannot start", async () => {
    const result = await evaluate(
      [ACK_FLAG, "WORKFLOW.md"],
      makeDeps({ ensureAllStarted: () => err(":boom") }, freshCalls()),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("Failed to start Symphony with workflow");
      expect(result.error).toContain(":boom");
    }
  });

  test("returns ok when workflow exists and app starts", async () => {
    expect(await evaluate([ACK_FLAG, "WORKFLOW.md"], makeDeps({}, freshCalls()))).toEqual(
      ok(undefined),
    );
  });

  test("rejects unknown flags and extra positionals with usage", async () => {
    expect((await evaluate(["--nope"], makeDeps({}, freshCalls()))).ok).toBe(false);
    const extra = await evaluate([ACK_FLAG, "a.md", "b.md"], makeDeps({}, freshCalls()));
    expect(extra.ok).toBe(false);
    if (!extra.ok) {
      expect(extra.error).toContain("Usage: symphony");
    }
  });

  describe("main", () => {
    test("blocks on shutdown after a successful start (does not exit 0 immediately)", async () => {
      const calls = freshCalls();
      let waited = false;
      let resolveWait = (): void => {};
      const wait = (): Promise<void> =>
        new Promise<void>((resolve) => {
          waited = true;
          resolveWait = resolve;
        });

      const pending = main([ACK_FLAG, "WORKFLOW.md"], makeDeps({}, calls), wait);

      // The app started, and main is now blocked in `wait` — it must not have
      // resolved (which is what would tear the server/orchestrator down).
      const settledEarly = await Promise.race([
        pending.then(() => "resolved"),
        new Promise((r) => setTimeout(() => r("pending"), 50)),
      ]);
      expect(calls.started).toBe(1);
      expect(waited).toBe(true);
      expect(settledEarly).toBe("pending");

      // A shutdown signal lets it exit cleanly with 0.
      resolveWait();
      expect(await pending).toBe(0);
    });

    test("returns 1 on the error path without waiting", async () => {
      const originalWrite = process.stderr.write.bind(process.stderr);
      let stderr = "";
      process.stderr.write = ((chunk: string) => {
        stderr += chunk;
        return true;
      }) as typeof process.stderr.write;

      try {
        const neverWait = (): Promise<void> => new Promise<void>(() => {});
        const code = await main(["WORKFLOW.md"], makeDeps({}, freshCalls()), neverWait);
        expect(code).toBe(1);
      } finally {
        process.stderr.write = originalWrite;
      }
      expect(stderr).toContain(ACK_FLAG);
    });
  });
});
