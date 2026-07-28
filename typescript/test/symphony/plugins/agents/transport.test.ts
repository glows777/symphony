import { describe, expect, test } from "bun:test";
import { ProcessTransport } from "../../../../src/symphony/plugins/agents/transport.ts";

// The line-framed transport is shared by every agent backend (codex and
// claude_code both run their protocol over it), so a decoding bug here corrupts
// protocol payloads for all of them.

function spawnEmitter(script: string): Bun.Subprocess<"pipe", "pipe", "pipe"> {
  return Bun.spawn(["bun", "-e", script], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  }) as Bun.Subprocess<"pipe", "pipe", "pipe">;
}

describe("ProcessTransport", () => {
  test("reassembles a multibyte UTF-8 sequence split across chunk boundaries", async () => {
    // "工作区" as JSON, flushed one byte at a time: every multibyte character
    // straddles a chunk boundary. A non-streaming TextDecoder turns each split
    // half into U+FFFD, so the line arrives as mojibake and JSON.parse yields
    // the wrong payload.
    const script = `
      const line = JSON.stringify({ text: "工作区 ✅ café" }) + "\\n";
      const bytes = new TextEncoder().encode(line);
      for (const b of bytes) {
        process.stdout.write(new Uint8Array([b]));
        await Bun.sleep(0);
      }
      await Bun.sleep(50);
    `;
    const transport = new ProcessTransport(spawnEmitter(script));
    try {
      const event = await transport.next(5_000);
      expect(event.type).toBe("line");
      if (event.type !== "line") {
        return;
      }
      expect(event.data).not.toContain("�");
      expect(JSON.parse(event.data)).toEqual({ text: "工作区 ✅ café" });
    } finally {
      transport.close();
    }
  });

  test("surfaces process exit", async () => {
    const transport = new ProcessTransport(spawnEmitter("process.exit(3)"));
    try {
      const event = await transport.next(5_000);
      expect(event.type).toBe("exit");
      if (event.type === "exit") {
        expect(event.status).toBe(3);
      }
    } finally {
      transport.close();
    }
  });

  test("preserves stdout and stderr as separate line sources", async () => {
    const transport = new ProcessTransport(
      spawnEmitter(`
        process.stdout.write("out-line\\n");
        process.stderr.write("err-line\\n");
        await Bun.sleep(50);
      `),
    );
    try {
      const first = await transport.next(5_000);
      const second = await transport.next(5_000);
      expect(first.type).toBe("line");
      expect(second.type).toBe("line");
      if (first.type === "line" && second.type === "line") {
        expect(new Set([first.stream, second.stream])).toEqual(new Set(["stdout", "stderr"]));
        expect(new Set([first.data, second.data])).toEqual(new Set(["out-line", "err-line"]));
      }
    } finally {
      transport.close();
    }
  });
});
