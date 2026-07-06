# Symphony: Elixir → TypeScript/Bun Migration

Plan and scoreboard for porting the Elixir reference implementation to TypeScript on Bun.

> **Status: migration complete.** Every module is `green`, `bun run check` (typecheck + biome +
> 227 tests) and `bun run verify` (self-contained end-to-end smoke) pass, and the real
> Linear/Codex live e2e is ported (`test/live-e2e-real.test.ts`, env-gated). The cutover is done:
> `typescript/` is the canonical implementation, the Elixir tree has been removed (preserved in
> git history), and the dashboard golden snapshots now live in
> `test/fixtures/status_dashboard_snapshots/`. The Elixir references below are retained as the
> historical record of what each module was ported from.

## Decisions (locked)

- **Approach:** literal, module-by-module port. Each Elixir module maps to one TS module; each
  ExUnit test file is translated 1:1 to `bun test`.
- **SPEC.md role:** reference / classification guide only. The Elixir implementation is the
  behavioral source of truth.
- **Dashboard:** Phoenix LiveView → server-rendered HTML + Server-Sent Events (via `Bun.serve`).
- **Layout:** `typescript/` was kept side-by-side with `elixir/` until parity; at cutover the
  Elixir tree was removed and `typescript/` became the project root (history retains Elixir).
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

> Dashboard reuses the `status_dashboard_snapshots/*` golden files unchanged (copied at cutover
> from the Elixir tree to `test/fixtures/status_dashboard_snapshots/`).
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
> - **Phase 7 (live e2e):** done. The sandbox-runnable in-process slice is
>   `test/live-e2e.test.ts`; the real Docker/Linear/Codex e2e is
>   `test/live-e2e-real.test.ts` (env-gated on `SYMPHONY_RUN_LIVE_E2E=1`) with the
>   Docker/SSH support harness under `test/support/live_e2e_docker/`. See the
>   "Phase 7 — Live e2e" section below.

### Phase 7 — Live e2e

| Elixir | → TS | Status |
|---|---|---|
| (in-process e2e — sandbox-runnable slice) | `test/live-e2e.test.ts` | green |
| `test/symphony_elixir/live_e2e_test.exs` | `test/live-e2e-real.test.ts` | green (env-gated, `SYMPHONY_RUN_LIVE_E2E=1`) |
| `test/support/live_e2e_docker/` (Dockerfile/compose/entrypoint/sshd conf) | `test/support/live_e2e_docker/` | ported (verbatim; provider-agnostic SSH+codex worker) |

> **Phase 7 is split.** The sandbox-runnable **in-process e2e is green**:
> `test/live-e2e.test.ts` drives the real `startApp()` wiring (Orchestrator +
> AgentRunner + Codex AppServer + HttpServer) against the memory tracker and a
> fake-codex subprocess with local dispatch, asserting a candidate issue flows
> dispatch → codex turn → completion, that the agent created the workspace, and
> that the bound `/api/v1/state` answers.
>
> The **real Docker/Linear/Codex e2e** is now ported to
> `test/live-e2e-real.test.ts` — a literal port of `live_e2e_test.exs` that
> provisions a disposable Linear team→project→issue via GraphQL (`projectCreate`/
> `issueCreate`), writes a temp `WORKFLOW.md`, drives one real `codex app-server`
> run through `AgentRunner.run` that must comment on and close the issue, asserts
> the `LIVE_E2E_RESULT.txt`/comment/terminal-state outcomes, then marks the
> project complete. It runs both scenarios (local worker + SSH workers). When
> `SYMPHONY_LIVE_SSH_WORKER_HOSTS` is unset the SSH scenario spins up the two
> disposable Docker workers from `test/support/live_e2e_docker/` (copied verbatim
> from Elixir — the image is provider-agnostic: `node:20` + `@openai/codex` +
> `sshd`, with `~/.codex/auth.json` mounted in). It is **guarded with
> `test.skipIf` and skips unless `SYMPHONY_RUN_LIVE_E2E === "1"`**, so the default
> `bun test` / `bun run check` runs it as 2 skipped tests with no Linear key, no
> Docker, and no network. Run instructions: HANDOFF.md → "Real live e2e".
>
> Adaptation note: ExUnit boots the OTP supervision tree, so the Elixir test
> terminates/restarts the `Orchestrator` child around the run; `bun test` starts
> nothing automatically, so the TS port drives `AgentRunner.run/3` directly (the
> same call the Elixir test makes after terminating the orchestrator). The
> Elixir mailbox `receive {:worker_runtime_info, ...}` becomes the `AgentRunner`
> recipient callback capturing the worker runtime info.

## Verification harness (Phase 0 deliverable)

1. **Per-module unit tests** — translated ExUnit → `bun test`, must be green before `green` status.
2. **Differential oracle** — `harness/` scripts:
   - `record-elixir.ts`: drive the Elixir build, capture JSON-API responses and Codex JSON-RPC
     stdio traffic into versioned fixtures under `test/fixtures/oracle/`.
   - `assert-parity.ts`: replay recorded inputs against the TS build, diff outputs.
3. **Golden snapshots** — `test/fixtures/status_dashboard_snapshots/*` (copied from the Elixir
   tree at cutover; byte-identical).
4. **Live e2e** — Phase 7, end-to-end parity gate.

## Coverage / quality gate

Mirror the Elixir gate (`make all`: format + lint + 100% coverage + dialyzer) with
`bun run check` (typecheck + biome + `bun test --coverage`).

## Post-cutover divergence

The tables above are a historical record of the port; the module paths they
list are the paths at cutover time. After cutover the TypeScript tree became
canonical and the following deliberate divergences from the Elixir reference
were introduced. Behavior for `tracker.kind: linear` and `tracker.kind:
memory` is unchanged unless noted.

### Tracker plugin architecture

The hardcoded memory/linear tracker switch was generalized into a plugin
registry so additional work-management tools (Slack, Lark, ...) can be added
without touching the core. TS-native design, no Elixir counterpart.

- **Contract & registry:** `src/symphony/plugins/types.ts` defines
  `TrackerPlugin` — three required read operations (the SPEC §11.1 REQUIRED
  set) plus optional capabilities (`comments`, `stateUpdates`, `agentTools`,
  `ui`, `configSchema`). `plugins/registry.ts` resolves `tracker.kind` to a
  registered plugin; built-ins register in `plugins/index.ts`. The tracker
  facade (`tracker/tracker.ts`) returns a structured
  `tracker_capability_unsupported` error when the active plugin omits a write
  capability.
- **Moved modules:** `linear/issue.ts` → `plugins/work-item.ts` (type renamed
  `Issue` → `WorkItem`, with `Issue`/`newIssue`/`isIssue` kept as permanent
  aliases; wire names — the Liquid `issue.*` scope, JSON-API fields, snapshot
  output — are a user contract and did not change); `linear/client.ts` and
  `linear/adapter.ts` → `plugins/linear/`; `tracker/memory.ts` →
  `plugins/memory/adapter.ts`.
- **WorkItem.metadata:** new plugin-private extension slot (`JsonMap`,
  defaults to `{}`). Core code never reads it; prompt templates can via
  `issue.metadata.*`.
- **Errors:** plugin-originated errors carry `code` (normalized category) and
  `message` (operator copy) alongside the legacy `tag` strings, which are
  preserved verbatim (including extra fields like `status`/`reason`/`errors`).
- **Config:** `TrackerSettings` shrank to the core scheduling fields (`kind`,
  `required_labels`, `active_states`, `terminal_states`) plus an opaque
  `plugin` section cast/finalized/validated by the active plugin's
  `configSchema`. WORKFLOW.md keys, defaults, and the `LINEAR_API_KEY` /
  `LINEAR_ASSIGNEE` env fallbacks are unchanged (owned by the Linear plugin);
  `$VAR` resolution helpers live in `plugins/config-helpers.ts`. The memory
  tracker's `seed_issues` extension (already a registered TS-only addition) is
  now formally claimed by its plugin config schema. Divergence: provider
  fields are only cast when the configured kind resolves to a plugin, so e.g.
  `tracker.api_key: 123` under `kind: memory` no longer reports a cast error;
  unregistered kinds still parse and fail `validate()` with
  `unsupported_tracker_kind`.
- **Agent dynamic tools:** `codex/dynamic-tool.ts` became a dispatcher over
  the active plugin's `agentTools`; the `linear_graphql` implementation moved
  verbatim to `plugins/linear/graphql-tool.ts`. Divergence: plugins without
  agent tools (memory) advertise an empty `dynamicTools` list instead of
  always exposing `linear_graphql`.
- **UI contributions:** the dashboard Project URL, default prompt template,
  and continuation-guidance noun come from the plugin `ui` capability; Linear
  output is byte-identical, other kinds fall back to neutral copy ("n/a",
  "work item"). Divergence: `kind: memory` with a stray `project_slug` renders
  "n/a" instead of a Linear URL.
- **Test seams:** `linear_client_module`, `memory_tracker_issues`, and
  `memory_tracker_recipient` app-env keys are unchanged; new
  `tracker_plugin_overrides` key (map of kind → plugin) shadows registered
  plugins for tests.
