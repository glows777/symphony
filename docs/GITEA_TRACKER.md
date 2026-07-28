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
  active_states: [open]
  terminal_states: [closed]
  required_labels: [symphony]
  # assignee: automation
```

Required fields are `endpoint`, `token`, `owner`, and `repo`.

- `endpoint` is the Gitea instance URL. It may end in `/api/v1`; that suffix is
  normalized, and no `gitea.com` host is assumed.
- `token` is the API token. `$GITEA_API_TOKEN` resolves from the environment;
  the literal token is never logged. `api_token` is accepted as a compatibility
  alias.
- `owner` and `repo` select the repository. `user`, `repository_owner`,
  `repository`, and `repository_name` are accepted aliases for deployments that
  already use those names.
- `assignee`, when present, matches a Gitea assignee login or numeric user ID.
  Without it, the plugin accepts both assigned and unassigned issues.
- `required_labels` is matched case-insensitively and requires every listed
  label. The plugin also keeps the core's normal routing check in place.

`typescript/examples/gitea.workflow.md` is a parseable starting point. Export
the token before using it:

```sh
export GITEA_API_TOKEN='...'
```

## API endpoint, authentication, and pagination

Requests use Gitea's `/api/v1` REST API. The client sends the configured token
as `Authorization: token <token>` and restricts agent `gitea_api` calls to the
configured host and `/api/v1/` path prefix. The main routes are:

- `GET /api/v1/repos/{owner}/{repo}/issues?state={open|closed}&type=issues&page={page}&limit={limit}`
- `GET /api/v1/repos/{owner}/{repo}/issues/{index}`
- `GET|POST /api/v1/repos/{owner}/{repo}/issues/{index}/comments`
- `GET /api/v1/repos/{owner}/{repo}/labels`
- `GET|PUT /api/v1/repos/{owner}/{repo}/issues/{index}/labels`
- `PATCH /api/v1/repos/{owner}/{repo}/issues/{index}` with `{ state: "open" | "closed" }`

Issue and repository-label reads send `page` and `limit`. The client follows a
`Link` header with `rel="next"`, and uses `x-total-count` as the fallback for
constructing the next page. Empty arrays are valid results. Pagination links
are accepted only when they stay on the configured host and API path.

Authentication and pagination follow the [Gitea API Usage documentation](https://docs.gitea.com/development/api-usage).
The [Gitea 1.27 API reference](https://docs.gitea.com/api/1.27/) is generated
from OpenAPI/Swagger. For a specific self-hosted instance, use its interactive
reference at `<GITEA_BASE_URL>/api/swagger` and its OpenAPI JSON at
`<GITEA_BASE_URL>/swagger.v1.json`; the instance specification is the final
authority if an installation exposes a version-specific difference.

## State and label mapping

Gitea has two issue states: `open` and `closed`. They are projected into the
workflow's active and terminal vocabularies so the orchestrator can use its
existing scheduling/reconciliation loop:

- `open` is the active semantic state.
- `closed` is the terminal semantic state.
- When workflow names are explicit (`active_states: [open]`,
  `terminal_states: [closed]`), WorkItems retain those names. The default core
  state names (`Todo`/`In Progress` and `Closed`/`Done` variants) are also
  recognized: an open Gitea issue is projected to the first matching active
  workflow name, and a closed issue to the first matching terminal name.
- `fetchCandidateIssues()` reads open issues, then applies the configured
  assignee and required-label rules. `fetchIssuesByStates(states)` maps the
  requested workflow names back to `open` or `closed`.
- `fetchIssueStatesByIds(ids)` refreshes each repository issue by its stable
  `owner/repo#number` identifier. If an issue is closed, the next refresh
  returns a terminal WorkItem and the orchestrator stops/reconciles it instead
  of dispatching it again.
- WorkItem labels are lower-cased and trimmed. `PUT .../labels` replaces an
  issue's labels; the agent can use that route through `gitea_api` when needed.

The plugin implements `comments` and `stateUpdates`. It also advertises a
controlled `gitea_api` agent tool with `GET`, `POST`, `PUT`, `PATCH`, and
`DELETE`; tool paths must start with `/api/v1/`, and the tool cannot select a
different host or send an arbitrary absolute URL.

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
