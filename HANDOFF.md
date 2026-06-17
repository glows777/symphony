# Symphony Elixir → TypeScript migration — handoff

> For a fresh local Claude Code session (no prior context) that will pull this branch
> and verify/finish the migration on your machine.

## 1. TL;DR

The TypeScript/Bun port in [`typescript/`](./typescript) is a complete, literal,
module-for-module port of the Elixir reference in [`elixir/`](./elixir). It lives on
branch **`claude/sweet-clarke-78v0u8`**. The quality gate is green — **227 tests pass
across 31 files** (`bun run check`: typecheck + biome + bun test) — and **`bun run verify`
passes a credential-free end-to-end run** (it runs `check`, then boots the real app and
exercises the HTTP API, dispatches an issue to completion against a fake Codex, and confirms
a clean `SIGTERM` shutdown). Every Elixir module with a meaningful TS analog is `green`; the
only open items are the user's call: an **optional** parity sign-off (oracle + real live
e2e) and the **cutover** (delete `elixir/`, make `typescript/` the project root). Per-module
status and the OTP→TS rulebook live in [`typescript/MIGRATION.md`](./typescript/MIGRATION.md)
— consult it instead of re-deriving internals.

## 2. Prerequisites

- **Functional verification (Steps 1–2): [Bun](https://bun.sh) `>= 1.3` only.** No Elixir,
  no Codex, no Linear key, no network.
- **Optional parity (Step 3):** [`mise`](https://mise.jdx.dev) + Elixir (to run the Elixir
  reference), the Codex CLI, a **disposable** `LINEAR_API_KEY`, and Docker. Set the key in
  your shell env only — **never paste it into chat or commit it.**

## 3. Step 1 — Get the code

```bash
git clone <your-symphony-remote> symphony
cd symphony
git checkout claude/sweet-clarke-78v0u8
```

## 4. Step 2 — Functional verification (the must-do)

```bash
cd typescript
bun install
bun run check     # typecheck + biome + bun test
bun run verify    # runs check again, then a real end-to-end smoke of the running app
```

Expected tail of `bun run check`:

```
 227 pass
 0 fail
Ran 227 tests across 31 files.
```

`bun run verify` runs the gate, then boots the real app (`src/cli.ts`) against
[`examples/smoke.workflow.md`](./typescript/examples/smoke.workflow.md) — the in-memory
tracker seeded with one issue, a temp workspace root, and the repo's fake Codex
([`test/harness/fake-codex.ts`](./typescript/test/harness/fake-codex.ts)). Expected tail:

```
[verify] check passed
[verify] booting app on http://127.0.0.1:<port> (workspaces=/tmp/symphony-verify-XXXX/workspaces)
[verify] GET /api/v1/state -> 200 with a well-formed snapshot
[verify] POST /api/v1/refresh -> 202
[verify] GET /api/v1/DOES-NOT-EXIST -> 404
[verify] workspace created for dispatched issue: /tmp/symphony-verify-XXXX/workspaces/SMOKE-1
[verify] SIGTERM -> exit 0 (clean shutdown)

PASS: Symphony verification succeeded.
```

What it asserts: the quality gate; the observability API status codes (`200`/`202`/`404`);
that the seeded issue flows dispatch → Codex turn → completion and its workspace is created;
and that the real CLI entrypoint stays alive until signalled, then exits `0` on `SIGTERM`
(it does **not** tear the app down on startup).

Manual smoke (from [`typescript/README.md`](./typescript/README.md) → "Testing locally"):

```bash
cd typescript
export SYMPHONY_SMOKE_WORKSPACE_ROOT="$(mktemp -d)"
export SYMPHONY_SMOKE_FAKE_CODEX="$PWD/test/harness/fake-codex.ts"

# terminal 1 — boot the CLI on a port
bun run src/cli.ts \
  --i-understand-that-this-will-be-running-without-the-usual-guardrails \
  --port 4000 examples/smoke.workflow.md

# terminal 2
curl -s localhost:4000/api/v1/state | jq                              # 200, snapshot JSON
curl -s -X POST localhost:4000/api/v1/refresh                         # 202
curl -s -o /dev/null -w '%{http_code}\n' localhost:4000/api/v1/NOPE   # 404
ls "$SYMPHONY_SMOKE_WORKSPACE_ROOT"                                   # SMOKE-1 workspace
# Ctrl-C / SIGTERM stops it cleanly (exit 0)
```

If `check` and `verify` are green, the port is functionally verified. Steps 3 and 4 are
optional and at your discretion.

## 5. Step 3 — Optional parity sign-off (OPTIONAL)

Only needed if you want provable byte-equivalence with the Elixir build (the functional
verification above does not require it).

**Differential oracle** — record reference behavior from Elixir, replay against TS. Full
instructions in [`typescript/harness/README.md`](./typescript/harness/README.md):

```bash
# Record against the Elixir build (terminal 1 runs Elixir, terminal 2 records):
cd elixir && mise exec -- ./bin/symphony --i-understand-... --port 4000 ./WORKFLOW.md
cd typescript && bun harness/record-api.ts http://127.0.0.1:4000
# Assert the TS build reproduces the fixtures:
bun run start --port 4000 ./WORKFLOW.md            # terminal 1
bun harness/assert-parity.ts http://127.0.0.1:4000 # terminal 2  (PASS/FAIL/SKIP per fixture)
```

**Real Docker/Linear/Codex live e2e** (env-gated; not run by `check`/`verify`):

```bash
cd typescript
export LINEAR_API_KEY=...        # disposable key, in shell env only — never in chat/commits
SYMPHONY_RUN_LIVE_E2E=1 bun test test/live-e2e.test.ts
```

> The real live e2e additionally needs Docker Compose workers, SSH, a real Linear
> team/project, and a Codex `auth.json`. Its harness is not fully reframed for Bun yet — see
> the Phase 7 notes in [`typescript/MIGRATION.md`](./typescript/MIGRATION.md). The sandbox
> in-process e2e (`test/live-e2e.test.ts`, default) already runs as part of `bun run check`.

## 6. Step 4 — Cutover (OPTIONAL, only after you're satisfied)

Makes `typescript/` self-contained and removes the Elixir reference. **This is the one
irreversible step** (recoverable via git history) — do it on a clone/branch and re-verify
before relying on it.

1. Copy the golden fixtures the dashboard test reuses, then repoint the test:
   ```bash
   mkdir -p typescript/test/fixtures/status_dashboard_snapshots
   cp -R elixir/test/fixtures/status_dashboard_snapshots/* \
         typescript/test/fixtures/status_dashboard_snapshots/
   # edit typescript/test/symphony/status-dashboard-snapshot.test.ts:
   #   "../../../elixir/test/fixtures/status_dashboard_snapshots"
   #   → "../../fixtures/status_dashboard_snapshots"
   ```
2. Find and clear any remaining cross-deps (code or docs):
   ```bash
   grep -rn "\.\./elixir\|elixir/" typescript/ --include="*.ts" --include="*.md" | grep -v node_modules
   ```
   The only code reference today is that one dashboard test; the rest are doc links in
   `typescript/README.md` and `typescript/MIGRATION.md` — update or drop them.
3. Remove the Elixir tree and repoint docs:
   ```bash
   git rm -r elixir/
   # update the root README.md to point at typescript/ as the project
   # update typescript/MIGRATION.md to mark the migration complete
   ```
4. Re-verify the now-standalone port:
   ```bash
   cd typescript && bun run verify
   ```

## 7. Guardrails for the local agent

- Develop on **`claude/sweet-clarke-78v0u8`**; create it locally if missing. Don't push to
  another branch without explicit permission.
- Keep **`bun run check`** and **`bun run verify`** green at every commit.
- Commit in logical, self-contained units with clear messages.
- **Do not open a pull request** unless explicitly asked.
- Pause and ask on genuine behavioral ambiguity the Elixir code doesn't resolve — the Elixir
  implementation in `elixir/` is the source of truth for behavior.

## 8. Troubleshooting

- **Port already in use** (manual smoke / `--port`): pick another port, or find the holder
  with `lsof -i :4000`. `bun run verify` picks a free port automatically.
- **`bun install` offline / fails:** the deps are small (`liquidjs`, `yaml`, `zod`, plus dev
  `@biomejs/biome`, `typescript`, `@types/bun`). Run it once with network; afterwards
  `check`/`verify` need no network. Ensure Bun is `>= 1.3` (`bun --version`).
- **A `verify` FAIL** prints `FAIL: <reason>` and exits non-zero. It means the end-to-end
  path regressed (gate failed, server didn't bind, a status code / workspace / `SIGTERM`
  assertion failed) — fix the regression, not the check. If the `[verify] check` step itself
  failed, run `bun run check` to localize it to a unit test.
