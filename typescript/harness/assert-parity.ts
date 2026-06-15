#!/usr/bin/env bun
// assert-parity: replay recorded fixtures against the *TypeScript* build and
// diff the results against the Elixir reference.
//
//   API fixtures    — replayed over HTTP against a running TS server.
//   Codex transcript — replayed against the TS Codex client adapter, asserting
//                      the TS client emits the same symphony->codex messages.
//
// Usage:
//   bun harness/assert-parity.ts [baseUrl]
//
// Environment:
//   SYMPHONY_BASE_URL        base URL of the running TS server (default http://127.0.0.1:4000)
//   SYMPHONY_WORKSPACE_ROOT  workspace root, redacted before diffing
//
// Until a TS module exists for a given check, that check reports SKIP rather
// than failing — so the harness is usable from Phase 1 onward.

import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { diff, formatDifferences } from "./diff.ts";
import { type NormalizeOptions, normalize } from "./normalize.ts";
import type { ApiFixture, CodexTranscript, TranscriptEntry } from "./types.ts";

const FIXTURES = join(import.meta.dir, "..", "test", "fixtures", "oracle");
type Status = "PASS" | "FAIL" | "SKIP";
const results: { name: string; status: Status; detail?: string }[] = [];

function record(name: string, status: Status, detail?: string): void {
  results.push(detail === undefined ? { name, status } : { name, status, detail });
}

function normalizeOptions(): NormalizeOptions {
  const root = process.env.SYMPHONY_WORKSPACE_ROOT;
  return root ? { pathPrefixes: { [root]: "<WORKSPACE>" } } : {};
}

async function loadJsonFiles<T>(dir: string): Promise<T[]> {
  let names: string[];
  try {
    names = (await readdir(dir)).filter((n) => n.endsWith(".json") || n.endsWith(".jsonl"));
  } catch {
    return [];
  }
  const out: T[] = [];
  for (const name of names) {
    out.push((await Bun.file(join(dir, name)).json()) as T);
  }
  return out;
}

async function serverReachable(baseUrl: string): Promise<boolean> {
  try {
    await fetch(new URL("/api/v1/state", baseUrl), { signal: AbortSignal.timeout(2000) });
    return true;
  } catch {
    return false;
  }
}

async function assertApi(baseUrl: string, options: NormalizeOptions): Promise<void> {
  const fixtures = await loadJsonFiles<ApiFixture>(join(FIXTURES, "api"));
  if (fixtures.length === 0) {
    record("api", "SKIP", "no recorded fixtures (run record-api.ts against Elixir)");
    return;
  }
  if (!(await serverReachable(baseUrl))) {
    record("api", "SKIP", `no TS server reachable at ${baseUrl}`);
    return;
  }
  for (const fixture of fixtures) {
    const res = await fetch(new URL(fixture.request.path, baseUrl), {
      method: fixture.request.method,
    });
    const text = await res.text();
    let body: unknown;
    try {
      body = normalize(JSON.parse(text), options);
    } catch {
      body = text;
    }
    const differences = [
      ...(res.status === fixture.response.status
        ? []
        : diff({ status: fixture.response.status }, { status: res.status }, "status")),
      ...diff(fixture.response.body, body, "body"),
    ];
    record(
      `api/${fixture.name}`,
      differences.length === 0 ? "PASS" : "FAIL",
      differences.length === 0 ? undefined : formatDifferences(differences),
    );
  }
}

/** Contract for the TS Codex client replay adapter, wired up in Phase 3. */
interface CodexReplayAdapter {
  replayTranscript(serverMessages: unknown[]): Promise<unknown[]>;
}

async function loadCodexAdapter(): Promise<CodexReplayAdapter | null> {
  try {
    const mod = (await import(
      "../src/symphony/codex/app-server.ts"
    )) as Partial<CodexReplayAdapter>;
    return typeof mod.replayTranscript === "function" ? (mod as CodexReplayAdapter) : null;
  } catch {
    return null;
  }
}

async function loadTranscripts(): Promise<CodexTranscript[]> {
  const dir = join(FIXTURES, "codex");
  let names: string[];
  try {
    names = (await readdir(dir)).filter((n) => n.endsWith(".jsonl"));
  } catch {
    return [];
  }
  const out: CodexTranscript[] = [];
  for (const name of names) {
    const text = await Bun.file(join(dir, name)).text();
    const entries = text
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as TranscriptEntry);
    out.push({ name: name.replace(/\.jsonl$/, ""), entries });
  }
  return out;
}

async function assertCodex(options: NormalizeOptions): Promise<void> {
  const transcripts = await loadTranscripts();
  if (transcripts.length === 0) {
    record("codex", "SKIP", "no recorded transcripts (run via codex-tee)");
    return;
  }
  const adapter = await loadCodexAdapter();
  if (adapter === null) {
    record("codex", "SKIP", "TS Codex client not ported yet (Phase 3)");
    return;
  }
  for (const transcript of transcripts) {
    const fromCodex = transcript.entries
      .filter((e) => e.from === "codex" && e.message !== undefined)
      .map((e) => e.message);
    const expected = transcript.entries
      .filter((e) => e.from === "symphony" && e.message !== undefined)
      .map((e) => normalize(e.message, options));
    const actual = (await adapter.replayTranscript(fromCodex)).map((m) => normalize(m, options));
    const differences = diff(expected, actual);
    record(
      `codex/${transcript.name}`,
      differences.length === 0 ? "PASS" : "FAIL",
      differences.length === 0 ? undefined : formatDifferences(differences),
    );
  }
}

async function main(): Promise<number> {
  const baseUrl = Bun.argv[2] ?? process.env.SYMPHONY_BASE_URL ?? "http://127.0.0.1:4000";
  const options = normalizeOptions();

  await assertApi(baseUrl, options);
  await assertCodex(options);

  for (const r of results) {
    console.log(`${r.status.padEnd(4)} ${r.name}${r.detail ? `\n${r.detail}` : ""}`);
  }
  const failed = results.filter((r) => r.status === "FAIL").length;
  const passed = results.filter((r) => r.status === "PASS").length;
  const skipped = results.filter((r) => r.status === "SKIP").length;
  console.log(`\n${passed} passed, ${failed} failed, ${skipped} skipped`);
  return failed === 0 ? 0 : 1;
}

if (import.meta.main) {
  process.exit(await main());
}
