# Symphony (TypeScript / Bun)

A literal port of the Elixir reference implementation in [`../elixir`](../elixir) to TypeScript
running on [Bun](https://bun.sh). Symphony is an autonomous agent-orchestration service: it polls a
tracker (Linear) for work, creates an isolated workspace per issue, runs Codex in app-server mode
inside that workspace, and supervises the agent until the issue is done. See [`../SPEC.md`](../SPEC.md)
for the language-agnostic specification (used here as a reference/classification guide only — the
Elixir implementation is the source of truth for behavior).

> [!WARNING]
> This port is in progress. See [`MIGRATION.md`](./MIGRATION.md) for the current status of each module.

## Requirements

- [Bun](https://bun.sh) `>= 1.3`

## Setup

```bash
cd typescript
bun install
```

## Common commands

```bash
bun test            # run the test suite (translated from ExUnit)
bun run typecheck   # tsc --strict, no emit
bun run lint        # biome check
bun run check       # typecheck + lint + test (the quality gate)
```

## Layout

`src/` mirrors the Elixir `lib/` tree so the port stays reviewable module-for-module:

| Elixir | TypeScript |
|---|---|
| `lib/symphony_elixir/` | `src/symphony/` |
| `lib/symphony_elixir_web/` | `src/web/` |
| `lib/mix/tasks/` | `src/tasks/` |
| `test/` | `test/` |

The web dashboard (Phoenix LiveView in Elixir) is reimplemented as server-rendered HTML with
Server-Sent Events for live updates.

See [`MIGRATION.md`](./MIGRATION.md) for the porting plan, OTP→TS translation rulebook, and the
verification harness.
