// Literal port of `symphony_elixir/agent_runner.ex`, generalized post-cutover to
// the agent backend plugin surface (see MIGRATION.md -> Post-cutover
// divergence).
//
// Executes a single issue in its workspace with the configured agent backend.
// The backend is resolved once at run start and pinned for the whole run —
// sessions are stateful, so swapping backends mid-run would tear a session
// apart. The Elixir `send(pid, tuple)` recipient becomes a callback invoked with
// tagged updates.

// Side-effect import: built-in agent backends must be registered before a run
// resolves `agent.backend` (mirrors the tracker plugins/index.ts guarantee).
import "./plugins/agents/index.ts";

import { settingsBang } from "./config.ts";
import { logger } from "./logger.ts";
import { agentBackend } from "./plugins/agents/registry.ts";
import { trackerToolProvider } from "./plugins/agents/tool-provider.ts";
import type {
  AgentBackendPlugin,
  AgentMessage,
  AgentSession,
  OnAgentMessage,
  ToolProvider,
} from "./plugins/agents/types.ts";
import { trackerPluginOrNull } from "./plugins/registry.ts";
import { type Issue, routable } from "./plugins/work-item.ts";
import { buildPrompt } from "./prompt-builder.ts";
import { type Result, err, ok } from "./result.ts";
import * as Tracker from "./tracker/tracker.ts";
import * as Workspace from "./workspace.ts";

export type WorkerUpdate =
  | { tag: "codex_worker_update"; issueId: string; message: AgentMessage }
  | {
      tag: "worker_runtime_info";
      issueId: string;
      info: { workerHost: string | null; workspacePath: string };
    };

export type UpdateRecipient = ((update: WorkerUpdate) => void) | null;

export type IssueStateFetcher = (
  ids: string[],
) => Result<Issue[], unknown> | Promise<Result<Issue[], unknown>>;

export type RunOpts = {
  workerHost?: string | null;
  maxTurns?: number;
  issueStateFetcher?: IssueStateFetcher;
  attempt?: number | null;
};

type ContinueOutcome =
  | { kind: "continue"; issue: Issue }
  | { kind: "done"; issue: Issue }
  | { kind: "error"; reason: unknown };

export function continueWithIssueForTest(
  issue: Issue,
  issueStateFetcher: IssueStateFetcher,
): Promise<ContinueOutcome> {
  return continueWithIssue(issue, issueStateFetcher);
}

export async function run(
  issue: Issue,
  recipient: UpdateRecipient = null,
  opts: RunOpts = {},
): Promise<void> {
  // Resolve and pin the backend for the whole run (sessions are stateful).
  const backend = agentBackend(settingsBang().agent.backend);
  if (!backend.ok) {
    logger.error(`Agent run failed for ${issueContext(issue)}: ${inspect(backend.error)}`);
    throw new Error(`Agent run failed for ${issueContext(issue)}: ${inspect(backend.error)}`);
  }

  const workerHost = selectedWorkerHost(opts.workerHost ?? null, settingsBang().worker.sshHosts);
  // Capability guard: a backend that does not declare remoteWorkers cannot run
  // over worker.ssh_hosts. Fail before any workspace/SSH work.
  if (workerHost !== null && backend.value.capabilities?.remoteWorkers !== true) {
    const error = { tag: "remote_workers_unsupported", backend: backend.value.id, workerHost };
    logger.error(`Agent run failed for ${issueContext(issue)}: ${inspect(error)}`);
    throw new Error(`Agent run failed for ${issueContext(issue)}: ${inspect(error)}`);
  }
  logger.info(
    `Starting agent run for ${issueContext(issue)} worker_host=${workerHostForLog(workerHost)}`,
  );

  const result = await runOnWorkerHost(issue, recipient, opts, workerHost, backend.value);
  if (!result.ok) {
    logger.error(`Agent run failed for ${issueContext(issue)}: ${inspect(result.error)}`);
    throw new Error(`Agent run failed for ${issueContext(issue)}: ${inspect(result.error)}`);
  }
}

async function runOnWorkerHost(
  issue: Issue,
  recipient: UpdateRecipient,
  opts: RunOpts,
  workerHost: string | null,
  backend: AgentBackendPlugin,
): Promise<Result<undefined, unknown>> {
  logger.info(
    `Starting worker attempt for ${issueContext(issue)} worker_host=${workerHostForLog(workerHost)}`,
  );

  const created = Workspace.createForIssue(issue, workerHost);
  if (!created.ok) {
    return err(created.error);
  }
  const workspace = created.value;
  sendWorkerRuntimeInfo(recipient, issue, workerHost, workspace);

  try {
    const beforeRun = Workspace.runBeforeRunHook(workspace, issue, workerHost);
    if (!beforeRun.ok) {
      return err(beforeRun.error);
    }
    return await runAgentTurns(workspace, issue, recipient, opts, workerHost, backend);
  } finally {
    Workspace.runAfterRunHook(workspace, issue, workerHost);
  }
}

function agentMessageHandler(recipient: UpdateRecipient, issue: Issue): OnAgentMessage {
  return (message) => sendAgentUpdate(recipient, issue, message);
}

function sendAgentUpdate(recipient: UpdateRecipient, issue: Issue, message: AgentMessage): void {
  // Wire tag frozen as `codex_worker_update` (orchestrator entry, JSON-API,
  // dashboard snapshot) — a historical name, now semantically "agent backend".
  if (typeof issue.id === "string" && typeof recipient === "function") {
    recipient({ tag: "codex_worker_update", issueId: issue.id, message });
  }
}

function sendWorkerRuntimeInfo(
  recipient: UpdateRecipient,
  issue: Issue,
  workerHost: string | null,
  workspace: string,
): void {
  if (typeof issue.id === "string" && typeof recipient === "function") {
    recipient({
      tag: "worker_runtime_info",
      issueId: issue.id,
      info: { workerHost, workspacePath: workspace },
    });
  }
}

async function runAgentTurns(
  workspace: string,
  issue: Issue,
  recipient: UpdateRecipient,
  opts: RunOpts,
  workerHost: string | null,
  backend: AgentBackendPlugin,
): Promise<Result<undefined, unknown>> {
  const maxTurns = opts.maxTurns ?? settingsBang().agent.maxTurns;
  const issueStateFetcher: IssueStateFetcher =
    opts.issueStateFetcher ?? ((ids) => Tracker.fetchIssueStatesByIds(ids));
  const toolProvider = trackerToolProvider();

  if (backend.capabilities?.multiTurnSessions === true) {
    return runMultiTurnSession(
      backend,
      workspace,
      issue,
      recipient,
      opts,
      workerHost,
      toolProvider,
      issueStateFetcher,
      maxTurns,
    );
  }
  return runFreshSessionTurns(
    backend,
    workspace,
    issue,
    recipient,
    opts,
    workerHost,
    toolProvider,
    issueStateFetcher,
    1,
    maxTurns,
  );
}

// Multi-turn backend (codex): one session spans the whole run, continuation
// turns reuse the live thread with continuation guidance instead of the full
// prompt.
async function runMultiTurnSession(
  backend: AgentBackendPlugin,
  workspace: string,
  issue: Issue,
  recipient: UpdateRecipient,
  opts: RunOpts,
  workerHost: string | null,
  toolProvider: ToolProvider,
  issueStateFetcher: IssueStateFetcher,
  maxTurns: number,
): Promise<Result<undefined, unknown>> {
  const session = await backend.sessions.startSession(workspace, {
    workerHost,
    onMessage: agentMessageHandler(recipient, issue),
    toolProvider,
  });
  if (!session.ok) {
    return err(session.error);
  }
  try {
    return await doRunMultiTurn(
      backend,
      session.value,
      workspace,
      issue,
      opts,
      issueStateFetcher,
      1,
      maxTurns,
    );
  } finally {
    backend.sessions.stopSession(session.value);
  }
}

async function doRunMultiTurn(
  backend: AgentBackendPlugin,
  session: AgentSession,
  workspace: string,
  issue: Issue,
  opts: RunOpts,
  issueStateFetcher: IssueStateFetcher,
  turnNumber: number,
  maxTurns: number,
): Promise<Result<undefined, unknown>> {
  const prompt = buildContinuationTurnPrompt(issue, opts, turnNumber, maxTurns);

  const turn = await backend.sessions.runTurn(session, prompt, { issue, turnNumber, maxTurns });
  if (!turn.ok) {
    return err(turn.error);
  }
  logger.info(
    `Completed agent run for ${issueContext(issue)} session_id=${turn.value.sessionId} workspace=${workspace} turn=${turnNumber}/${maxTurns}`,
  );

  const outcome = await continueWithIssue(issue, issueStateFetcher);
  if (outcome.kind === "error") {
    return err(outcome.reason);
  }
  if (outcome.kind === "done") {
    return ok(undefined);
  }
  if (turnNumber < maxTurns) {
    logger.info(
      `Continuing agent run for ${issueContext(outcome.issue)} after normal turn completion turn=${turnNumber}/${maxTurns}`,
    );
    return doRunMultiTurn(
      backend,
      session,
      workspace,
      outcome.issue,
      opts,
      issueStateFetcher,
      turnNumber + 1,
      maxTurns,
    );
  }
  logger.info(
    `Reached agent.max_turns for ${issueContext(outcome.issue)} with issue still active; returning control to orchestrator`,
  );
  return ok(undefined);
}

// Single-turn backend fallback: a fresh session per turn, each rebuilt from the
// full prompt (no live thread to resume, so continuation guidance would be a
// lie).
async function runFreshSessionTurns(
  backend: AgentBackendPlugin,
  workspace: string,
  issue: Issue,
  recipient: UpdateRecipient,
  opts: RunOpts,
  workerHost: string | null,
  toolProvider: ToolProvider,
  issueStateFetcher: IssueStateFetcher,
  turnNumber: number,
  maxTurns: number,
): Promise<Result<undefined, unknown>> {
  // Build the prompt before opening a session: a Liquid render error here must
  // not leak a started session (runSingleFreshTurn's finally only covers the
  // turn itself).
  const prompt = buildFullPrompt(issue, opts);
  const session = await backend.sessions.startSession(workspace, {
    workerHost,
    onMessage: agentMessageHandler(recipient, issue),
    toolProvider,
  });
  if (!session.ok) {
    return err(session.error);
  }
  const turn = await runSingleFreshTurn(
    backend,
    session.value,
    prompt,
    issue,
    turnNumber,
    maxTurns,
  );
  if (!turn.ok) {
    return err(turn.error);
  }
  logger.info(
    `Completed agent run for ${issueContext(issue)} session_id=${turn.value.sessionId} workspace=${workspace} turn=${turnNumber}/${maxTurns}`,
  );

  const outcome = await continueWithIssue(issue, issueStateFetcher);
  if (outcome.kind === "error") {
    return err(outcome.reason);
  }
  if (outcome.kind === "done") {
    return ok(undefined);
  }
  if (turnNumber < maxTurns) {
    logger.info(
      `Continuing agent run for ${issueContext(outcome.issue)} after normal turn completion turn=${turnNumber}/${maxTurns}`,
    );
    return runFreshSessionTurns(
      backend,
      workspace,
      outcome.issue,
      recipient,
      opts,
      workerHost,
      toolProvider,
      issueStateFetcher,
      turnNumber + 1,
      maxTurns,
    );
  }
  logger.info(
    `Reached agent.max_turns for ${issueContext(outcome.issue)} with issue still active; returning control to orchestrator`,
  );
  return ok(undefined);
}

async function runSingleFreshTurn(
  backend: AgentBackendPlugin,
  session: AgentSession,
  prompt: string,
  issue: Issue,
  turnNumber: number,
  maxTurns: number,
): Promise<Result<{ sessionId: string; [key: string]: unknown }, unknown>> {
  try {
    return await backend.sessions.runTurn(session, prompt, { issue, turnNumber, maxTurns });
  } finally {
    backend.sessions.stopSession(session);
  }
}

function buildFullPrompt(issue: Issue, opts: RunOpts): string {
  return buildPrompt(issue, { attempt: opts.attempt ?? null });
}

function buildContinuationTurnPrompt(
  issue: Issue,
  opts: RunOpts,
  turnNumber: number,
  maxTurns: number,
): string {
  if (turnNumber === 1) {
    return buildFullPrompt(issue, opts);
  }
  return `Continuation guidance:

- The previous Codex turn completed normally, but the ${workItemNoun()} is still in an active state.
- This is continuation turn #${turnNumber} of ${maxTurns} for the current agent run.
- Resume from the current workspace and workpad state instead of restarting from scratch.
- The original task instructions and prior turn context are already present in this thread, so do not restate them before acting.
- Focus on the remaining ticket work and do not end the turn while the issue stays active unless you are truly blocked.
`;
}

async function continueWithIssue(
  issue: Issue,
  issueStateFetcher: IssueStateFetcher,
): Promise<ContinueOutcome> {
  if (typeof issue.id !== "string") {
    return { kind: "done", issue };
  }
  const result = await issueStateFetcher([issue.id]);
  if (!result.ok) {
    return { kind: "error", reason: { tag: "issue_state_refresh_failed", reason: result.error } };
  }
  const refreshed = result.value[0];
  if (refreshed === undefined) {
    return { kind: "done", issue };
  }
  if (activeIssueState(refreshed.state) && issueRoutable(refreshed)) {
    return { kind: "continue", issue: refreshed };
  }
  return { kind: "done", issue: refreshed };
}

// Noun used in agent-facing copy, contributed by the active plugin
// ("Linear issue"); provider-neutral fallback otherwise.
function workItemNoun(): string {
  return trackerPluginOrNull(settingsBang().tracker.kind)?.ui?.workItemNoun ?? "work item";
}

function activeIssueState(stateName: unknown): boolean {
  if (typeof stateName !== "string") {
    return false;
  }
  const normalized = normalizeIssueState(stateName);
  return settingsBang().tracker.activeStates.some(
    (active) => normalizeIssueState(active) === normalized,
  );
}

function issueRoutable(issue: Issue): boolean {
  return routable(issue, settingsBang().tracker.requiredLabels);
}

function selectedWorkerHost(
  preferredHost: string | null,
  configuredHosts: string[],
): string | null {
  const hosts = [...new Set(configuredHosts.map((h) => h.trim()).filter((h) => h !== ""))];
  if (typeof preferredHost === "string" && preferredHost !== "") {
    return preferredHost;
  }
  return hosts.length === 0 ? null : (hosts[0] ?? null);
}

function workerHostForLog(workerHost: string | null): string {
  return workerHost === null ? "local" : workerHost;
}

function normalizeIssueState(stateName: string): string {
  return stateName.trim().toLowerCase();
}

function issueContext(issue: Issue): string {
  return `issue_id=${issue.id} issue_identifier=${issue.identifier}`;
}

function inspect(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
