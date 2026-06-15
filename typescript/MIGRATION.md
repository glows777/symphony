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
| `symphony_elixir/tracker.ex` | 46 | `symphony/tracker/tracker.ts` | core_test | green |
| `symphony_elixir/tracker/memory.ex` | 72 | `symphony/tracker/memory.ts` | core_test | green |

> **Ordering note:** `prompt_builder`, `tracker`, and `tracker/memory` are listed in
> Phase 1 but have forward dependencies (Config/Workflow for `prompt_builder`,
> Config/Linear.Adapter for `tracker`). They were ported after their dependencies
> landed and verified via the translated `core_test`/`extensions_test`.
>
> **Async deviation:** Linear.Client uses `fetch` (async) where Elixir's Req is
> blocking, so the tracker chain (Client→Adapter/Memory→Tracker) is Promise-based.
> The non-200 GraphQL log uses a JSON body rendering rather than Elixir's `inspect`
> map format; the translated test asserts behavior + key fragments (status, code).
>
> **Infra helpers added:** `src/symphony/result.ts` (`{:ok,_}/{:error,_}` →
> `Result<T,E>`) and `src/symphony/app-env.ts` (Elixir `Application` env).
>
> **Oracle replay:** `src/symphony/codex/app-server.ts` exports
> `replayTranscript(serverMessages) => Promise<unknown[]>` (Elixir Port → a
> Transport abstraction: real `Bun.spawn`/`SSH.startPort` or in-memory replay).
> Parity vs recorded Elixir Codex fixtures is pending the Elixir toolchain;
> the app_server_test cases run against real fake-codex subprocesses.

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
| `symphony_elixir/linear/adapter.ex` | 91 | `symphony/linear/adapter.ts` | core_test | green |
| `symphony_elixir/linear/client.ex` | 586 | `symphony/linear/client.ts` | core_test | green |
| `symphony_elixir/ssh.ex` | 100 | `symphony/ssh.ts` | ssh_test | green |
| `symphony_elixir/workspace.ex` | 483 | `symphony/workspace.ts` | workspace_and_config_test | green |
| `symphony_elixir/codex/dynamic_tool.ex` | 209 | `symphony/codex/dynamic-tool.ts` | dynamic_tool_test | green |
| `symphony_elixir/codex/app_server.ex` | 1098 | `symphony/codex/app-server.ts` | app_server_test | green |

### Phase 4 — Stateful core

| Elixir module | LOC | → TS | Test source | Status |
|---|---:|---|---|---|
| `symphony_elixir/agent_runner.ex` | 215 | `symphony/agent-runner.ts` | core_test | green |
| `symphony_elixir/orchestrator.ex` | 1951 | `symphony/orchestrator.ts` | orchestrator_status_test, core_test | green |
| `symphony_elixir/status_dashboard.ex` | 1952 | `symphony/status-dashboard.ts` | status_dashboard_snapshot_test | green |

> Dashboard reuses `../elixir/test/fixtures/status_dashboard_snapshots/*` golden files unchanged.
>
> **Orchestrator GenServer:** ported as a class holding `State` + a promise-chained
> serialized mailbox (`cast`/`call`), per the OTP→TS rulebook. `Process.send_after`
> → tracked `setTimeout` (cleared by `stop()`); `make_ref()` tokens → `Symbol`;
> `:sys.get_state`/`:sys.replace_state` → `getState`/`replaceState` seams;
> `handle_call(:request_refresh)` + `handle_info({:tick, _})` are also exposed as
> pure `*ForTest` seams for the coalescing case. Async handlers commit state only
> when they resolve, so reconcile/dispatch awaits stay inside one mailbox turn.
> `notify_dashboard` calls `StatusDashboard.notifyUpdate()`, which fans out to a
> live dashboard registered via `registerLiveDashboard` (no-op until Phase 5/6).
> The codex-update envelope reads the TS app-server's camelCase top-level fields
> (`event`/`sessionId`/`codexAppServerPid`/`usage`) while nested `payload` stays
> string-keyed JSON off the wire. Test-isolation fix: `teardownWorkflow` now clears
> the injected `linear_client_module` app-env so the live poll loop sees the real
> (offline-erroring) Linear client.

### Phase 5 — Web (SSR + SSE)

| Elixir module | LOC | → TS | Test source | Status |
|---|---:|---|---|---|
| `symphony_elixir_web/observability_pubsub.ex` | 25 | `web/observability-pubsub.ts` | observability_pubsub_test | green |
| `symphony_elixir/http_server.ex` + `web/endpoint.ex` + `web/router.ex` | 162 | `web/server.ts` | server_test (from extensions_test) | green |
| `web/controllers/observability_api_controller.ex` | 63 | `web/server.ts` (router) | server_test (from extensions_test) | green |
| `web/static_assets.ex` + `web/controllers/static_asset_controller.ex` | 87 | `web/static-assets.ts` | static_assets_test (from extensions_test) | green |
| `web/presenter.ex` | 242 | `web/presenter.ts` | presenter_test (from extensions_test) | green |
| `web/live/dashboard_live.ex` + `web/components/layouts.ex` | 507 | `web/dashboard.ts` (SSR+SSE) | dashboard_test (from extensions_test) | green |

> **Web layer (`web/`):** Phoenix endpoint/router/Bandit → `Bun.serve` + a small
> router (`web/server.ts`); the JSON `/api/v1/*` API ports literally (status codes,
> 405/404, timeout/unavailable). `Phoenix.PubSub` → a typed in-process emitter.
> Per the locked decision, Phoenix LiveView → **server-rendered HTML + SSE**:
> `GET /` renders the dashboard from the Presenter payload and `GET /events`
> streams a re-rendered section on each `ObservabilityPubSub` broadcast (a tiny
> inline `EventSource` client swaps it in). The vendored Phoenix JS assets
> (`phoenix.js`/`phoenix_live_view.js`/`phoenix_html.js`) are intentionally
> dropped — the SSE design needs none — so only `dashboard.css` + `favicon.png`
> are embedded. The Elixir tests' LiveView-specific assertions (phx-connected,
> vendored JS, `live/3` mounting) are re-expressed as SSR-output + SSE-stream
> assertions; everything else is translated literally.

### Phase 6 — CLI & tooling

| Elixir module | LOC | → TS | Test source | Status |
|---|---:|---|---|---|
| `symphony_elixir/cli.ex` | 191 | `src/cli.ts` | cli_test | green |
| `mix/tasks/specs.check.ex` | 53 | `src/tasks/specs-check.ts` | specs_check_task_test | n/a (Elixir-only) |
| `mix/tasks/pr_body.check.ex` | 216 | `src/tasks/pr-body-check.ts` | pr_body_check_test | green |
| `mix/tasks/workspace.before_remove.ex` | 140 | `src/tasks/workspace-before-remove.ts` | workspace_before_remove_test | green |
| `symphony_elixir.ex` (Application/Supervisor) | 47 | `src/app.ts` | — | ported |

> **CLI + app supervisor:** `cli.ex` ports literally with the same dependency-
> injection seam (`evaluate(args, deps)`), so `cli_test` translates 1:1. The OTP
> `:one_for_one` supervisor (`symphony_elixir.ex`) becomes `src/app.ts`'s
> `startApp()` async wiring (log file → live Orchestrator → HttpServer + dashboard
> SSR/SSE), with `StatusDashboard.notify_update` bridged to an observability
> broadcast. `startApp` has no dedicated ExUnit counterpart (marked `ported`).
>
> **Next steps (remaining Phase 6 + Phase 7):**
> - `mix/tasks/specs.check.ex` enforces adjacent Elixir `@spec`s on `lib/` and has
>   no TypeScript analog — marked `n/a`. (`bun run check`'s typecheck is the TS gate.)
> - `pr_body.check.ex` → `src/tasks/pr-body-check.ts`: port the PR-body validation
>   (framework-agnostic string/section checks) + translate `pr_body_check_test`.
> - `workspace.before_remove.ex` → `src/tasks/workspace-before-remove.ts`: port the
>   before-remove hook + translate `workspace_before_remove_test`.
> - `StatusDashboard.render_offline_status/0` is still unported; wire it into
>   `stopApp` once translated.
> - **Phase 7 (live e2e):** port `test/symphony_elixir/live_e2e_test.exs` +
>   `test/support/live_e2e_docker/` to `test/live-e2e.test.ts` + a Bun harness
>   (real fake-codex subprocess + bound HttpServer + memory tracker, asserting an
>   issue flows dispatch→running→completion end-to-end). Heaviest item; depends on
>   the Docker/SSH support harness being reframed for Bun.

### Phase 7 — Live e2e

| Elixir | → TS | Status |
|---|---|---|
| `test/symphony_elixir/live_e2e_test.exs` + `test/support/live_e2e_docker/` | `test/live-e2e.test.ts` + harness | todo (env-gated) |

> **Phase 7 is environment-gated.** The Elixir `live_e2e_test` is tagged
> `:live_e2e` and skipped unless `SYMPHONY_RUN_LIVE_E2E=1`; it requires Docker
> Compose worker containers, SSH, a real Linear team/project + API token, and a
> real Codex `auth.json`. None of those are available in CI / this sandbox, so a
> port cannot be verified green here. Recommended split when tackling it:
> 1. **In-process e2e (sandbox-runnable, the verifiable slice):** drive
>    `startApp()` with the memory tracker (`tracker_kind: memory`, a candidate
>    issue), `worker.ssh_hosts: []` (local dispatch), and `codex.command` pointed
>    at `test/harness/fake-codex.ts`; assert the issue flows
>    dispatch → running (via `Orchestrator.snapshot`) → completion, and that the
>    bound HttpServer's `/api/v1/state` reflects it. This reuses the existing
>    fake-codex harness and needs no Docker/Linear/Codex creds.
> 2. **Real Docker/Linear/Codex e2e:** translate `live_e2e_test.exs` to
>    `test/live-e2e.test.ts`, skipped unless `SYMPHONY_RUN_LIVE_E2E=1`, and reframe
>    `test/support/live_e2e_docker/` (Dockerfile/compose/entrypoint) for the Bun
>    worker image. Verified only in an environment with Docker + credentials.

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
