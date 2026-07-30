# Symphony Agent Backend Plugin Contract

This document is the normative contract for **agent backend plugins**: the
pluggable adapters that drive a coding agent (the Codex app-server today, a
Claude Code CLI process in the future) on behalf of Symphony's agent runner.

**Status and scope.** This document supplements [`../SPEC.md`](../SPEC.md) §10
("Agent Runner Protocol") without modifying it. SPEC §10 defines *what* the
orchestrator requires from a coding-agent integration (the launch contract, the
emitted event vocabulary, the approval/timeout policy); this document defines
*how* an implementation packages that requirement as a plugin. Where the two
overlap, SPEC.md wins. It is the sibling of
[`PLUGIN_CONTRACT.md`](./PLUGIN_CONTRACT.md) (the tracker plugin contract) and
mirrors its structure. The reference implementation lives in
[`../typescript/src/symphony/plugins/agents/`](../typescript/src/symphony/plugins/agents/);
deliberate divergences from the pre-plugin behavior are registered in
[`../typescript/MIGRATION.md`](../typescript/MIGRATION.md) under
"Post-cutover divergence".

The key words MUST, MUST NOT, REQUIRED, SHOULD, SHOULD NOT, MAY, and OPTIONAL
are to be interpreted as described in RFC 2119.

---

## 1. Overview

An agent backend plugin is a value satisfying the `AgentBackendPlugin` type
(`plugins/agents/types.ts`):

```ts
type AgentBackendPlugin = {
  id: string;                        // matches `agent.backend` in WORKFLOW.md
  displayName: string;
  configSchema?: PluginConfigSchema; // OPTIONAL: cast/finalize/validate hooks

  sessions: AgentSessionApi;         // REQUIRED core: start / run turn / stop

  capabilities?: AgentBackendCapabilities; // multiTurnSessions / remoteWorkers / ...
  ui?: AgentUiCapability;                   // humanizeMessage
  replay?: ReplayCapability;                // differential-oracle seam
};
```

Design rule: **the session API is required, everything else is a capability.**
The runner's start → run-turns → stop loop depends only on `sessions`. Whether
turns share one live session, whether remote workers are supported, how the
"last message" line reads, and whether a differential-oracle replay exists are
all optional; a backend that lacks a feature omits the capability and the runner
degrades predictably (a fresh session per turn, a structured
`remote_workers_unsupported` error, a generic message summary). This mirrors the
tracker contract's "reads are required, everything else is a capability."

## 2. Resolution and registration

Agent backends live in `plugins/agents/`, a sibling of `plugins/trackers/` —
the two extension points are symmetric, and anything both contracts need
(the config-schema hooks, the agent-facing tool vocabulary, `config-helpers`)
lives in `plugins/shared/`. See PLUGIN_CONTRACT.md §2 for the full tree.

- The active backend is resolved from `agent.backend` in `WORKFLOW.md` through
  the registry (`plugins/agents/registry.ts`).
- Built-in backends register statically in `plugins/agents/index.ts`.
  Registration is a side effect of importing that module; `config.ts` and
  `agent-runner.ts` both import it, so any code path that parses settings or
  starts a run sees a populated registry. Out-of-tree backends call
  `registerAgentBackend` from their own entry point. Dynamic loading (`import()`
  of arbitrary paths) is intentionally not provided.
- Resolution failures use stable error tags:
  - `missing_agent_backend` — `agent.backend` absent (in practice it defaults
    to `"codex"`, so this is reachable only through a null passed directly).
  - `unsupported_agent_backend` — kind not registered. Parsing still succeeds
    for unregistered kinds (the raw backend section passes through untouched);
    the failure surfaces from `config.validate()` before dispatch, mirroring
    the tracker `unsupported_tracker_kind` path.

### 2.1 Resolution timing — a deliberate divergence from the tracker contract

The tracker plugin is re-resolved from config on **every** facade call
(`tracker.kind` changes take effect without restart). An agent backend is
resolved **once at the start of a run and pinned for the whole run.** A session
is stateful — a live thread, cumulative token totals, an OS process — so
swapping backends mid-run would tear the session apart. This divergence is
registered in MIGRATION.md.

## 3. The normalized event envelope

A backend reports progress through a session-scoped `onMessage(message)`
callback. The message is a two-layer envelope (`plugins/agents/types.ts`):

### 3.1 Layer (a): the frozen event vocabulary

`AgentMessage.event` is a closed union — exactly the wrapped event names the
codex app-server client already emitted (SPEC §10.4), **frozen**:

```
session_started · startup_failed · turn_completed · turn_failed ·
turn_cancelled · turn_ended_with_error · turn_input_required ·
approval_required · approval_auto_approved · tool_input_auto_answered ·
tool_call_completed · tool_call_failed · unsupported_tool_call ·
notification · other_message · malformed
```

These names are persisted into orchestrator entries, the dashboard snapshot
fixtures, and SPEC §10.4. New backends MUST map their native protocol onto this
vocabulary; they MUST NOT introduce alternative event names (e.g. `needs_input`
instead of `turn_input_required`).

### 3.2 Layer (b): the raw payload

Beyond `event` and `timestamp`, the envelope carries neutral fields consumed by
the orchestrator/dashboard, plus a passthrough of the raw backend payload:

| Field | Requirement |
|---|---|
| `event`, `timestamp` | REQUIRED. |
| `sessionId` | SHOULD be set once known; also the ok-value of `runTurn`. |
| `backendPid` | OPTIONAL neutral process id. The codex adapter ALSO sets the frozen alias `codexAppServerPid`; the orchestrator reads `backendPid ?? codexAppServerPid`. |
| `usage` | OPTIONAL. **Cumulative absolute** token totals for the session (a flat `{input_tokens, output_tokens, total_tokens}`-shaped map). MUST be cumulative — the orchestrator diffs against the last reported totals, so emitting per-turn deltas double-counts. |
| `rate_limits` | OPTIONAL, dashboard-shaped (`{ limit_id, primary?, secondary?, credits? }`). |
| `payload` / `raw` | OPTIONAL raw backend payload / wire line, passed through untouched (the dashboard renders it). |
| extras | Any other keys pass through (`decision`, `answer`, `threadId`, ...). |

### 3.3 MUST clauses

- During `runTurn` a backend MUST emit `session_started`, and MUST terminate the
  turn with `turn_completed` (ok) or one of `turn_failed` / `turn_cancelled` /
  `turn_input_required` / `approval_required` (err; the err value carries the
  same-named `tag`).
- `turn_input_required` / `approval_required` are blocking outcomes, not
  retryable failures. A later generic `turn_ended_with_error` may be emitted for
  display, but it MUST NOT change the semantic blocker tag carried in the err or
  preceding event.
- Approval / user-input requests MUST NOT hang indefinitely: a backend either
  resolves them by policy (emitting `approval_auto_approved` /
  `tool_input_auto_answered`) or emits `approval_required` /
  `turn_input_required` and fails the turn.
- `usage` MUST be cumulative absolute totals (see §3.2). A backend that only
  receives per-turn increments MUST accumulate them itself.
- Unrecognized backend traffic MUST be forwarded as `notification` /
  `other_message` with the raw `payload`, never dropped (the dashboard depends
  on it).

## 4. Required session API

```ts
type AgentSessionApi = {
  startSession(workspace, opts?): Promise<Result<AgentSession, unknown>>;
  runTurn(session, prompt, context): Promise<Result<TurnResult, unknown>>;
  stopSession(session): void;
};
```

- `startSession(workspace, { workerHost?, onMessage?, toolProvider? })` — opens a
  session in `workspace`. `workerHost` selects an SSH host (null = local).
  `onMessage` is the session-scoped event stream (§3). `toolProvider` (§6) is the
  semantic tool surface, advertised where the protocol requires it. Returns an
  opaque `AgentSession` whose `handle` is plugin-private (core reads only the
  neutral `backendId` / `workspace` / `workerHost` / `backendPid` fields).
- `runTurn(session, prompt, { issue, turnNumber, maxTurns })` — runs one turn.
  The ok-value is `TurnResult` with a REQUIRED `sessionId` (orchestrator logging
  + snapshot) plus backend-specific extras.
- `stopSession(session)` — tears the session down (idempotent-friendly; called
  from a `finally`).

The runner starts one session per run for a multi-turn backend and one session
per turn for a single-turn backend (§5).

## 5. Optional capabilities

```ts
type AgentBackendCapabilities = {
  multiTurnSessions?: boolean; // false/absent => fresh session per turn
  remoteWorkers?: boolean;     // false/absent => remote run fails
  rateLimitTelemetry?: boolean;
};
type AgentUiCapability = { humanizeMessage?(message): string | null };
type ReplayCapability = { replayTranscript(serverMessages): Promise<unknown[]> };
```

| Capability | Contract |
|---|---|
| `capabilities.multiTurnSessions` | `true` → the runner keeps one session across all turns of a run and sends continuation guidance on turns after the first. `false`/absent → the runner starts a fresh session per turn and rebuilds the full prompt each time (there is no live thread to resume). |
| `capabilities.remoteWorkers` | `true` → `startSession` accepts a non-null `workerHost`. `false`/absent → the runner fails a remote run with `{ tag: "remote_workers_unsupported" }` before creating a workspace. |
| `capabilities.rateLimitTelemetry` | Advisory: the backend reports `rate_limits` in the envelope. |
| `ui.humanizeMessage` | One line of operator copy for a stored last-message value; returns `null` to fall back to the generic summarizer. The codex backend ships the historical `humanizeCodex*` logic verbatim. |
| `replay.replayTranscript` | The differential-oracle seam (`harness/assert-parity.ts`): given the backend→symphony messages, returns the symphony→backend messages the client emits. codex-only today. |

## 6. Tool bridging

The semantic tool surface is a `ToolProvider`:

```ts
type ToolProvider = {
  listSpecs(): AgentToolSpec[];
  execute(tool: string | null, args: unknown): Promise<AgentToolOutcome>;
};
```

`trackerToolProvider()` (`plugins/agents/tool-provider.ts`) builds one from the
active tracker plugin's `agentTools` capability: it re-resolves the tracker
plugin from WORKFLOW.md on each call, returns `[]` from `listSpecs()` when the
plugin has no agent tools, and returns
`{ success: false, payload: { error: { message, supportedTools } } }` for an
unknown tool. The **wire encoding of the outcome belongs to the backend**: the
codex adapter encodes it as codex `contentItems` (via
`codex/dynamic-tool.ts`'s `encodeToolOutcome`) and wraps the provider into an
`AppServer.ToolExecutor`; a future claude-code backend would encode the same
outcome as MCP `content` blocks with `isError = !success`.

## 7. Error model

Backend-originated errors are tagged plain objects (`{ tag, ... }`), consistent
with the repository convention. The runner logs and fails the run on any err;
the orchestrator, not the runner, decides recovery disposition.
Turn-terminating errors carry the tag matching their event (`turn_failed`,
`turn_cancelled`, `turn_input_required`, `approval_required`). Registry
resolution failures use the `AgentBackendError` shape (`{ tag, message,
detail? }`) with the `missing_agent_backend` / `unsupported_agent_backend` tags.
The runner adds `{ tag: "remote_workers_unsupported", backend, workerHost }`
for the capability guard.

Recovery classification:

- `blocked`: `turn_input_required`, `approval_required`, MCP elicitation,
  cancellation, config/permission errors, unsupported tools, and validation
  errors. The issue enters the blocked snapshot with original payload, prompt
  text when available, session id, and manual rerun metadata.
- `retryable`: explicit transient signals such as `turn_timeout`,
  `response_timeout`, `port_exit`, network disconnects, and HTTP 429/5xx.
  These use exponential backoff and are capped by `agent.max_retry_attempts`.
- `terminal`: retryable failures after the max retry count. The final reason is
  visible in the blocked snapshot and no retry timer remains.

Manual rerun metadata is only an operator affordance. Dashboard clients must ask
for explicit confirmation before posting the rerun action, and they must not
interpret it as external-tool approval or true thread resume.

SPEC §10.6's normalized categories (`codex_not_found`,
`invalid_workspace_cwd`, `response_timeout`, `turn_timeout`, `port_exit`,
`response_error`, ...) are RECOMMENDED tag names for the underlying failures.

## 8. Configuration contract

The core `agent` section owns `backend` (string, default `"codex"`) plus the
scheduling fields (`max_turns`, `max_concurrent_agents`, ...). **The backend's
own settings live in a top-level section named after the backend id** and flow
through the backend's `configSchema` (the same `PluginConfigSchema`
cast/finalize/validate shape as tracker plugins, `plugins/trackers/types.ts`):

```yaml
agent:
  backend: codex        # default; existing WORKFLOW.md files need no change
  max_turns: 20
codex:                  # the codex backend's section (typed in core, frozen)
  command: codex app-server
```

- `agent.backendConfig` holds the raw contents of that top-level section, cast
  and finalized by `agentBackendOrNull(backend)?.configSchema`. An unregistered
  kind or a backend without a schema passes the section through untouched
  (parse succeeds; `validate()` reports an unsupported backend), mirroring the
  tracker plugin section.
- `config.validate()` resolves `agent.backend` (must succeed) and runs the
  backend's `configSchema.validate` if present.
- **The codex backend deliberately omits `configSchema`.** Its `codex` section
  stays typed by core `schema.ts` (`settings.codex`, consumed through
  `codexRuntimeSettings()`), frozen for zero migration. `backendConfig` is the
  raw pass-through and is unused by the codex backend.

## 9. Test seams

| app-env key | Purpose |
|---|---|
| `agent_backend_overrides` | Map of kind → plugin; shadows registered backends for a test (mirrors `tracker_plugin_overrides`). |

`test/support/test-support.ts` clears it in `teardownWorkflow`, and its
`agent_backend` knob writes `agent.backend` into the generated WORKFLOW.md. Two
more seams support backend testing:

- **fake-backend** (`test/symphony/agent-runner-fake-backend.test.ts`): a
  synthetic `AgentBackendPlugin` injected through `agent_backend_overrides` —
  the direct proof the contract holds a second backend (continuation vs
  fresh-session semantics, the `remote_workers_unsupported` path, cumulative
  usage forwarding).
- **fake-codex** (`test/symphony/plugins/agents/codex-plugin.test.ts`): the
  line-scripted fake `codex app-server` binary from `app-server.test.ts`,
  reused to drive the codex adapter's full session API.
- **replay** (`harness/assert-parity.ts` + `test/fixtures/oracle/codex/`): the
  differential-oracle seam behind `replay.replayTranscript`.

## 10. Built-in backends (reference)

### 10.1 `codex`

The reference implementation (`plugins/agents/codex/`) wraps
`codex/app-server.ts` — the unchanged JSON-RPC 2.0 client (transport, session
lifecycle, approval auto-decisions, non-interactive tool-input answering,
workspace cwd validation, timeouts, replay) — behind the contract. The session
API forwards to `AppServer.{startSession, runTurn, stopSession}`; the
`ToolProvider` is encoded into an `AppServer.ToolExecutor`; app-server's wrapped
events are the normalized envelope (`normalizeCodexMessage` additively writes the
neutral `backendPid` alias and lifts codex rate limits onto the envelope, with
the orchestrator's payload sniffing kept as a fallback). Capabilities:
`multiTurnSessions`, `remoteWorkers`, `rateLimitTelemetry`, `ui.humanizeMessage`
(the historical `humanizeCodex*` logic, moved verbatim to
`plugins/agents/codex/humanize.ts`), and `replay`. It omits `configSchema` (§8).

### 10.2 `claude_code`

The second built-in (`plugins/agents/claude-code/`) drives the Claude Code CLI
as a long-lived stream-json subprocess
(`claude -p --input-format stream-json --output-format stream-json --verbose`) —
**not** the Agent SDK. It reuses the shared `plugins/agents/transport.ts`
`ProcessTransport` (line-framed JSON, structurally identical to codex) and guards
its workspace through the shared `workspace-guard.ts` core (SPEC §17), emitting
the `invalid_workspace_cwd` family for parity with codex.

- **Capabilities:** `multiTurnSessions` (the same process continues the
  conversation; a dead process could be rebuilt with `--resume <session_id>` as a
  SHOULD follow-up). `remoteWorkers` is **omitted** — v1 is local-only because the
  tool bridge is MCP-over-HTTP back to the symphony process and remote SSH
  reachability of the orchestrator is a separate concern; the runner's fail-fast
  `remote_workers_unsupported` guard handles a remote request. `rateLimitTelemetry`
  and `replay` are omitted (no CLI rate-limit analog — the dashboard renders n/a;
  the differential oracle stays codex-only).
- **Config (`configSchema` claims the top-level `claude_code:` section):**
  `command` (default `"claude"`, launched via `bash -lc`, cwd = workspace),
  `permission_mode` (`"bypass"` default → CLI `bypassPermissions` ≈ codex
  `approval_policy: never`; `"default"` → CLI default prompting), `model`
  (`--model`), `allowed_tools` / `disallowed_tools` (`--allowedTools` /
  `--disallowedTools`), `turn_timeout_ms` (turn stream budget),
  `read_timeout_ms` (startup/init wait). `permission_mode` defaults to `"bypass"`
  because a non-interactive orchestrator has no operator to answer prompts;
  `validate` rejects any other value.
- **Event mapping (onto the frozen vocabulary §3.1):** `{type:"system",
  subtype:"init", session_id}` → `session_started`; `{type:"result",
  subtype:"success"}` → `turn_completed` (+ `usage`); `subtype=error_*` /
  `is_error` → `turn_failed`; `assistant` / `user` / other stream lines →
  `notification` (raw payload passthrough); MCP tool calls →
  `tool_call_completed` / `tool_call_failed` / `unsupported_tool_call` from the
  bridge handler; a `{`-leading line that fails JSON decode → `malformed`. The
  envelope carries `backendPid` (never the frozen codex alias
  `codexAppServerPid`) and a session-derived `sessionId` of
  `${session_id}-${turnNumber}` (the CLI session_id is constant across turns, so
  the derived id keeps the orchestrator's turn counter advancing).
- **usage (§3.2 MUST):** `result.usage` was verified live to be **per-turn**
  (`input_tokens` / `output_tokens`, snake_case, no `total_tokens`), so the
  plugin accumulates it into cumulative absolute totals and derives
  `total_tokens = input + output`.
- **Approval (§3.3 MUST, must not hang):** `permission_mode: "bypass"` maps to
  the CLI's full-auto mode (no approval events). `permission_mode: "default"`
  fails the turn: a non-empty `result.permission_denials` (a tool the headless
  CLI could not auto-approve) is surfaced as `approval_required` +
  `err({tag:"approval_required"})`. The observed CLI version has no
  `--permission-prompt-tool`, so result-detection is the chosen mechanism.
- **Tool bridge (§6):** `mcp-server.ts` serves the injected `ToolProvider` as a
  localhost-only streamable HTTP MCP server named `symphony` (registered via
  `--mcp-config`), encoding each outcome as MCP `content: [{type:"text", text}]`
  with `isError = !success`. It holds the injected provider directly, so it does
  not reproduce the codex adapter's registered contract gap.

## 11. Writing a new backend (checklist)

Using the planned Claude Code CLI backend as the running example (driven by
`claude -p --input-format stream-json --output-format stream-json --verbose` as a
long-lived line-framed JSON subprocess — **not** the Agent SDK). Each face of the
contract has a natural landing point on this second backend; that is the design
check the contract was built against.

1. **Model the process.** A long-lived line-framed JSON subprocess, structurally
   the same as codex's `ProcessTransport`; the SSH remote path comes for free, so
   `capabilities.remoteWorkers: true`.
2. **Map the session.** `system/init`'s `session_id` → the envelope `sessionId`
   and `TurnResult.sessionId`. `runTurn` writes one
   `{ type: "user", message: { role: "user", content: prompt } }` and reads the
   stream to `result`. Same-process continuation → `capabilities.multiTurnSessions:
   true` (a dead process can be rebuilt with `--resume <session_id>`).
3. **Map events onto the frozen vocabulary (§3.1).** `system/init` →
   `session_started`; `result subtype=success` → `turn_completed` + `usage`
   (`result.usage` is a session-cumulative map, matching the envelope semantics);
   `subtype=error_*` → `turn_failed`; `assistant`/`user` stream events →
   `notification` + payload passthrough.
4. **Resolve permissions without hanging (§3.3).** A permission prompt →
   auto-approve by policy (`approval_auto_approved`) or `approval_required` + fail
   the turn (`--permission-mode bypassPermissions` ≈ codex `approval_policy:
   never`).
5. **Bridge tools (§6).** Wrap the `ToolProvider` as an `--mcp-config` subprocess
   bridge, encoding each outcome as MCP `content: [{ type: "text", text }]` with
   `isError = !success`.
6. **Pick capabilities honestly.** No rate-limit / pid analog → leave
   `rate_limits` / `backendPid` unset (the dashboard already renders "n/a" for
   missing values). Ship `ui.humanizeMessage` for the CLI's own event shapes.
7. **Add a `configSchema`** claiming the backend's top-level section (e.g.
   `claude_code:`), using the shared `plugins/shared/config-helpers.ts`.
8. **Register** in `plugins/agents/index.ts` (in-tree) or via
   `registerAgentBackend` (out-of-tree), and add a fake-CLI script test
   (stream-json dialogue, the claude-code twin of fake-codex).

## 12. Relationship to other documents

- **SPEC.md** — unchanged. §10 already declares the integration
  protocol-neutral; §10.4's event list is the frozen vocabulary this contract
  layers packaging (registry, capabilities, config delegation, error shape) on
  top of. A future SPEC revision may fold this contract into §10.
- **PLUGIN_CONTRACT.md** — the tracker plugin contract; this document is its
  sibling and mirrors its structure. The tracker plugin's `agentTools`
  capability feeds this contract's `ToolProvider` (§6).
- **typescript/MIGRATION.md** — "Post-cutover divergence" records where this
  architecture departs from the pre-plugin behavior (the run-level backend pin,
  the `codex_*` wire names now meaning "agent backend"); anything not listed
  there is behavior-compatible.
