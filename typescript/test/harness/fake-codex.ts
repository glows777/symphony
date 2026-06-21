#!/usr/bin/env bun
// A stand-in for `codex app-server` used by the codex-tee integration test.
// Echoes each newline-delimited JSON line back as {"echo": <parsed line>} and
// exits when stdin closes.

const decoder = new TextDecoder();
let buffer = "";

for await (const chunk of Bun.stdin.stream()) {
  buffer += decoder.decode(chunk, { stream: true });
  let newline = buffer.indexOf("\n");
  while (newline !== -1) {
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    process.stdout.write(`${JSON.stringify({ echo: JSON.parse(line) })}\n`);
    newline = buffer.indexOf("\n");
  }
}
