# Symphony Tracker Plugin Contract

This document is the normative contract for **tracker plugins**: the pluggable
adapters that connect Symphony's orchestrator to a work-management tool
(Linear, an in-memory test tracker, and future integrations such as Slack or
Lark).

**Status and scope.** This document supplements [`../SPEC.md`](../SPEC.md)
§11 ("Issue Tracker Integration Contract") without modifying it. SPEC §11
defines *what* the orchestrator requires from a tracker; this document defines
*how* an implementation packages that requirement as a plugin. Where the two
overlap, SPEC.md wins. The reference implementation of this contract lives in
[`../typescript/src/symphony/plugins/`](../typescript/src/symphony/plugins/);
deliberate divergences from the pre-plugin behavior are registered in
[`../typescript/MIGRATION.md`](../typescript/MIGRATION.md) under
"Post-cutover divergence".

The key words MUST, MUST NOT, REQUIRED, SHOULD, SHOULD NOT, MAY, and OPTIONAL
are to be interpreted as described in RFC 2119.

---

## 1. Overview

A tracker plugin is a value satisfying the `TrackerPlugin` type
(`plugins/types.ts`):

```ts
type TrackerPlugin = {
  id: string;                        // matches `tracker.kind` in WORKFLOW.md
  displayName: string;
  configSchema?: PluginConfigSchema; // OPTIONAL: cast/finalize/validate hooks

  // REQUIRED core: the three read operations (SPEC §11.1)
  fetchCandidateIssues(): Promise<Result<WorkItem[], TrackerError>>;
  fetchIssuesByStates(states: string[]): Promise<Result<WorkItem[], TrackerError>>;
  fetchIssueStatesByIds(ids: string[]): Promise<Result<WorkItem[], TrackerError>>;

  // OPTIONAL capabilities
  comments?: CommentCapability;
  stateUpdates?: StateUpdateCapability;
  agentTools?: AgentToolCapability;
  ui?: UiCapability;
};
```

Design rule: **reads are required, everything else is a capability.** The
orchestrator's poll/reconcile/cleanup loops depend only on the three read
operations. Write-backs, agent-facing tools, and UI copy are optional; a
plugin for a tool without a native state machine or comment API simply omits
them, and the core reports a structured error instead of guessing (see §5).

## 2. Resolution and registration

- The active plugin is resolved from `tracker.kind` in `WORKFLOW.md` through
  the registry (`plugins/registry.ts`), on **every** facade call — Symphony
  re-reads config per operation, so kind changes take effect without restart.
- Built-in plugins register statically in `plugins/index.ts`. Registration is
  a side effect of importing that module; `config.ts` and
  `tracker/tracker.ts` both import it, so any code path that parses settings
  or touches the tracker facade sees a populated registry. Out-of-tree
  plugins call `registerTrackerPlugin` from their own entry point. Dynamic
  loading (`import()` of arbitrary paths) is intentionally not provided.
- Resolution failures use stable error tags:
  - `missing_tracker_kind` — `tracker.kind` absent.
  - `unsupported_tracker_kind` — kind not registered. Parsing still succeeds
    for unregistered kinds (the raw `tracker` section passes through
    untouched); the failure surfaces from `config.validate()` before
    dispatch, mirroring SPEC §6.3.

## 3. Work item model

Plugins normalize provider payloads into `WorkItem`
(`plugins/work-item.ts`) — the SPEC §4.1.1 issue model plus one extension:

| Field | Requirement |
|---|---|
| `id` | REQUIRED. Stable provider-internal ID; the orchestrator's map key. |
| `identifier` | REQUIRED. Human-readable key; also the workspace directory key (filesystem-sanitized), so it MUST be unique per item after sanitization. |
| `title` | REQUIRED (candidate items with a non-string title are not dispatched). |
| `state` | REQUIRED. A name from the plugin's own state vocabulary (§4.1). |
| `description` | SHOULD be provided; used only for prompt rendering. |
| `priority`, `branchName`, `url`, `assigneeId`, `labels`, `blockedBy`, `assignedToWorker`, `createdAt`, `updatedAt` | OPTIONAL. Each degrades gracefully: missing priority sorts last, empty `blockedBy` disables blocking, empty `labels` with no `required_labels` routes everything, `assignedToWorker` defaults to accepting work. |
| `metadata` | OPTIONAL plugin-private extension slot (JSON map; e.g. a chat `channel`/`thread_ts`). Core code never reads it; prompt templates can, via `issue.metadata.*`. |

Rules:

- Every item a plugin returns MUST be constructed through `newWorkItem(...)`.
  This applies the nominal brand that lets the core distinguish real work
  items from arbitrary maps (`isWorkItem`). Items built by object spread or
  literal maps will be silently ignored by consumers that filter on the
  brand.
- **Wire names are frozen.** The Liquid template scope is named `issue` and
  its snake_case field names (`issue.branch_name`, `issue.blocked_by`, ...),
  the JSON-API field prefixes, and dashboard snapshot output are user
  contracts. `Issue`, `newIssue`, and `isIssue` remain permanent aliases of
  the `WorkItem` names. New plugins MUST NOT introduce alternative wire
  names.

### 3.1 State vocabulary

`tracker.active_states` and `tracker.terminal_states` are **core** config: the
orchestrator's reconcile state machine matches `WorkItem.state` against them
(case-insensitively). The contract:

- A plugin MUST populate `state` with names from a documented vocabulary of
  its own choosing, and workflow authors configure matching
  `active_states`/`terminal_states`.
- Tools without a native state machine project one. Example: a chat-thread
  plugin may map "no resolved marker" → `"open"` and "resolved marker /
  archived" → `"resolved"`. With that projection the plugin participates in
  the full scheduling loop without implementing `stateUpdates`.

## 4. Required operations

The three reads mirror SPEC §11.1 and are called by the core as follows:

1. `fetchCandidateIssues()` — the dispatch pool. Items in configured active
   states for the configured scope, already filtered by any provider-side
   assignee routing. Called every poll tick and on retry.
2. `fetchIssuesByStates(states)` — lookup by state names; used at startup to
   find terminal items whose workspaces should be cleaned.
3. `fetchIssueStatesByIds(ids)` — batch refresh by ID; used for running-item
   reconciliation, blocked-item checks, pre-dispatch revalidation, and
   between agent turns. This is the reconcile loop's backbone: it MUST
   return fresh `state` values.

Orchestrator behavior on read failures is fixed (SPEC §11.4) and independent
of the error's `code`: candidate-fetch failure skips the tick; running-refresh
failure keeps workers alive; startup-cleanup failure logs a warning and
continues.

## 5. Optional capabilities

When a capability is absent, the tracker facade (`tracker/tracker.ts`)
returns:

```jsonc
{ "tag": "tracker_capability_unsupported", "code": "unsupported_operation",
  "message": "tracker '<id>' does not support <capability>" }
```

Silent no-op success is prohibited — a caller must be able to tell "done"
from "cannot do".

| Capability | Contract |
|---|---|
| `comments` | `createComment(issueId, body)`. Write-backs are normally the agent's job (SPEC §11.5), so the core does not call this today; it exists for plugins that can support it and for tests. |
| `stateUpdates` | `updateIssueState(issueId, stateName)`, where `stateName` is from the plugin's vocabulary (§3.1). Same caveat as `comments`. |
| `agentTools` | `listAgentTools()` returns tool specs (`name`, `description`, JSON-schema `inputSchema`); `executeAgentTool(tool, args, opts)` returns `{ success, payload }`. The Codex dispatcher (`codex/dynamic-tool.ts`) advertises these specs on `thread/start` and routes `item/tool/call` requests; protocol encoding (JSON stringification, `contentItems`, the unsupported-tool payload) stays in the dispatcher. Plugins without this capability advertise an **empty** tool list. |
| `ui` | `projectUrl(settings)` for the dashboard "Project:" line (`null` renders "n/a"); `defaultPromptTemplate` used when WORKFLOW.md has no prompt body; `workItemNoun` for operator/agent copy (fallback: "work item"). |

## 6. Error model

All plugin-originated errors MUST be `TrackerError`-shaped:

```ts
type TrackerError = {
  tag: string;            // stable machine tag, plugin-defined
  code: TrackerErrorCode; // normalized category (below)
  message: string;        // operator-facing copy, supplied by the plugin
  detail?: unknown;       // raw payload, passed through untouched
};
```

Normalized codes: `missing_credentials`, `missing_config`,
`transport_failed`, `provider_status`, `provider_error`, `invalid_payload`,
`unsupported_operation`, `unknown`.

Rules:

- Core code branches on `code` and logs `message`; it MUST NOT switch on
  plugin-specific tags. Legacy tags (e.g. `missing_linear_api_token`) and
  legacy top-level fields (`status`, `reason`, `errors`) are preserved
  verbatim for compatibility.
- Errors entering a plugin from an untyped seam (e.g. an injected client
  module) MUST be normalized with `toTrackerError`: conforming errors pass
  through untouched; anything else is wrapped as
  `{ tag: "tracker_error", code: "unknown", detail: <original> }`.
- SPEC §11.4's category names are RECOMMENDED-only; this contract documents
  the tags actually used by the built-in plugins (the Linear plugin uses
  `missing_linear_api_token` / `missing_linear_project_slug` where SPEC
  suggests `missing_tracker_api_key` / `missing_tracker_project_slug`).

## 7. Configuration contract

The core `tracker` section owns exactly four keys: `kind`,
`required_labels`, `active_states`, `terminal_states`. **All other keys in
the `tracker` section belong to the plugin selected by `kind`** and flow
through the plugin's `configSchema`:

```ts
type PluginConfigSchema = {
  cast(raw: JsonMap, section: string): { value: JsonMap; errors: PluginFieldError[] };
  finalize(value: JsonMap): JsonMap;   // $VAR references, canonical env fallbacks
  validate(settings: Settings): Result<undefined, TrackerError>;
};
```

- `cast` runs inside `Settings` parsing; it MUST be synchronous and pure
  (settings re-parse on every read). Errors use the
  `"tracker.<key> <message>"` convention so they merge into the standard
  `invalid_workflow_config` surface.
- `finalize` resolves `$VAR` references and canonical environment fallbacks.
  Plugins MUST use the shared helpers in `plugins/config-helpers.ts`
  (`resolveSecretSetting`, `envOrNull`, ...) so `$VAR` semantics are
  identical across plugins.
- `validate` is the semantic gate run by `config.validate()` before dispatch
  (e.g. the Linear plugin requires `api_key` and `project_slug` here).
- Plugins consume their own section through a typed narrowing function (see
  `plugins/linear/settings.ts`) rather than reaching into raw maps at call
  sites. The core `Settings` type MUST NOT gain provider-specific fields.

## 8. Test seams

| app-env key | Purpose |
|---|---|
| `tracker_plugin_overrides` | Map of kind → plugin; shadows registered plugins for a test. |
| `linear_client_module` | Injects a fake Linear GraphQL client under the Linear plugin. |
| `lark_client_module` | Injects a fake Lark Bitable client under the Lark plugin. |
| `lark_task_client_module` | Injects a fake Lark task-center client under the lark-task plugin. |
| `memory_tracker_issues` / `memory_tracker_recipient` | Memory plugin's item source / write-back event sink. |

`test/support/test-support.ts` clears all of these in `teardownWorkflow` (it
also resets the lark-family plugins' shared module-level tenant-token cache).
Plugin-specific seams live inside the plugin; new plugins SHOULD follow the
same pattern (an app-env key holding an injectable module).

## 9. Built-in plugins (reference)

### 9.1 `linear`

Full-capability reference implementation
(`plugins/linear/`): GraphQL reads with pagination, comment/state mutations,
the `linear_graphql` agent tool (semantics per SPEC §10.5), and UI
contributions (project URL, the original "Linear issue" prompt template).
Config keys claimed by its schema: `endpoint` (default
`https://api.linear.app/graphql`), `api_key` (canonical env
`LINEAR_API_KEY`), `project_slug` (required), `assignee` (canonical env
`LINEAR_ASSIGNEE`; `"me"` resolves via the viewer query).

### 9.2 `memory`

In-memory tracker for tests and self-contained demos
(`plugins/memory/`). Items come from the `memory_tracker_issues` app-env
injection or the `tracker.seed_issues` WORKFLOW.md key (claimed by its config
schema); writes replay to the `memory_tracker_recipient` callback. It
implements every capability except `agentTools` and `ui`, making it the
minimal example of capability-based degradation: memory-kind sessions
advertise no dynamic tools and render "n/a" for the project line.

### 9.3 `lark`

Lark (Feishu) Bitable-backed tracker (`plugins/lark/`): one Bitable table is
one board, and a work item is a record in that table. Reads map onto
`records/search` (per-state `is` conditions under an `or` conjunction,
`page_token` pagination) and `records/batch_get` (100-id batches); the state
vocabulary (§3.1) is the options of the configured state single-select field,
so workflow authors set `active_states`/`terminal_states` to match their
options. Auth is a short-lived `tenant_access_token`, cached module-level
with a refresh margin and re-acquired once on invalid-token responses.

Capabilities: `stateUpdates` (record update on the state field), the
`lark_api` agent tool (raw OpenAPI requests with Symphony's auth; the path
MUST start with `/open-apis/` and the host is always the configured
endpoint), and `ui` (Bitable table URL, "Lark record" noun, no plugin prompt
template). `comments` is omitted — Bitable records have no public
record-comment open API — so the facade returns the §5 structured error.

Config keys claimed by its schema: `endpoint` (default
`https://open.feishu.cn`; Lark international tenants use
`https://open.larksuite.com`), `app_id`, `app_secret` (canonical env
`LARK_APP_SECRET`), `app_token` (required), `table_id` (required), `assignee`
(an open_id; the app identity has no viewer, so `"me"` is not supported), and
the field-name mappings `field_state`/`field_title`/`field_description`/
`field_labels`/`field_assignee` (defaults `Status`/`Title`/`Description`/
`Labels`/`Assignee`) plus `field_identifier` (null → `record_id`) and
`field_priority` (null → priority unmapped). `blockedBy` is not mapped in v1
(empty, disabling the blocking gate per §3).

### 9.4 `lark-task`

Lark (Feishu) task-center (Task v2) tracker (`plugins/lark-task/`), parallel
to — not replacing — the Bitable-backed `lark` plugin: one tasklist is one
board, a work item is a task in that tasklist, and the state vocabulary
(§3.1) is the tasklist's **section** names (one section = one board column).
Candidate reads list the tasks of each active-state section
(`sections/{guid}/tasks` with `completed=false`, `page_token` pagination);
the by-ids read is one `tasks/{guid}` detail get per id (Task v2 has no batch
get), deriving the fresh state from the detail's `tasklists` section
membership; a state update moves the task via `add_tasklist` with the target
section's guid. Checkbox completion is orthogonal to sections and treated as
"off the board": the by-ids read normalizes completed tasks to absent, so
dispatch revalidation skips them and a running worker whose task was checked
off winds down like a deleted task (only the by-states cleanup read applies
no completed filter). Section listings return summaries without
description/url/timestamps — those degrade to null and are filled in by the
detail-backed by-ids read the orchestrator runs right before dispatch. Auth,
the request layer, and the `lark_api` agent tool are shared with the `lark`
plugin (`plugins/lark-common/`); error tags use the `lark_task_*` prefix.

Capabilities: every optional one — `stateUpdates` (section move), `comments`
(the task center has a native comment API, closing the Bitable plugin's gap),
the shared `lark_api` agent tool, and `ui` (tasklist applink URL, "Lark task"
noun, no plugin prompt template). `blockedBy` is not mapped in v1 even though
Task v2 has native dependencies (open item; empty disables the blocking
gate).

Config keys claimed by its schema: `endpoint` (default
`https://open.feishu.cn`), `app_id`, `app_secret` (canonical env
`LARK_APP_SECRET`, shared with the Bitable plugin), `tasklist_guid`
(required), and `assignee` (an open_id; `"me"` is not supported). No
field-name mappings: the state vocabulary is the section names, so workflow
authors set `active_states`/`terminal_states` to match their sections.
Because tasks carry no labels in v1, its validate hook rejects a non-empty
`tracker.required_labels` (which would otherwise silently route nothing).

## 10. Writing a new plugin (checklist)

Using a hypothetical Slack plugin as the running example:

1. **Model the work item.** Stable `id` (e.g. `channel:thread_ts`), a
   filesystem-safe `identifier`, `title` from the first message,
   provider-specific bits (`channel`, `thread_ts`) in `metadata`. Construct
   everything with `newWorkItem`.
2. **Project a state vocabulary** (§3.1) and document it, e.g.
   `"open"`/`"resolved"`; workflow authors set
   `active_states: ["open"]`, `terminal_states: ["resolved"]`.
3. **Implement the three reads** against the provider API, returning
   `TrackerError`-shaped failures (§6).
4. **Pick capabilities honestly.** Slack has thread replies → implement
   `comments`. No real state machine → omit `stateUpdates` (do NOT fake it
   with a no-op). Optionally expose a `slack_api` agent tool and a
   `projectUrl` pointing at the channel.
5. **Write the configSchema** claiming your keys (e.g. `bot_token` with a
   canonical env fallback, `channel`), using the shared config helpers.
6. **Register** in `plugins/index.ts` (in-tree) or via
   `registerTrackerPlugin` (out-of-tree), and add an app-env seam for client
   injection.
7. **Test against the contract:** registry resolution, read semantics,
   capability-missing errors from the facade, config cast/finalize/validate,
   and (if applicable) agent-tool dispatch. `test/symphony/plugins/` has the
   patterns.

## 11. Relationship to other documents

- **SPEC.md** — unchanged by the plugin architecture. §11's REQUIRED reads,
  normalization rules, error-handling behavior, and the write boundary
  (§11.5) all hold; this document layers the packaging (capabilities,
  registry, config delegation, error shape) on top. A future SPEC revision
  may fold this contract into §11.
- **typescript/MIGRATION.md** — "Post-cutover divergence" records where the
  plugin architecture deliberately departs from the pre-plugin (Elixir-port)
  behavior; anything not listed there is behavior-compatible.
