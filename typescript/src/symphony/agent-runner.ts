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
// resolves `agent.backend` (mirrors the tracker plugins/trackers/index.ts guarantee).
import "./plugins/agents/index.ts";

import { type AgentOutputRun, getAgentOutputStore } from "./agent-output-store.ts";
import { settingsBang } from "./config.ts";
import type { JsonMap } from "./config/schema.ts";
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
import { trackerPluginOrNull } from "./plugins/trackers/registry.ts";
import { buildPrompt } from "./prompt-builder.ts";
import { type Result, err, ok } from "./result.ts";
import {
  type ReviewContext,
  type ReviewProviderOptions,
  fetchReviewContext,
  finalizeReviewRun,
  isReviewTriggered,
  mergePersistedHandoff,
} from "./review-context.ts";
import * as Tracker from "./tracker/tracker.ts";
import { type Issue, routable } from "./work-item.ts";
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
  // Cooperative cancellation. Elixir's `Task.Supervisor.terminate_child` kills
  // the worker process outright; here the orchestrator aborts this signal and
  // the runner stops the backend session, which tears down its subprocess.
  signal?: AbortSignal;
  // Review context is injectable for offline tests. Production review runs
  // resolve it from the explicit `symphony-review` label before a workspace
  // or backend session is started.
  reviewContext?: ReviewContext | null;
  reviewProviderOptions?: ReviewProviderOptions;
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
  const review = await resolveReviewContext(issue, opts);
  if (!review.ok) {
    throw review.error;
  }

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

  const result = await runOnWorkerHost(
    issue,
    recipient,
    opts,
    workerHost,
    backend.value,
    review.value,
  );
  if (!result.ok) {
    logger.error(`Agent run failed for ${issueContext(issue)}: ${inspect(result.error)}`);
    if (isReviewFailure(result.error)) {
      throw result.error;
    }
    throw new Error(`Agent run failed for ${issueContext(issue)}: ${inspect(result.error)}`);
  }
}

async function runOnWorkerHost(
  issue: Issue,
  recipient: UpdateRecipient,
  opts: RunOpts,
  workerHost: string | null,
  backend: AgentBackendPlugin,
  reviewContext: ReviewContext | null,
): Promise<Result<undefined, unknown>> {
  logger.info(
    `Starting worker attempt for ${issueContext(issue)} worker_host=${workerHostForLog(workerHost)}`,
  );

  const output = getAgentOutputStore().startRun({
    issueId: issue.id,
    issueIdentifier: issue.identifier ?? "unknown-issue",
    title: issue.title,
    backend: backend.id,
    workerHost,
  });
  const created = Workspace.createForIssue(issue, workerHost);
  if (!created.ok) {
    await output.finish("failed", created.error);
    return err(created.error);
  }
  const workspace = created.value;
  sendWorkerRuntimeInfo(recipient, issue, workerHost, workspace);

  try {
    const beforeRun = Workspace.runBeforeRunHook(workspace, issue, workerHost);
    if (!beforeRun.ok) {
      await output.finish("failed", beforeRun.error);
      return err(beforeRun.error);
    }
    const promptReviewContext =
      reviewContext === null
        ? null
        : mergePersistedHandoff(reviewContext, workspace, { workerHost });
    const result = await runAgentTurns(
      workspace,
      issue,
      recipient,
      opts,
      workerHost,
      backend,
      output,
      promptReviewContext,
    );
    if (result.ok && reviewContext !== null && !isAborted(opts.signal ?? null)) {
      const verification = Workspace.runVerificationCommand(
        workspace,
        settingsBang().review.verificationCommand,
        workerHost,
      );
      if (!verification.ok) {
        const verificationError = {
          tag: "review_verification_failed",
          message: "Unable to execute the configured review verification command",
          detail: verification.error,
        };
        await output.finish("failed", verificationError);
        return err(verificationError);
      }
      const gated = await finalizeReviewRun(issue, reviewContext, workspace, {
        ...opts.reviewProviderOptions,
        workerHost,
        verificationReceipt:
          verification.value === null
            ? null
            : {
                headSha: verification.value.headSha,
                command: verification.value.command,
                exitCode: verification.value.exitCode,
              },
        ...(opts.issueStateFetcher === undefined
          ? {}
          : { issueStateFetcher: opts.issueStateFetcher }),
      });
      if (!gated.ok) {
        await output.finish("failed", gated.error);
        return err(gated.error);
      }
      if (gated.value.status === "incomplete") {
        const incomplete = {
          tag: "review_incomplete",
          message: "Review findings remain incomplete or require a human decision",
          detail: { openFindingIds: gated.value.openFindingIds },
        };
        await output.finish("failed", incomplete);
        return err(incomplete);
      }
    }
    await output.finish(
      opts.signal?.aborted === true ? "cancelled" : result.ok ? "completed" : "failed",
      result.ok ? null : result.error,
    );
    return result;
  } catch (error) {
    await output.finish(opts.signal?.aborted === true ? "cancelled" : "failed", error);
    throw error;
  } finally {
    Workspace.runAfterRunHook(workspace, issue, workerHost);
  }
}

function agentMessageHandler(
  recipient: UpdateRecipient,
  issue: Issue,
  backend: AgentBackendPlugin,
  output: AgentOutputRun,
  turn: () => number,
  transform: (message: AgentMessage) => AgentMessage = (message) => message,
): OnAgentMessage {
  return (message) => {
    const normalized = transform(message);
    let summary: string | null = null;
    try {
      summary = backend.ui?.humanizeMessage?.(normalized) ?? null;
    } catch (error) {
      logger.warning(`Agent output summary failed for ${issueContext(issue)}: ${inspect(error)}`);
    }
    output.record(normalized, turn(), summary);
    sendAgentUpdate(recipient, issue, normalized);
  };
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
  output: AgentOutputRun,
  reviewContext: ReviewContext | null,
): Promise<Result<undefined, unknown>> {
  const maxTurns = reviewContext === null ? (opts.maxTurns ?? settingsBang().agent.maxTurns) : 1;
  const issueStateFetcher: IssueStateFetcher =
    opts.issueStateFetcher ?? ((ids) => Tracker.fetchIssueStatesByIds(ids));
  const toolProvider = trackerToolProvider({ reviewStateGate: reviewContext !== null });

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
      output,
      reviewContext,
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
    freshSessionUsageRebaser(),
    1,
    maxTurns,
    output,
    reviewContext,
  );
}

// The contract defines envelope `usage` as cumulative within one session, but
// the fresh-session fallback opens a new session per turn, so a conforming
// backend's counters restart at zero each turn. The orchestrator's
// last-reported token baselines span the whole run and swallow totals below
// the previous session's peak, so rebase each session's usage onto the peaks
// of the finished sessions: the orchestrator then sees monotonic,
// run-cumulative totals.
type FreshSessionUsageRebaser = {
  rebase(message: AgentMessage): AgentMessage;
  // Folds the finished session's peaks into the offsets; call between sessions.
  rollover(): void;
};

function freshSessionUsageRebaser(): FreshSessionUsageRebaser {
  const offsets = new Map<string, number>();
  const peaks = new Map<string, number>();
  return {
    rebase(message: AgentMessage): AgentMessage {
      const usage = message.usage;
      if (usage === undefined) {
        return message;
      }
      const adjusted: JsonMap = {};
      for (const [key, value] of Object.entries(usage)) {
        if (typeof value === "number" && Number.isFinite(value)) {
          peaks.set(key, Math.max(peaks.get(key) ?? 0, value));
          adjusted[key] = (offsets.get(key) ?? 0) + value;
        } else {
          adjusted[key] = value;
        }
      }
      return { ...message, usage: adjusted };
    },
    rollover(): void {
      for (const [key, peak] of peaks) {
        offsets.set(key, (offsets.get(key) ?? 0) + peak);
      }
      peaks.clear();
    },
  };
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
  output: AgentOutputRun,
  reviewContext: ReviewContext | null,
): Promise<Result<undefined, unknown>> {
  const signal = opts.signal ?? null;
  if (isAborted(signal)) {
    return err({ tag: "aborted" });
  }
  const currentTurn = { value: 0 };
  const session = await backend.sessions.startSession(workspace, {
    workerHost,
    onMessage: agentMessageHandler(recipient, issue, backend, output, () => currentTurn.value),
    toolProvider,
  });
  if (!session.ok) {
    return err(session.error);
  }
  output.bindRunId(session.value.runId);
  const detach = onAbort(signal, () => backend.sessions.stopSession(session.value));
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
      output,
      currentTurn,
      reviewContext,
    );
  } finally {
    detach();
    backend.sessions.stopSession(session.value);
  }
}

// `AbortSignal.aborted` flips while a turn is in flight, but TypeScript's
// control-flow analysis treats a property read as invariant and narrows later
// checks to `false`. Reading it through a call keeps every check honest.
function isAborted(signal: AbortSignal | null): boolean {
  return signal?.aborted === true;
}

// Stops the live session as soon as the signal aborts (and immediately if it
// already has, closing the race between startSession and an abort). Returns a
// detach function for the happy path.
function onAbort(signal: AbortSignal | null, stop: () => void): () => void {
  if (signal === null) {
    return () => {};
  }
  if (signal.aborted) {
    stop();
    return () => {};
  }
  signal.addEventListener("abort", stop, { once: true });
  return () => signal.removeEventListener("abort", stop);
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
  output: AgentOutputRun,
  currentTurn: { value: number },
  reviewContext: ReviewContext | null,
): Promise<Result<undefined, unknown>> {
  const prompt = buildContinuationTurnPrompt(issue, opts, turnNumber, maxTurns, reviewContext);

  currentTurn.value = turnNumber;
  const turn = await backend.sessions.runTurn(session, prompt, { issue, turnNumber, maxTurns });
  if (!turn.ok) {
    return err(turn.error);
  }
  logger.info(
    `Completed agent run for ${issueContext(issue)} session_id=${turn.value.sessionId} workspace=${workspace} turn=${turnNumber}/${maxTurns}`,
  );

  // An abort mid-turn already tore the session down; do not start another turn
  // or refresh issue state on the way out.
  if (isAborted(opts.signal ?? null)) {
    return ok(undefined);
  }
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
      output,
      currentTurn,
      reviewContext,
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
  usageRebaser: FreshSessionUsageRebaser,
  turnNumber: number,
  maxTurns: number,
  output: AgentOutputRun,
  reviewContext: ReviewContext | null,
): Promise<Result<undefined, unknown>> {
  // Build the prompt before opening a session: a Liquid render error here must
  // not leak a started session (runSingleFreshTurn's finally only covers the
  // turn itself).
  const signal = opts.signal ?? null;
  if (isAborted(signal)) {
    return err({ tag: "aborted" });
  }
  const prompt = buildFullPrompt(issue, opts, reviewContext);
  const session = await backend.sessions.startSession(workspace, {
    workerHost,
    onMessage: agentMessageHandler(
      recipient,
      issue,
      backend,
      output,
      () => turnNumber,
      (message) => usageRebaser.rebase(message),
    ),
    toolProvider,
  });
  if (!session.ok) {
    return err(session.error);
  }
  output.bindRunId(session.value.runId);
  const detach = onAbort(signal, () => backend.sessions.stopSession(session.value));
  const turn = await runSingleFreshTurn(
    backend,
    session.value,
    prompt,
    issue,
    turnNumber,
    maxTurns,
    detach,
  );
  if (!turn.ok) {
    return err(turn.error);
  }
  logger.info(
    `Completed agent run for ${issueContext(issue)} session_id=${turn.value.sessionId} workspace=${workspace} turn=${turnNumber}/${maxTurns}`,
  );

  if (isAborted(signal)) {
    return ok(undefined);
  }
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
    usageRebaser.rollover();
    return runFreshSessionTurns(
      backend,
      workspace,
      outcome.issue,
      recipient,
      opts,
      workerHost,
      toolProvider,
      issueStateFetcher,
      usageRebaser,
      turnNumber + 1,
      maxTurns,
      output,
      reviewContext,
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
  detachAbort: () => void,
): Promise<Result<{ sessionId: string; [key: string]: unknown }, unknown>> {
  try {
    return await backend.sessions.runTurn(session, prompt, { issue, turnNumber, maxTurns });
  } finally {
    detachAbort();
    backend.sessions.stopSession(session);
  }
}

function buildFullPrompt(issue: Issue, opts: RunOpts, reviewContext: ReviewContext | null): string {
  return buildPrompt(issue, { attempt: opts.attempt ?? null, reviewContext });
}

function buildContinuationTurnPrompt(
  issue: Issue,
  opts: RunOpts,
  turnNumber: number,
  maxTurns: number,
  reviewContext: ReviewContext | null,
): string {
  if (turnNumber === 1) {
    return buildFullPrompt(issue, opts, reviewContext);
  }
  const reviewGuidance =
    reviewContext === null
      ? ""
      : `\n- This is a review run pinned to PR head ${reviewContext.headSha}; keep the handoff file and per-finding replies aligned with that snapshot.`;
  return `Continuation guidance:

- The previous Codex turn completed normally, but the ${workItemNoun()} is still in an active state.
- This is continuation turn #${turnNumber} of ${maxTurns} for the current agent run.
- Resume from the current workspace and workpad state instead of restarting from scratch.
- The original task instructions and prior turn context are already present in this thread, so do not restate them before acting.
- Focus on the remaining ticket work and do not end the turn while the issue stays active unless you are truly blocked.
${reviewGuidance}
`;
}

async function resolveReviewContext(
  issue: Issue,
  opts: RunOpts,
): Promise<Result<ReviewContext | null, unknown>> {
  if (opts.reviewContext !== undefined) {
    return ok(opts.reviewContext);
  }
  if (!isReviewTriggered(issue)) {
    return ok(null);
  }
  return fetchReviewContext(issue, opts.reviewProviderOptions);
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

function isReviewFailure(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { tag?: unknown }).tag === "string" &&
    (value as { tag: string }).tag.startsWith("review_")
  );
}
