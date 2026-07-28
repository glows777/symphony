---
# A production-shaped Symphony workflow for a real Linear project.
#
# Copy this to `WORKFLOW.md` at the root of the repository you want agents to
# work on, adjust the marked values, then run:
#
#   symphony --i-understand-that-this-will-be-running-without-the-usual-guardrails
#
# Symphony reads `WORKFLOW.md` from the process working directory unless a path
# is passed as the CLI argument. The file is repository-owned and meant to be
# version-controlled — keep secrets in the environment, not here.
#
# Contrast with `smoke.workflow.md`, which is the credential-free fixture for
# `bun run verify` (in-memory tracker + fake Codex). This file is the opposite
# end: a real tracker, a real agent, real side effects.
#
# Required environment:
#   LINEAR_API_KEY        Linear personal API key (or a bot account's key)
#   SYMPHONY_REPO_URL     git remote the after_create hook clones (used below)
#   SYMPHONY_WORKSPACE_ROOT  directory that will hold one clone per issue
#
# Hooks inherit Symphony's environment, so anything you export before starting
# the process is visible to them.

tracker:
  kind: linear

  # Resolution order: literal value -> "$VAR" expansion -> $LINEAR_API_KEY.
  # Keep the "$VAR" form so the committed file carries no secret.
  api_key: $LINEAR_API_KEY

  # Literal only — this field is NOT environment-expanded. Take it from the
  # project URL: https://linear.app/<workspace>/project/<project-slug>
  project_slug: replace-me-with-your-project-slug

  # "me" resolves to the API key's own user via `viewer { id }` — the normal
  # setup when Symphony runs under a dedicated bot account. A literal Linear
  # user id also works. Unset falls back to $LINEAR_ASSIGNEE; when it resolves
  # to nothing, assignee routing is off and every issue in an active state is a
  # candidate. Start with routing ON.
  assignee: me

  # Belt and braces on top of the assignee filter: an issue is only dispatched
  # when it carries every one of these labels (compared lowercased). This is
  # the cheapest kill switch you have — remove the label to take an issue back.
  required_labels:
    - symphony

  # States Symphony dispatches from. Keep this small; every state listed here
  # is a state an agent may be started for.
  active_states:
    - Todo
    - In Progress

  # States that mean "done with Symphony": the agent is stopped and the
  # workspace is removed (the before_remove hook runs first).
  #
  # Note what is deliberately NOT here: "In Review". A state in neither list is
  # *parked* — Symphony stops dispatching for it but keeps the workspace and
  # the branch alive. That is exactly what you want while a human reviews the
  # PR. Put "In Review" in terminal_states only if you are happy for the
  # workspace to be deleted the moment the agent opens the PR.
  terminal_states:
    - Done
    - Cancelled
    - Canceled
    - Duplicate
    - Closed

polling:
  # Linear's API is rate limited and issues do not change every second. 30s is
  # the default and is a sane floor for a shared workspace.
  interval_ms: 30000

workspace:
  # One directory per issue, named after the sanitized issue identifier
  # (`ENG-123`). Must be writable and should NOT be inside the repository you
  # are working on. "$VAR" is expanded; an unset variable falls back to
  # <tmpdir>/symphony_workspaces.
  root: $SYMPHONY_WORKSPACE_ROOT

agent:
  # "codex" (default) or "claude_code". The selected backend reads its own
  # top-level section of the same name — `codex:` below.
  backend: codex

  # Global ceiling on concurrent agents. Each one is a full checkout plus a
  # coding-agent process, so this is bounded by disk and RAM, not by Linear.
  max_concurrent_agents: 3

  # Per-state ceilings, applied on top of the global one. Keeping "Todo" below
  # the global limit reserves capacity for issues a human already moved to
  # "In Progress".
  max_concurrent_agents_by_state:
    todo: 2
    in progress: 3

  # Turns within a single agent run. After a turn completes normally while the
  # issue is still in an active state, Symphony feeds the agent a continuation
  # prompt rather than starting over — up to this many times. Raise it for
  # long tasks; it is the main lever on "the agent stopped too early".
  max_turns: 20

  # Cap on the exponential backoff between retry attempts after a crashed run.
  max_retry_backoff_ms: 300000

codex:
  command: codex app-server

  # Reject every interactive request rather than hanging on one. Symphony
  # detects the resulting "input required" signal and parks the issue as
  # blocked so a human can pick it up — that is the desired behavior for an
  # unattended run.
  approval_policy:
    reject:
      sandbox_approval: true
      rules: true
      mcp_elicitations: true

  thread_sandbox: workspace-write

  # IMPORTANT, two gotchas:
  #
  # 1. This map is handed to Codex verbatim, so its keys are camelCase, not
  #    snake_case like the rest of this file, and "$VAR" is NOT expanded here —
  #    `writableRoots` must be a literal absolute path. Make it the same
  #    directory `workspace.root` resolves to.
  # 2. Symphony's built-in default is this exact shape with
  #    `networkAccess: false`, derived from workspace.root. That default cannot
  #    install dependencies, fetch, or push — so an agent expected to open a PR
  #    needs this override. Turning network access on inside the sandbox is a
  #    real trust decision, which is why Symphony makes you write it out rather
  #    than inheriting it.
  turn_sandbox_policy:
    type: workspaceWrite
    writableRoots:
      - /replace/me/with/your/workspace/root
    readOnlyAccess:
      type: fullAccess
    networkAccess: true
    excludeTmpdirEnvVar: false
    excludeSlashTmp: false

  # One turn may legitimately run for a long time on a real ticket.
  turn_timeout_ms: 3600000

  # Wire-level read timeout for a single app-server message.
  read_timeout_ms: 5000

  # No agent output for this long ends the turn. 0 disables the check; do not
  # disable it in an unattended run — a wedged agent otherwise holds a slot
  # until turn_timeout_ms.
  stall_timeout_ms: 300000

hooks:
  # Applies to every hook below. after_create does a full clone, so this needs
  # to be generous.
  timeout_ms: 600000

  # Symphony only creates the workspace *directory* — cloning is your job, and
  # this is the hook that does it. It runs via `sh -lc` with the workspace as
  # the working directory, and only on first creation (a re-dispatch reuses the
  # existing clone).
  #
  # No issue variables are injected into the hook environment. The workspace
  # directory name IS the sanitized issue identifier, so `basename "$PWD"` is
  # how you recover it.
  after_create: |
    set -eu
    git clone --filter=blob:none "$SYMPHONY_REPO_URL" .
    git switch -c "symphony/$(basename "$PWD")"

  # Runs before every attempt, including retries and re-dispatches, so it must
  # be idempotent and fast. A non-zero exit fails the attempt, which is the
  # point: a broken toolchain should not burn agent turns.
  # Replace with your project's install/bootstrap command.
  before_run: |
    set -eu
    git fetch --prune origin
    bun install --frozen-lockfile

  # Runs after every attempt. Failures here are logged and ignored, so this is
  # for observability, not for gating.
  after_run: |
    set -eu
    git --no-pager status --short
    git --no-pager log --oneline origin/HEAD..HEAD || true

  # Last chance before the workspace is deleted (issue reached a terminal
  # state). Closing still-open PRs for the branch keeps a cancelled ticket from
  # leaving an orphaned PR behind. Failures are ignored.
  #
  # This is safe alongside the "In Review" parking above: by the time an issue
  # reaches Done its PR is normally merged, and `--state open` matches nothing.
  before_remove: |
    set -eu
    branch="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || true)"
    [ -n "$branch" ] || exit 0
    gh pr list --head "$branch" --state open --json number --jq '.[].number' \
      | xargs -r -n1 gh pr close

observability:
  dashboard_enabled: true
  refresh_ms: 1000
  render_interval_ms: 16

server:
  # HTTP API + dashboard. Bound to loopback; put a tunnel or proxy in front if
  # you want it reachable. `--port` on the CLI overrides this.
  port: 4000
  host: 127.0.0.1
---

You are an autonomous engineer. You own one Linear issue end to end, working in
a git checkout that exists only for this issue.

## Ticket

- Identifier: {{ issue.identifier }}
- Title: {{ issue.title }}
- URL: {{ issue.url }}
- State: {{ issue.state }}
- Priority: {{ issue.priority }}
- Labels: {{ issue.labels | join: ", " }}
- Linear issue id (for GraphQL): {{ issue.id }}
{% if issue.branch_name %}- Branch suggested by Linear: {{ issue.branch_name }}
{% endif %}
## Description

{% if issue.description %}{{ issue.description }}{% else %}**No description was provided.** Do not guess at scope. Follow the
"When you are blocked" section below: comment on the issue asking for the
specific missing information, and stop.{% endif %}

{% if issue.blocked_by.size > 0 %}## Blockers

This issue is marked as blocked by:
{% for blocker in issue.blocked_by %}
- {{ blocker.identifier }} (state: {{ blocker.state }})
{% endfor %}

Symphony does not dispatch a `Todo` issue whose blockers are unresolved, so if
you are reading this the blockers are believed to be finished. If your own
inspection says otherwise, stop and escalate rather than working around them.

{% endif %}## Your environment

- The working directory is a clone of the repository dedicated to this issue.
  It is yours; nobody else is committing to it.
- A branch named `symphony/{{ issue.identifier }}` is already checked out.
- Dependencies were installed by the `before_run` hook before this turn.
- You have network access, so you can fetch, push, and use `gh`.
- You have a `linear_graphql` tool that runs arbitrary GraphQL against Linear
  with Symphony's credentials. It is your only channel back to the tracker.

## Definition of done

All of the following, in order:

1. The change is implemented and the repository's own quality gate passes
   locally. Do not declare completion on an unrun test suite.
2. The work is committed on `symphony/{{ issue.identifier }}` in coherent
   commits and pushed to `origin`.
3. A pull request exists, its body explains what changed and why, and it links
   back to {{ issue.url }}.
4. A comment on the Linear issue records the PR link and anything a reviewer
   needs to know (decisions taken, deliberate omissions, follow-up work).
5. The Linear issue has been moved to **In Review**.

Step 5 is what ends the run. Read the next section before you start.

## How the run ends (this is the control loop — do not skip)

Symphony watches the issue's state, not your output:

- While the issue sits in an active state ({{ issue.state }} is one), finishing
  a turn does **not** finish the run. Symphony hands you a continuation prompt
  and you resume in this same workspace. Ending a turn with the work
  incomplete costs a turn and changes nothing.
- Moving the issue to **In Review** parks it: Symphony stops dispatching, and
  keeps the workspace and branch alive for review feedback.
- Moving it to a terminal state (Done, Cancelled, ...) tells Symphony the work
  is over, and the workspace is deleted.

So: do not move the issue out of an active state until the definition of done
is satisfied, and do move it once it is.

To move the issue, first look up the target state's id, then update the issue:

```graphql
query FindState {
  workflowStates(filter: { name: { eq: "In Review" } }) {
    nodes { id name team { key } }
  }
}
```

```graphql
mutation MoveIssue($id: String!, $stateId: String!) {
  issueUpdate(id: $id, input: { stateId: $stateId }) { success }
}
```

with variables `{"id": "{{ issue.id }}", "stateId": "<id from the query>"}`.
If more than one state matches, pick the one whose `team.key` matches this
issue's identifier prefix.

To comment:

```graphql
mutation Comment($issueId: String!, $body: String!) {
  commentCreate(input: { issueId: $issueId, body: $body }) { success }
}
```

## When you are blocked

Blocked means: the ticket is ambiguous in a way that changes the
implementation, the change needs a decision that is not yours to make, or you
hit a credential or permission wall. It does not mean the task is hard.

If you are blocked:

1. Comment on the issue with the *specific* question and the options you see —
   not "please clarify".
2. Move the issue to **Needs Info**.
3. Stop. Do not implement a guess to have something to show.

## Ground rules

- Stay inside this workspace. Do not modify anything outside it.
- Do not push to the default branch, and do not merge your own PR.
- Do not edit unrelated files, reformat untouched code, or bump dependencies
  the ticket did not ask about. A reviewable diff is part of the deliverable.
- Do not weaken or skip tests to get green. A failing test that reveals a real
  problem is a finding to report, not an obstacle to remove.
- Never write secrets into the repository, the PR, or Linear comments.
- Keep the ticket's stated scope. If you find adjacent problems, finish the
  ticket and list them in your Linear comment.
{% if attempt %}
## Retry context

This is attempt #{{ attempt }} — a previous run for this issue exited without
completing. The workspace still holds that run's state.

Before writing any code: inspect what is already there (`git status`,
`git log`, the test suite). Continue from it rather than restarting, and if the
previous attempt failed for a reason that will repeat, say so in a Linear
comment and escalate instead of looping.
{% endif %}
