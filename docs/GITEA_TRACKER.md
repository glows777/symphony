# Gitea tracker plugin

The TypeScript/Bun reference implementation includes `tracker.kind: gitea`.
It reads issues from one Gitea repository, maps them to Symphony WorkItems, and
can write comments and issue state through the same configured API credentials.
The implementation does not depend on a Gitea SDK.

## Configuration

The provider-specific keys live in the `tracker` section:

```yaml
tracker:
  kind: gitea
  endpoint: https://gitea.example.internal
  token: $GITEA_API_TOKEN
  owner: acme
  repo: platform
  active_states: [Todo, In Progress, Rework]
  terminal_states: [Done]
  required_labels: [symphony]
  state_labels:
    Todo: symphony/state-todo
    In Progress: symphony/state-in-progress
    Human Review: symphony/state-review
    Rework: symphony/state-rework
    Done: symphony/state-done
  assignee: automation
```

Required fields are `endpoint`, `token`, `owner`, `repo`, `assignee`, and
`state_labels`.

- `endpoint` is the Gitea instance URL. It may end in `/api/v1`; that suffix is
  normalized, and no `gitea.com` host is assumed.
- `token` is the API token. `$GITEA_API_TOKEN` resolves from the environment;
  the literal token is never logged. `api_token` is accepted as a compatibility
  alias.
- `owner` and `repo` select the repository. `user`, `repository_owner`,
  `repository`, and `repository_name` are accepted aliases for deployments that
  already use those names.
- `assignee` is the Gitea login or numeric user ID used to route issues. It is
  compared case-insensitively; the plugin does not auto-detect the account
  represented by the configured token.
- `required_labels` is matched case-insensitively and requires every listed
  label. The plugin also keeps the core's normal routing check in place.
- `state_labels` maps Symphony workflow state names to dedicated Gitea labels.
  Use a reserved, lower-case namespace such as `symphony/state-*`. These
  labels are provider state, not routing labels. Every state in
  `active_states` and `terminal_states` must be mapped; additional parked
  states such as `Human Review` may also be mapped. Validation rejects overlap
  with `required_labels` and duplicate label targets.

`typescript/examples/gitea.workflow.md` is a parseable starting point. Export
the token before using it:

```sh
export GITEA_API_TOKEN='...'
```

## API endpoint, authentication, and pagination

Requests use Gitea's `/api/v1` REST API. The client sends the configured token
as `Authorization: token <token>` and restricts agent `gitea_api` calls to the
configured host and the configured repository's supported issue and
pull-request routes. The main routes are:

- `GET /api/v1/repos/{owner}/{repo}/issues?state={open|closed}&page={page}&limit={limit}`
- `GET /api/v1/repos/{owner}/{repo}/issues/{index}`
- `GET|POST /api/v1/repos/{owner}/{repo}/issues/{index}/comments`
- `GET /api/v1/repos/{owner}/{repo}/labels`
- `GET|POST|PUT /api/v1/repos/{owner}/{repo}/issues/{index}/labels`
- `DELETE /api/v1/repos/{owner}/{repo}/issues/{index}/labels/{id}`
- `PATCH /api/v1/repos/{owner}/{repo}/issues/{index}` with `{ state: "open" | "closed" }`
- `GET /api/v1/repos/{owner}/{repo}/pulls?state={open|closed}&head={branch}`
- `POST /api/v1/repos/{owner}/{repo}/pulls` with `{ title, head, base }` and an optional `body`
- `GET /api/v1/repos/{owner}/{repo}/pulls/{index}`
- `GET /api/v1/repos/{owner}/{repo}/pulls/{index}/reviews`
- `PATCH /api/v1/repos/{owner}/{repo}/pulls/{index}` with `{ state: "open" | "closed" }`

Issue and repository-label reads send `page` and `limit`. Issue reads do not
send the optional `type=issues` filter because some compatible Gitea 1.23
installations return 404 for that parameter; the client excludes responses
with a `pull_request` payload locally. The client follows a
`Link` header with `rel="next"`, and uses `x-total-count` as the fallback for
constructing the next page. Empty arrays are valid results. Pagination links
are accepted only when they stay on the configured host and API path. A
pagination walk is bounded to 100 pages, 5,000 items, and 60 seconds. During
issue-state refresh, an individual 404 is treated as a missing issue and does
not abort the remaining refresh; other provider errors still fail the refresh.
Authenticated requests reject redirects so the API prefix and authorization
boundary cannot be bypassed.

Authentication and pagination follow the [Gitea API Usage documentation](https://docs.gitea.com/development/api-usage).
The [Gitea 1.27 API reference](https://docs.gitea.com/api/1.27/) is generated
from OpenAPI/Swagger. For a specific self-hosted instance, use its interactive
reference at `<GITEA_BASE_URL>/api/swagger` and its OpenAPI JSON at
`<GITEA_BASE_URL>/swagger.v1.json`; the instance specification is the final
authority if an installation exposes a version-specific difference.

## State and label mapping

Gitea's native issue lifecycle still has only `open` and `closed`, but the
workflow state is always carried by a dedicated `state_labels` label. Active
workflow states use native `open`, terminal workflow states use native
`closed`, and parked states such as `Human Review` use native `open` without
being candidates. There is no configuration mode that projects state from
native `open`/`closed` alone.

Configure `tracker.state_labels` for every active and terminal state, plus any
parked states:

```yaml
tracker:
  kind: gitea
  active_states: [Todo, In Progress, Rework]
  terminal_states: [Done]
  required_labels: [symphony]
  state_labels:
    Todo: symphony/state-todo
    In Progress: symphony/state-in-progress
    Human Review: symphony/state-review
    Rework: symphony/state-rework
    Done: symphony/state-done
```

With `state_labels` configured:

- `fetchCandidateIssues()` and `fetchIssuesByStates(states)` still ask Gitea
  for native `open` or `closed` issues first, then filter mapped workflow
  states by the configured state label. This lets an open issue remain in
  `Human Review` without being dispatched as an active candidate when
  `Human Review` is not in `active_states`.
- A mapped label is trusted only when it agrees with Gitea's native lifecycle:
  terminal mappings such as `Done` require a closed issue; active and parking
  mappings such as `Todo`, `In Progress`, `Human Review`, or `Rework` require
  an open issue. Stale mismatched labels are ignored and the issue falls back
  to the native open/closed projection.
- An issue should carry at most one configured state label. If a human adds
  more than one, the first matching entry in the `state_labels` mapping wins.
  Unknown labels are ignored.
- `stateUpdates` keeps ordinary labels and `required_labels` separate. It
  resolves configured state label names through repository labels, writes only
  numeric label IDs to Gitea, then uses `POST .../labels` and
  `DELETE .../labels/{id}` to add the target state label and remove stale state
  labels. It does not use full label replacement for state writes, so a human
  or robot adding a normal label during the update is not overwritten.
- `stateUpdates` syncs the native issue state (`closed` for terminal workflow
  states, `open` otherwise), reconciles labels with bounded retries, and
  refreshes the issue to verify that the next poll will return the requested
  workflow state. If label reconciliation fails after a native state change,
  the client attempts to roll the native state back and returns the original
  failure plus rollback evidence.
- Closing an issue to a mapped terminal state removes stale active state labels
  and writes the terminal label. Reopening to a mapped active or parking state
  removes stale terminal labels and restores the requested active label.
- Omitting `state_labels`, or omitting a mapping for an active or terminal
  state, is a configuration error. Existing two-state-only configurations must
  be migrated by adding dedicated state labels.

The plugin implements `comments` and `stateUpdates`. It also advertises a
controlled `gitea_api` agent tool. The tool accepts only `GET`, `POST`, `PUT`,
and `PATCH` requests for the configured repository's issue, comment, label,
state, and pull-request routes. Pull-request creation is limited to the
required `title`, `head`, and `base` fields plus an optional `body`; pull-request
updates only allow the open/closed state. `DELETE`, unrelated API endpoints,
other repositories, and arbitrary request bodies are rejected before the
client is called.

## Pull-request lifecycle

The tracker does not merge pull requests automatically. A workflow that uses
Gitea for delivery should have the agent:

1. push the issue branch over SSH;
2. list open pull requests for that branch and reuse an existing one when
   present;
3. create a pull request when none exists, with the issue URL, change summary,
   and verification results in its body;
4. comment the pull-request URL back onto the Issue and move its state label to
   `Human Review` while keeping the native Issue open.

Human review and merge happen in Gitea. After the merge, the Issue can move to
the mapped `Done` state. If a rework cycle starts, the old pull request should
be closed before the workspace is reset so the next attempt creates a fresh
pull request.

## Compatibility and errors

The implementation is aligned with the Gitea 1.27 OpenAPI shapes for issue
`number`, `state`, `body`, `html_url`, `assignee(s)`, and `labels`. It is
expected to work with older self-hosted versions that retain these routes and
fields; verify older installations with their own `/swagger.v1.json` before
enabling writes.

Missing configuration or credentials, transport failures, HTTP 401/403/404 and
other non-2xx responses, Gitea error payloads, and malformed JSON shapes are
returned as standard `TrackerError` values. The original HTTP status and
provider body remain in the error detail for diagnostics; no real Gitea network
is used by the test suite.
