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
it does not switch on backend-specific tags. Turn-terminating errors carry the
tag matching their event (`turn_failed`, `turn_cancelled`,
`turn_input_required`, `approval_required`). Registry resolution failures use
the `AgentBackendError` shape (`{ tag, message, detail? }`) with the
`missing_agent_backend` / `unsupported_agent_backend` tags. The runner adds
`{ tag: "remote_workers_unsupported", backend, workerHost }` for the capability
guard. SPEC §10.6's normalized categories (`codex_not_found`,
`invalid_workspace_cwd`, `response_timeout`, `turn_timeout`, `port_exit`,
`response_error`, ...) are RECOMMENDED tag names for the underlying failures.

## 8. Configuration contract

The core `agent` section owns `backend` (string, default `"codex"`) plus the
scheduling fields (`max_turns`, `max_concurrent_agents`, ...). **The backend's
own settings live in a top-level section named after the backend id** and flow
through the backend's `configSchema` (the same `PluginConfigSchema`
cast/finalize/validate shape as tracker plugins, `plugins/types.ts`):

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
   `claude_code:`), using the shared `plugins/config-helpers.ts`.
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
