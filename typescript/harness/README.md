# Differential oracle

The oracle proves the TypeScript port behaves like the Elixir reference. It works
by **recording** reference behavior from the Elixir build, then **asserting** the
TypeScript build reproduces it. Every comparison runs through a shared
normalization layer that neutralizes volatile values (timestamps, session ids,
ephemeral ports, absolute paths) so diffs reflect real behavioral differences.

```
Elixir build ──record──▶ fixtures (versioned) ──assert──▶ TypeScript build
```

## Components

| File | Role |
|---|---|
| `types.ts` | Fixture schemas (API fixtures, Codex transcripts). |
| `normalize.ts` | Shared volatile-value redaction (used by both sides). |
| `diff.ts` | Structural deep-diff with readable reports. |
| `codex-tee.ts` | Transparent MITM that records `codex app-server` stdio traffic. |
| `record-api.ts` | Captures normalized JSON-API responses from a running Symphony. |
| `assert-parity.ts` | Replays fixtures against the TS build and diffs the results. |

Fixtures are written to `test/fixtures/oracle/{api,codex}/`.

## 1. Record (against Elixir)

**JSON-API.** Start the Elixir build with an HTTP port, then record:

```bash
cd elixir
mise exec -- ./bin/symphony --i-understand-... --port 4000 ./WORKFLOW.md   # terminal 1
# terminal 2:
cd ../typescript
SYMPHONY_WORKSPACE_ROOT=~/code/workspaces bun harness/record-api.ts http://127.0.0.1:4000
```

**Codex traffic.** Point Symphony's `codex.command` at `codex-tee` so real
sessions are transcribed:

```yaml
# WORKFLOW.md
codex:
  command: "bun /abs/path/typescript/harness/codex-tee.ts -- codex app-server"
```

with `SYMPHONY_CODEX_TRANSCRIPT` set per session. Move the resulting `.jsonl`
into `test/fixtures/oracle/codex/`.

## 2. Assert (against TypeScript)

```bash
cd typescript
bun run start --port 4000 ./WORKFLOW.md     # terminal 1 (once the TS server exists)
bun harness/assert-parity.ts http://127.0.0.1:4000   # terminal 2
```

`assert-parity` reports `PASS` / `FAIL` / `SKIP` per fixture and exits non-zero
on any `FAIL`. Checks whose TS counterpart is not ported yet report `SKIP`, so
the harness is usable from Phase 1 onward.

## Codex replay contract (Phase 3)

When the TS Codex client is ported, expose a replay adapter from
`src/symphony/codex/app-server.ts`:

```ts
export async function replayTranscript(serverMessages: unknown[]): Promise<unknown[]>;
```

Given the `codex → symphony` messages from a transcript, it returns the
`symphony → codex` messages the TS client emits. `assert-parity` diffs those
against the recorded Symphony output.
