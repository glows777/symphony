# Symphony: Elixir → TypeScript/Bun Migration

Living plan and scoreboard for porting the Elixir reference implementation (`../elixir`) to
TypeScript on Bun.

## Decisions (locked)

- **Approach:** literal, module-by-module port. Each Elixir module maps to one TS module; each
  ExUnit test file is translated 1:1 to `bun test`.
- **SPEC.md role:** reference / classification guide only. The Elixir implementation is the
  behavioral source of truth.
- **Dashboard:** Phoenix LiveView → server-rendered HTML + Server-Sent Events (via `Bun.serve`).
- **Layout:** new `typescript/` dir kept side-by-side with `elixir/` until parity, then Elixir is
  deprecated.
- **Verification:** record reference fixtures from the Elixir build (JSON-API responses + Codex
  JSON-RPC stdio traffic), assert the TS build against them. Plus translated unit tests and the
  shared dashboard golden snapshots.

## OTP → TypeScript rulebook

Apply these consistently so every port is mechanical and reviewable.

| Elixir / OTP | TypeScript / Bun |
|---|---|
| `GenServer` | class holding `State` + a serialized async mailbox (promise-chained queue) so handlers run one-at-a-time |
| `handle_call` / `handle_cast` / `handle_info` | methods dispatched through the mailbox |
| `init/1` | async `start()` |
| `Process.send_after` | `setTimeout`, ref stored on state |
| `Supervisor` (`:one_for_one`) | `supervise(children)` helper that starts + restarts on crash |
| `Phoenix.PubSub` | typed `EventEmitter` |
| `Task.Supervisor` | tracked `Set<Promise>` + `AbortController` |
| `Port` (stdio JSON-RPC) | `Bun.spawn` with a line-framed reader |
| `req` (HTTP) | `fetch` |
| `solid` (Liquid) | `liquidjs` |
| `yaml_elixir` | `yaml` |
| `ecto` changeset validation | `zod` |
| Phoenix endpoint / router / Bandit | `Bun.serve` + a small router |
| Phoenix LiveView | SSR HTML + SSE |
| `{:ok, value}` / `{:error, reason}` tuples | `Result<T, E>` discriminated union (`src/symphony/result.ts`) |

## Status legend

`todo` → `wip` → `ported` (code written) → `green` (translated tests pass) → `parity` (matches
recorded Elixir fixtures / golden snapshots).

## Scoreboard

### Phase 0 — Scaffold

| Item | Status |
|---|---|
| `package.json`, `tsconfig`, `biome`, dir layout | ✅ done |
| `bun install` verified | ✅ done |
| Verification harness (fixture recorder + differ) | ✅ done |

**Harness (`harness/`):** `normalize.ts` (volatile-value redaction), `diff.ts` (structural
deep-diff), `codex-tee.ts` (records Codex stdio), `record-api.ts` (captures JSON-API fixtures),
`assert-parity.ts` (replays fixtures against the TS build, PASS/FAIL/SKIP). Utilities are unit
tested; `codex-tee` has an end-to-end integration test. See [`harness/README.md`](./harness/README.md).
Run with `bun run oracle:record-api` / `bun run oracle:assert`.

### Phase 1 — Leaf / pure modules

| Elixir module | LOC | → TS | Test source | Status |
|---|---:|---|---|---|
| `symphony_elixir/path_safety.ex` | 50 | `symphony/path-safety.ts` | (workspace_and_config_test) | green |
| `symphony_elixir/linear/issue.ex` | 58 | `symphony/linear/issue.ts` | core_test | green |
| `symphony_elixir/prompt_builder.ex` | 64 | `symphony/prompt-builder.ts` | core_test | green |
| `symphony_elixir/log_file.ex` | 80 | `symphony/log-file.ts` | log_file_test | green |
| `symphony_elixir/tracker.ex` | 46 | `symphony/tracker/tracker.ts` | core_test | todo |
| `symphony_elixir/tracker/memory.ex` | 72 | `symphony/tracker/memory.ts` | core_test | todo |

> **Ordering note:** `prompt_builder`, `tracker`, and `tracker/memory` are listed in
> Phase 1 but have forward dependencies (Config/Workflow for `prompt_builder`,
> Config/Linear.Adapter for `tracker`). They are ported after their dependencies land
> (Phase 2/3) and verified via the translated `core_test`/`extensions_test`.
>
> **Infra helpers added:** `src/symphony/result.ts` (`{:ok,_}/{:error,_}` →
> `Result<T,E>`) and `src/symphony/app-env.ts` (Elixir `Application` env).

### Phase 2 — Config & workflow

| Elixir module | LOC | → TS | Test source | Status |
|---|---:|---|---|---|
| `symphony_elixir/config/schema.ex` | 563 | `symphony/config/schema.ts` (zod) | workspace_and_config_test | green |
| `symphony_elixir/config.ex` | 154 | `symphony/config.ts` | workspace_and_config_test | green |
| `symphony_elixir/workflow.ex` | 123 | `symphony/workflow.ts` | extensions_test | green |
| `symphony_elixir/workflow_store.ex` | 153 | `symphony/workflow-store.ts` | extensions_test | green |

### Phase 3 — I/O modules

| Elixir module | LOC | → TS | Test source | Status |
|---|---:|---|---|---|
| `symphony_elixir/linear/adapter.ex` | 91 | `symphony/linear/adapter.ts` | core_test | todo |
| `symphony_elixir/linear/client.ex` | 586 | `symphony/linear/client.ts` | core_test | todo |
| `symphony_elixir/ssh.ex` | 100 | `symphony/ssh.ts` | ssh_test | todo |
| `symphony_elixir/workspace.ex` | 483 | `symphony/workspace.ts` | workspace_and_config_test | todo |
| `symphony_elixir/codex/dynamic_tool.ex` | 209 | `symphony/codex/dynamic-tool.ts` | dynamic_tool_test | todo |
| `symphony_elixir/codex/app_server.ex` | 1098 | `symphony/codex/app-server.ts` | app_server_test | todo |

### Phase 4 — Stateful core

| Elixir module | LOC | → TS | Test source | Status |
|---|---:|---|---|---|
| `symphony_elixir/agent_runner.ex` | 215 | `symphony/agent-runner.ts` | core_test | todo |
| `symphony_elixir/orchestrator.ex` | 1951 | `symphony/orchestrator.ts` | orchestrator_status_test, core_test | todo |
| `symphony_elixir/status_dashboard.ex` | 1952 | `symphony/status-dashboard.ts` | status_dashboard_snapshot_test | todo |

> Dashboard reuses `../elixir/test/fixtures/status_dashboard_snapshots/*` golden files unchanged.

### Phase 5 — Web (SSR + SSE)

| Elixir module | LOC | → TS | Test source | Status |
|---|---:|---|---|---|
| `symphony_elixir_web/observability_pubsub.ex` | 25 | `web/observability-pubsub.ts` | observability_pubsub_test | todo |
| `symphony_elixir/http_server.ex` + `web/endpoint.ex` + `web/router.ex` | 162 | `web/server.ts` | app_server_test | todo |
| `web/controllers/observability_api_controller.ex` | 63 | `web/controllers/observability-api.ts` | app_server_test | todo |
| `web/static_assets.ex` + `web/controllers/static_asset_controller.ex` | 87 | `web/static-assets.ts` | — | todo |
| `web/presenter.ex` | 242 | `web/presenter.ts` | — | todo |
| `web/live/dashboard_live.ex` + `web/components/layouts.ex` | 507 | `web/live/dashboard.ts` (SSR+SSE) | — | todo |

### Phase 6 — CLI & tooling

| Elixir module | LOC | → TS | Test source | Status |
|---|---:|---|---|---|
| `symphony_elixir/cli.ex` | 191 | `src/cli.ts` | cli_test | todo |
| `mix/tasks/specs.check.ex` | 53 | `src/tasks/specs-check.ts` | specs_check_task_test | todo |
| `mix/tasks/pr_body.check.ex` | 216 | `src/tasks/pr-body-check.ts` | pr_body_check_test | todo |
| `mix/tasks/workspace.before_remove.ex` | 140 | `src/tasks/workspace-before-remove.ts` | workspace_before_remove_test | todo |
| `symphony_elixir.ex` (Application/Supervisor) | 47 | `src/app.ts` | — | todo |

### Phase 7 — Live e2e

| Elixir | → TS | Status |
|---|---|---|
| `test/symphony_elixir/live_e2e_test.exs` + `test/support/live_e2e_docker/` | `test/live-e2e.test.ts` + harness | todo |

## Verification harness (Phase 0 deliverable)

1. **Per-module unit tests** — translated ExUnit → `bun test`, must be green before `green` status.
2. **Differential oracle** — `harness/` scripts:
   - `record-elixir.ts`: drive the Elixir build, capture JSON-API responses and Codex JSON-RPC
     stdio traffic into versioned fixtures under `test/fixtures/oracle/`.
   - `assert-parity.ts`: replay recorded inputs against the TS build, diff outputs.
3. **Golden snapshots** — reuse `../elixir/test/fixtures/status_dashboard_snapshots/*` directly.
4. **Live e2e** — Phase 7, end-to-end parity gate.

## Coverage / quality gate

Mirror the Elixir gate (`make all`: format + lint + 100% coverage + dialyzer) with
`bun run check` (typecheck + biome + `bun test --coverage`).
