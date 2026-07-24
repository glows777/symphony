// Agent backend plugin contract. Post-cutover TS-native design (no Elixir
// counterpart; see MIGRATION.md -> Post-cutover divergence).
//
// Mirrors the tracker plugin design (plugins/types.ts): the session API is
// required — it drives a single issue's agent run — and everything else is an
// optional capability. A backend for an agent without a native feature simply
// omits the capability and the runner degrades (a fresh session per turn when
// multi-turn continuation is unsupported, a structured error for remote
// workers, ...). See docs/AGENT_PLUGIN_CONTRACT.md.

import type { JsonMap } from "../../config/schema.ts";
import type { Result } from "../../result.ts";
import type { AgentToolOutcome, AgentToolSpec, PluginConfigSchema } from "../types.ts";

// ---- normalized event envelope ----------------------------------------------

// Layer (a): the closed vocabulary every backend must emit. Exactly the strings
// app-server.ts emits today (SPEC §10.4); renaming breaks persisted orchestrator
// entries and dashboard snapshot fixtures. FROZEN — see the handoff decision to
// keep the wrapped event names as the normalized layer.
export type AgentEventName =
  | "session_started"
  | "startup_failed"
  | "turn_completed"
  | "turn_failed"
  | "turn_cancelled"
  | "turn_ended_with_error"
  | "turn_input_required" // "needs input" — orchestrator blocks the issue
  | "approval_required" // orchestrator blocks the issue
  | "approval_auto_approved"
  | "tool_input_auto_answered"
  | "tool_call_completed"
  | "tool_call_failed"
  | "unsupported_tool_call"
  | "notification" // raw backend traffic, payload passthrough
  | "other_message"
  | "malformed";

// Layer (b): the raw payload preserved for presentation. A structural superset
// of today's AppServerMessage, so the existing orchestrator/dashboard consumers
// keep working unchanged.
export type AgentMessage = {
  event: AgentEventName;
  timestamp: Date;
  sessionId?: string;
  // Neutral name; the codex adapter ALSO sets the frozen legacy alias
  // `codexAppServerPid` (through the index signature) so orchestrator/snapshot
  // wire names stay stable.
  backendPid?: string;
  workerHost?: string;
  // Cumulative absolute token totals for the session. MUST be cumulative —
  // the orchestrator's computeTokenDelta diffs against the last reported totals.
  usage?: JsonMap;
  // Dashboard-shaped rate limits: { limit_id, primary?, secondary?, credits? }.
  rate_limits?: JsonMap;
  payload?: unknown; // raw backend payload, passed through untouched
  raw?: string; // raw wire line when applicable
  [key: string]: unknown; // backend extras (decision, answer, threadId, ...)
};

export type OnAgentMessage = (message: AgentMessage) => void;

// ---- tool bridging -----------------------------------------------------------

// The semantic tool surface handed to the backend at session start. Specs come
// from the active tracker plugin's agentTools capability; wire mechanics
// (dynamicTools + item/tool/call for codex; an in-process MCP bridge for a
// future claude-code plugin) and outcome encoding belong to the plugin.
export type ToolProvider = {
  listSpecs(): AgentToolSpec[];
  execute(tool: string | null, args: unknown): Promise<AgentToolOutcome>;
};

// ---- session API ------------------------------------------------------------

export type IssueLike = {
  id?: string | null;
  identifier?: string | null;
  title?: string | null;
};

export type StartSessionOpts = {
  workerHost?: string | null; // SSH host; null = local
  onMessage?: OnAgentMessage; // session-scoped event stream
  toolProvider?: ToolProvider; // advertised at session start where the protocol requires it
};

export type TurnContext = {
  issue: IssueLike; // titles + log context
  turnNumber: number;
  maxTurns: number;
};

// Opaque session handle. `handle` is plugin-private (the codex adapter stores
// its AppServer.Session there); core code only reads the neutral fields.
export type AgentSession = {
  backendId: string;
  workspace: string;
  workerHost: string | null;
  backendPid?: string;
  handle: unknown;
};

// ok-value of runTurn. `sessionId` is required (orchestrator logging + snapshot);
// extras are backend-specific and passed through.
export type TurnResult = { sessionId: string; [key: string]: unknown };

export type AgentSessionApi = {
  startSession(workspace: string, opts?: StartSessionOpts): Promise<Result<AgentSession, unknown>>;
  runTurn(
    session: AgentSession,
    prompt: string,
    context: TurnContext,
  ): Promise<Result<TurnResult, unknown>>;
  stopSession(session: AgentSession): void;
};

// ---- optional capabilities --------------------------------------------------

export type AgentUiCapability = {
  // Presentation hook (like tracker ui): one line of operator copy for a stored
  // last-message value; null falls back to the generic summarizer. The codex
  // plugin ships today's humanize* logic verbatim (P3).
  humanizeMessage?(message: unknown): string | null;
};

export type AgentBackendCapabilities = {
  // Same-session continuation turns. false/absent => the runner starts a fresh
  // session per turn and rebuilds the full prompt each time.
  multiTurnSessions?: boolean;
  // Remote execution over worker.ssh_hosts. false/absent => startSession with a
  // non-null workerHost fails with { tag: "remote_workers_unsupported" }.
  remoteWorkers?: boolean;
  // Backend reports rate limits in the envelope.
  rateLimitTelemetry?: boolean;
};

// Differential-oracle seam (harness/assert-parity.ts); codex-only today.
export type ReplayCapability = {
  replayTranscript(serverMessages: unknown[]): Promise<unknown[]>;
};

// ---- error model ------------------------------------------------------------

// Resolution failures from the registry. Stable machine `tag`, operator-facing
// `message`; `detail` carries the offending value untouched. Tagged plain
// object per repo convention (mirrors TrackerError without the normalized
// `code` taxonomy, which is tracker-specific).
export type AgentBackendError = {
  tag: string;
  message: string;
  detail?: unknown;
};

// ---- plugin -----------------------------------------------------------------

export type AgentBackendPlugin = {
  id: string; // matches `agent.backend` in WORKFLOW.md ("codex", "claude_code")
  displayName: string;
  // Casts the plugin's private top-level WORKFLOW.md section (named after the
  // plugin id). The codex plugin OMITS this: its `codex` section stays typed in
  // core schema.ts, frozen for zero-migration.
  configSchema?: PluginConfigSchema;

  sessions: AgentSessionApi; // REQUIRED core

  capabilities?: AgentBackendCapabilities;
  ui?: AgentUiCapability;
  replay?: ReplayCapability;
};
