---
# Parseable Gitea tracker example. Set GITEA_API_TOKEN before running; the
# endpoint is an instance URL, so this example also works with a self-hosted
# Gitea installation by changing only `tracker.endpoint`.

tracker:
  kind: gitea
  endpoint: https://gitea.example.invalid
  token: $GITEA_API_TOKEN
  owner: example
  repo: symphony
  active_states: [Todo, In Progress, Rework]
  terminal_states: [Done]
  required_labels: [symphony]
  # Keep these labels separate from required_labels/routing labels.
  state_labels:
    Todo: symphony/state-todo
    In Progress: symphony/state-in-progress
    Human Review: symphony/state-review
    Rework: symphony/state-rework
    Done: symphony/state-done
  # Required: only issues assigned to this Gitea login or numeric user ID are candidates.
  assignee: automation

polling:
  interval_ms: 30000

workspace:
  root: /tmp/symphony-gitea-workspaces

agent:
  max_concurrent_agents: 2

codex:
  command: codex app-server

---
You are working on a Gitea issue in {{ issue.identifier }}.

{{ issue.title }}
