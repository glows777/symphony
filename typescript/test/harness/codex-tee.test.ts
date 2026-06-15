import { describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TranscriptEntry } from "../../harness/types.ts";

const TEE = join(import.meta.dir, "..", "..", "harness", "codex-tee.ts");
const FAKE_CODEX = join(import.meta.dir, "fake-codex.ts");

describe("codex-tee", () => {
  test("forwards both directions and records the transcript", async () => {
    const transcriptPath = join(tmpdir(), `codex-tee-${crypto.randomUUID()}.jsonl`);

    const proc = Bun.spawn({
      cmd: ["bun", TEE, "--", "bun", FAKE_CODEX],
      stdin: "pipe",
      stdout: "pipe",
      stderr: "inherit",
      env: { ...process.env, SYMPHONY_CODEX_TRANSCRIPT: transcriptPath },
    });

    proc.stdin.write('{"method":"ping","id":1}\n');
    await proc.stdin.end();

    const stdout = await new Response(proc.stdout).text();
    await proc.exited;

    // The fake codex echoes our message straight back to Symphony's stdout.
    expect(stdout.trim()).toBe('{"echo":{"method":"ping","id":1}}');

    const entries = (await Bun.file(transcriptPath).text())
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as TranscriptEntry);

    const symphony = entries.find((e) => e.from === "symphony");
    const codex = entries.find((e) => e.from === "codex");
    expect(symphony?.message).toEqual({ method: "ping", id: 1 });
    expect(codex?.message).toEqual({ echo: { method: "ping", id: 1 } });

    await Bun.file(transcriptPath).delete();
  });
});
