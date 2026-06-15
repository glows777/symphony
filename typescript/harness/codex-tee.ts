#!/usr/bin/env bun
// codex-tee: a transparent man-in-the-middle wrapper around `codex app-server`.
//
// Point Symphony's `codex.command` at this script to capture the exact
// newline-delimited JSON-RPC traffic in both directions while forwarding it
// untouched. The transcript is the reference fixture replayed against the
// TypeScript Codex client in assert-parity.ts.
//
// Usage (from a WORKFLOW.md):
//   codex:
//     command: "bun /abs/path/harness/codex-tee.ts -- codex app-server"
//
// Environment:
//   SYMPHONY_CODEX_TRANSCRIPT  output JSONL path (default: ./codex-transcript.jsonl)
//
// The real command is the script arguments (Bun strips a leading `--`
// separator), or $SYMPHONY_REAL_CODEX.

import type { TranscriptEntry, TranscriptSide } from "./types.ts";

function realCommand(argv: string[]): string[] {
  const args = argv[0] === "--" ? argv.slice(1) : argv;
  if (args.length > 0) return args;
  const fromEnv = process.env.SYMPHONY_REAL_CODEX;
  if (fromEnv) return fromEnv.split(" ").filter((s) => s.length > 0);
  throw new Error(
    "codex-tee: no real command (pass `-- codex app-server` or set SYMPHONY_REAL_CODEX)",
  );
}

const transcriptPath = process.env.SYMPHONY_CODEX_TRANSCRIPT ?? "./codex-transcript.jsonl";
const cmd = realCommand(Bun.argv.slice(2));

const transcript = Bun.file(transcriptPath).writer();
let seq = 0;

function record(from: TranscriptSide, line: string): void {
  const entry: TranscriptEntry = (() => {
    try {
      return { seq: seq++, from, message: JSON.parse(line) };
    } catch {
      return { seq: seq++, from, raw: line };
    }
  })();
  transcript.write(`${JSON.stringify(entry)}\n`);
  transcript.flush();
}

const child = Bun.spawn({
  cmd,
  stdin: "pipe",
  stdout: "pipe",
  stderr: "inherit",
});

const encoder = new TextEncoder();

/**
 * Read newline-delimited lines from `source`, record each under `from`, and
 * forward the bytes (with newline) to `sink`.
 */
async function pump(
  source: ReadableStream<Uint8Array>,
  forward: (bytes: Uint8Array) => void,
  from: TranscriptSide,
): Promise<void> {
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of source) {
    buffer += decoder.decode(chunk, { stream: true });
    let newline = buffer.indexOf("\n");
    while (newline !== -1) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      record(from, line);
      forward(encoder.encode(`${line}\n`));
      newline = buffer.indexOf("\n");
    }
  }
  if (buffer.length > 0) {
    record(from, buffer);
    forward(encoder.encode(buffer));
  }
}

const symphonyToCodex = pump(
  Bun.stdin.stream(),
  (bytes) => {
    child.stdin.write(bytes);
    child.stdin.flush();
  },
  "symphony",
).then(() => child.stdin.end());

const codexToSymphony = pump(
  child.stdout,
  (bytes) => {
    process.stdout.write(bytes);
  },
  "codex",
);

await Promise.all([symphonyToCodex, codexToSymphony]);
const code = await child.exited;
await transcript.end();
process.exit(code);
