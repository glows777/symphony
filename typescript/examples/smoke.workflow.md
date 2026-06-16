---
# Self-contained smoke workflow for `bun run verify` (and manual local smokes).
#
# It exercises a real dispatch loop credential-free: no Elixir, no Codex
# account, no Linear key, no network.
#
#   * tracker.kind: memory          — issues come from this file, not Linear
#   * tracker.seed_issues           — one candidate issue (TS in-memory tracker
#                                     extension; the orchestrator dispatches it)
#   * workspace.root                — resolved from $SYMPHONY_SMOKE_WORKSPACE_ROOT
#                                     (a temp dir); falls back to the default
#                                     tmp workspace root when the env var is unset
#   * codex.command                 — runs the repo's fake codex, expanded by the
#                                     `bash -lc` launcher from $SYMPHONY_SMOKE_FAKE_CODEX
#
# Both env vars are set automatically by `bun run verify`. For a manual smoke,
# export them yourself (see typescript/README.md → "Testing locally").
tracker:
  kind: memory
  seed_issues:
    - id: smoke-issue-1
      identifier: SMOKE-1
      title: Smoke test issue
      description: |
        Verify the Symphony dispatch loop end to end without any credentials.
      state: In Progress
      url: https://example.test/issues/SMOKE-1
polling:
  interval_ms: 200
workspace:
  root: $SYMPHONY_SMOKE_WORKSPACE_ROOT
agent:
  max_concurrent_agents: 1
  max_turns: 1
codex:
  command: bun "$SYMPHONY_SMOKE_FAKE_CODEX"
  read_timeout_ms: 1000
  stall_timeout_ms: 0
observability:
  dashboard_enabled: true
  refresh_ms: 1000
---
You are working on the smoke test issue. This prompt is never sent to a real
model — the workflow points Codex at the repo's fake app-server so the dispatch
loop runs end to end without credentials.
