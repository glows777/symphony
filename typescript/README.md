# Symphony (TypeScript / Bun)

The reference implementation of Symphony, in TypeScript running on [Bun](https://bun.sh). It began
as a literal, module-for-module port of an Elixir reference implementation (now removed; preserved
in git history) and is the canonical implementation today. Symphony is an autonomous
agent-orchestration service: it polls a tracker (Linear) for work, creates an isolated workspace
per issue, runs Codex in app-server mode inside that workspace, and supervises the agent until the
issue is done. See [`../SPEC.md`](../SPEC.md) for the language-agnostic specification. The
tracker layer is pluggable (Linear, Lark/Feishu Bitable, Lark/Feishu task center, and an
in-memory tracker ship built in);
see [`../docs/PLUGIN_CONTRACT.md`](../docs/PLUGIN_CONTRACT.md) for the tracker plugin contract.

> [!NOTE]
> The port is complete and green. See [`MIGRATION.md`](./MIGRATION.md) for the module-by-module
> record and the OTP→TS translation rulebook.

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
bun run verify      # check + a real end-to-end smoke of the running app
```

## Testing locally

Everything here runs against this `typescript/` directory alone — **no Elixir, no
Codex account, no Linear key, and no network access** are required.

Prerequisites: **[Bun](https://bun.sh) only** (`>= 1.3`).

```bash
cd typescript
bun install         # install dependencies
bun run check       # the quality gate: typecheck + lint + test
bun run verify      # one-command, self-contained end-to-end verification
```

`bun run verify` runs `bun run check`, then boots the real application
(`src/cli.ts`) as a child process against [`examples/smoke.workflow.md`](./examples/smoke.workflow.md)
— the in-memory tracker seeded with one candidate issue, a temp-dir workspace
root, and the repo's fake Codex ([`test/harness/fake-codex.ts`](./test/harness/fake-codex.ts))
instead of a real `codex app-server`. It then:

1. polls `GET /api/v1/state` until it returns `200` and asserts the JSON shape;
2. checks `POST /api/v1/refresh` returns `202` and an unknown issue returns `404`;
3. confirms a workspace directory was created for the dispatched issue; and
4. sends `SIGTERM` and asserts the process exits `0` cleanly.

It prints a `PASS`/`FAIL` summary and exits non-zero on any failure.

### Manual smoke (`--port` + curl)

To poke the running app by hand, point the two env vars the smoke workflow uses
at a temp workspace root and the fake Codex, then boot the CLI on a port:

```bash
cd typescript
export SYMPHONY_SMOKE_WORKSPACE_ROOT="$(mktemp -d)"
export SYMPHONY_SMOKE_FAKE_CODEX="$PWD/test/harness/fake-codex.ts"

bun run src/cli.ts \
  --i-understand-that-this-will-be-running-without-the-usual-guardrails \
  --port 4000 \
  examples/smoke.workflow.md
```

In another terminal:

```bash
curl -s localhost:4000/api/v1/state | jq        # 200, snapshot JSON
curl -s -X POST localhost:4000/api/v1/refresh   # 202
curl -s -o /dev/null -w '%{http_code}\n' localhost:4000/api/v1/NOPE   # 404
ls "$SYMPHONY_SMOKE_WORKSPACE_ROOT"             # SMOKE-1 (dispatched issue workspace)
```

Stop the server with `Ctrl-C` (or `SIGTERM`); it shuts down cleanly with exit `0`.

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
