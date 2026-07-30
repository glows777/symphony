// Literal port of `symphony_elixir/orchestrator.ex` — Commit 1: the pure
// decision/reconcile/retry-lookup/worker-host functions and their `_for_test`
// seams. The GenServer integration (poll loop, dispatch/spawn, snapshot, retry
// scheduling) is added in Commit 2; functions that require the live runtime
// take an `OrchestratorCtx`.

import * as AgentRunner from "./agent-runner.ts";
import { maxConcurrentAgentsForState, settingsBang, validate } from "./config.ts";
import { logger } from "./logger.ts";
import { notifyUpdate as notifyDashboard } from "./status-dashboard.ts";
import * as Tracker from "./tracker/tracker.ts";
import { type Issue, isIssue, isReworkState, routable } from "./work-item.ts";
import * as Workspace from "./workspace.ts";

const CONTINUATION_RETRY_DELAY_MS = 1_000;
const FAILURE_RETRY_BASE_MS = 10_000;
const HUMAN_REVIEW_STATE = "Human Review";
const REVIEW_SOURCE_STATES = ["In Progress", "Rework"] as const;
const REVIEW_OBSERVED_STATES = [...REVIEW_SOURCE_STATES, HUMAN_REVIEW_STATE] as const;

export type CodexTotals = {
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  seconds_running: number;
};

export const EMPTY_CODEX_TOTALS: CodexTotals = {
  input_tokens: 0,
  output_tokens: 0,
  total_tokens: 0,
  seconds_running: 0,
};

// The agent process handle (Elixir `pid`); abortable in the TS port.
export type RunningTask = { stop(reason?: AgentRunner.AgentRunCancellation): void };
export type RunKind = "normal" | "review";

export type RunningEntry = {
  task?: RunningTask | null;
  ref?: unknown;
  identifier?: string | null;
  issue: Issue;
  run_kind?: RunKind;
  backend?: string | null;
  worker_host?: string | null;
  workspace_path?: string | null;
  started_at?: Date | null;
  session_id?: string | null;
  retry_attempt?: number;
  last_codex_message?: unknown;
  last_codex_timestamp?: Date | null;
  last_codex_event?: string | null;
  codex_app_server_pid?: string | null;
  codex_input_tokens?: number;
  codex_output_tokens?: number;
  codex_total_tokens?: number;
  codex_last_reported_input_tokens?: number;
  codex_last_reported_output_tokens?: number;
  codex_last_reported_total_tokens?: number;
  turn_count?: number;
  completion?: unknown;
  blocked_at?: Date | null;
  blocker_codex_message?: unknown;
  blocker_codex_event?: string | null;
  blocker_codex_timestamp?: Date | null;
  blocker_session_id?: string | null;
  [key: string]: unknown;
};

export type FailureDispositionKind = "blocked" | "retryable" | "terminal";

export type ManualRecoveryInfo = {
  action: string;
  reason: string;
  prompt: string | null;
  payload: unknown;
  session_id: string | null;
  automatic_retry: false;
  resume_supported: false;
  rerun_supported: true;
};

export type BlockedEntry = {
  identifier?: string | null;
  issue?: Issue;
  title?: string | null;
  issue_url?: string | null;
  run_kind?: RunKind;
  backend?: string | null;
  error?: unknown;
  blocked_reason?: unknown;
  disposition?: FailureDispositionKind;
  operator_prompt?: string | null;
  raw_blocker_payload?: unknown;
  manual_recovery?: ManualRecoveryInfo | null;
  retry_attempt?: number | null;
  worker_host?: string | null;
  [key: string]: unknown;
};

export type RetryMetadata = {
  identifier?: string | null;
  issue_url?: string | null;
  error?: string | null;
  worker_host?: string | null;
  workspace_path?: string | null;
  delay_type?: string;
  retry_class?: "retryable";
  run_kind?: RunKind;
};

export type RetryAttempt = RetryMetadata & {
  attempt: number;
  timer_ref?: ReturnType<typeof setTimeout> | null;
  retry_token?: symbol;
  due_at_ms?: number;
};

export type ReviewQueueEntry = {
  issue: Issue;
  enqueued_at: Date;
};

export type State = {
  poll_interval_ms?: number;
  max_concurrent_agents?: number;
  next_poll_due_at_ms?: number | null;
  poll_check_in_progress?: boolean;
  tick_timer_ref?: ReturnType<typeof setTimeout> | null;
  tick_token?: symbol | null;
  running: Record<string, RunningEntry>;
  completed: Set<string>;
  claimed: Set<string>;
  blocked: Record<string, BlockedEntry>;
  retry_attempts: Record<string, RetryAttempt>;
  review_queue: Record<string, ReviewQueueEntry>;
  review_observed_states: Record<string, string>;
  codex_totals: CodexTotals | null;
  codex_rate_limits: unknown;
};

export function newState(overrides: Partial<State> = {}): State {
  return {
    running: {},
    completed: new Set(),
    claimed: new Set(),
    blocked: {},
    retry_attempts: {},
    review_queue: {},
    review_observed_states: {},
    codex_totals: EMPTY_CODEX_TOTALS,
    codex_rate_limits: null,
    ...overrides,
  };
}

// Live-runtime hooks supplied by the GenServer (Commit 2).
export type OrchestratorCtx = {
  dispatch(
    state: State,
    issue: Issue,
    attempt: number | null,
    preferredWorkerHost: string | null,
  ): State;
  scheduleRetry(state: State, issueId: string, attempt: number, metadata: RetryMetadata): State;
};

export type RevalidateOutcome =
  | { kind: "ok"; issue: Issue }
  | { kind: "skip"; issue: Issue | "missing" }
  | { kind: "error"; reason: unknown };

export type IssueStateFetcher = (
  ids: string[],
) =>
  | { ok: true; value: Issue[] }
  | { ok: false; error: unknown }
  | Promise<{ ok: true; value: Issue[] } | { ok: false; error: unknown }>;

// ---- test seams ------------------------------------------------------------

export function reconcileIssueStatesForTest(issues: Issue[], state: State): State {
  return reconcileRunningIssueStates(issues, state, activeStateSet(), terminalStateSet());
}

export function reconcileBlockedIssueStatesForTest(issues: Issue[], state: State): State {
  return reconcileBlockedIssueStates(issues, state, activeStateSet(), terminalStateSet());
}

export function reconcileReviewQueueForTest(issues: Issue[], state: State): State {
  return reconcileReviewQueue(issues, state);
}

export function handleRetryIssueLookupForTest(
  issue: Issue,
  state: State,
  issueId: string,
  attempt: number,
  metadata: RetryMetadata,
): State {
  return handleRetryIssueLookup(issue, state, issueId, attempt, metadata, throwingCtx);
}

export function shouldDispatchIssueForTest(issue: Issue, state: State): boolean {
  return shouldDispatchIssue(issue, state, activeStateSet(), terminalStateSet());
}

export function revalidateIssueForDispatchForTest(
  issue: Issue,
  fetcher: IssueStateFetcher,
): Promise<RevalidateOutcome> {
  return revalidateIssueForDispatch(issue, fetcher, terminalStateSet());
}

export function sortIssuesForDispatchForTest(issues: Issue[]): Issue[] {
  return sortIssuesForDispatch(issues);
}

export function selectWorkerHostForTest(
  state: State,
  preferredWorkerHost: string | null,
): string | null | "no_worker_capacity" {
  return selectWorkerHost(state, preferredWorkerHost);
}

// ---- reconcile -------------------------------------------------------------

export function reconcileRunningIssueStates(
  issues: Issue[],
  state: State,
  activeStates: Set<string>,
  terminalStates: Set<string>,
): State {
  return issues.reduce(
    (acc, issue) => reconcileIssueState(issue, acc, activeStates, terminalStates),
    state,
  );
}

function reconcileIssueState(
  issue: Issue,
  state: State,
  activeStates: Set<string>,
  terminalStates: Set<string>,
): State {
  if (runningReviewIssue(issue, state)) {
    return reconcileReviewIssueState(issue, state, terminalStates);
  }
  if (terminalIssueState(issue.state, terminalStates)) {
    logger.info(
      `Issue moved to terminal state: ${issueContext(issue)} state=${issue.state}; stopping active agent`,
    );
    return terminateRunningIssue(
      state,
      issue.id,
      true,
      cancellationReason("issue_terminal_state", { state: issue.state }),
    );
  }
  if (!issueRoutable(issue)) {
    logger.info(
      `Issue no longer routed to this worker: ${issueContext(issue)}; stopping active agent`,
    );
    return terminateRunningIssue(state, issue.id, false, cancellationReason("issue_not_routable"));
  }
  if (activeIssueState(issue.state, activeStates)) {
    if (enteredReworkState(issue, state)) {
      logger.info(
        `Issue entered Rework: ${issueContext(issue)}; stopping the previous agent before a clean dispatch`,
      );
      return terminateRunningIssue(state, issue.id, false, cancellationReason("issue_rework"));
    }
    return refreshRunningIssueState(state, issue);
  }
  logger.info(
    `Issue moved to non-active state: ${issueContext(issue)} state=${issue.state}; stopping active agent`,
  );
  return terminateRunningIssue(
    state,
    issue.id,
    false,
    cancellationReason("issue_non_active_state", { state: issue.state }),
  );
}

function reconcileReviewIssueState(issue: Issue, state: State, terminalStates: Set<string>): State {
  if (terminalIssueState(issue.state, terminalStates)) {
    logger.info(
      `Review issue moved to terminal state: ${issueContext(issue)} state=${issue.state}; stopping review agent`,
    );
    return terminateRunningIssue(
      state,
      issue.id,
      true,
      cancellationReason("review_issue_terminal_state", { state: issue.state }),
    );
  }
  if (!issueRoutable(issue)) {
    logger.info(
      `Review issue no longer routed to this worker: ${issueContext(issue)}; stopping review agent`,
    );
    return terminateRunningIssue(
      state,
      issue.id,
      false,
      cancellationReason("review_issue_not_routable"),
    );
  }
  if (humanReviewIssueState(issue.state)) {
    return refreshRunningIssueState(state, issue);
  }
  logger.info(
    `Review issue left Human Review: ${issueContext(issue)} state=${issue.state}; stopping review agent`,
  );
  return terminateRunningIssue(
    state,
    issue.id,
    false,
    cancellationReason("review_issue_left_human_review", { state: issue.state }),
  );
}

export function reconcileBlockedIssueStates(
  issues: Issue[],
  state: State,
  activeStates: Set<string>,
  terminalStates: Set<string>,
): State {
  return issues.reduce(
    (acc, issue) => reconcileBlockedIssueState(issue, acc, activeStates, terminalStates),
    state,
  );
}

function reconcileBlockedIssueState(
  issue: Issue,
  state: State,
  activeStates: Set<string>,
  terminalStates: Set<string>,
): State {
  if (terminalIssueState(issue.state, terminalStates)) {
    logger.info(`Blocked issue moved to terminal state: ${issueContext(issue)}; releasing block`);
    cleanupIssueWorkspace(issue.identifier, blockedIssueWorkerHost(state, issue.id));
    return releaseIssueClaim(state, issue.id);
  }
  if (!issueRoutable(issue)) {
    logger.info(
      `Blocked issue no longer routed to this worker: ${issueContext(issue)}; releasing block`,
    );
    return releaseIssueClaim(state, issue.id);
  }
  if (blockedReviewIssue(issue, state) && humanReviewIssueState(issue.state)) {
    return refreshBlockedIssueState(state, issue);
  }
  if (activeIssueState(issue.state, activeStates)) {
    return refreshBlockedIssueState(state, issue);
  }
  logger.info(`Blocked issue moved to non-active state: ${issueContext(issue)}; releasing block`);
  return releaseIssueClaim(state, issue.id);
}

function refreshRunningIssueState(state: State, issue: Issue): State {
  const id = issue.id;
  if (id === null) {
    return state;
  }
  const entry = state.running[id];
  if (entry && "issue" in entry) {
    return { ...state, running: { ...state.running, [id]: { ...entry, issue } } };
  }
  return state;
}

function refreshBlockedIssueState(state: State, issue: Issue): State {
  const id = issue.id;
  if (id === null) {
    return state;
  }
  const entry = state.blocked[id];
  if (entry && "issue" in entry) {
    return { ...state, blocked: { ...state.blocked, [id]: { ...entry, issue } } };
  }
  return state;
}

function terminateRunningIssue(
  state: State,
  issueId: string | null,
  cleanupWorkspace: boolean,
  reason: AgentRunner.AgentRunCancellation = cancellationReason("explicit_stop"),
): State {
  if (issueId === null) {
    return state;
  }
  const entry = state.running[issueId];
  if (entry === undefined) {
    return releaseIssueClaim(state, issueId);
  }
  let next = recordSessionCompletionTotals(state, entry);
  const workerHost = entry.worker_host ?? null;
  if (cleanupWorkspace) {
    cleanupIssueWorkspace(entry.identifier ?? null, workerHost);
  }
  stopRunningTask(entry.task ?? null, entry.ref, reason);
  next = {
    ...next,
    running: omitKey(next.running, issueId),
    claimed: setWithout(next.claimed, issueId),
    blocked: omitKey(next.blocked, issueId),
    retry_attempts: omitKey(next.retry_attempts, issueId),
    review_queue: omitKey(next.review_queue, issueId),
  };
  return next;
}

function releaseIssueClaim(state: State, issueId: string | null): State {
  if (issueId === null) {
    return state;
  }
  return {
    ...state,
    claimed: setWithout(state.claimed, issueId),
    blocked: omitKey(state.blocked, issueId),
    retry_attempts: omitKey(state.retry_attempts, issueId),
    review_queue: omitKey(state.review_queue, issueId),
  };
}

function recordSessionCompletionTotals(state: State, entry: RunningEntry): State {
  const runtimeSeconds = runningSeconds(entry.started_at ?? null);
  const codexTotals = applyTokenDelta(state.codex_totals, {
    input_tokens: 0,
    output_tokens: 0,
    total_tokens: 0,
    seconds_running: runtimeSeconds,
  });
  return { ...state, codex_totals: codexTotals };
}

function stopRunningTask(
  task: RunningTask | null,
  _ref: unknown,
  reason: AgentRunner.AgentRunCancellation = cancellationReason("explicit_stop"),
): void {
  if (task && typeof task.stop === "function") {
    task.stop(reason);
  }
}

function cancellationReason(
  reason: string,
  details: Record<string, unknown> = {},
): AgentRunner.AgentRunCancellation {
  return AgentRunner.agentRunCancellation(reason, details);
}

function cleanupIssueWorkspace(identifier: string | null, workerHost: string | null): void {
  if (typeof identifier === "string") {
    Workspace.removeIssueWorkspaces(identifier, workerHost);
  }
}

function blockedIssueWorkerHost(state: State, issueId: string | null): string | null {
  if (issueId === null) {
    return null;
  }
  return state.blocked[issueId]?.worker_host ?? null;
}

function blockedReviewIssue(issue: Issue, state: State): boolean {
  return typeof issue.id === "string" && state.blocked[issue.id]?.run_kind === "review";
}

// ---- review queue ----------------------------------------------------------

function reconcileReviewQueue(issues: Issue[], state: State): State {
  const observed = reviewObservedStateMap(issues);
  let queue = refreshReviewQueueEntries(state.review_queue, issues);

  for (const issue of issues) {
    if (typeof issue.id !== "string") {
      continue;
    }
    const previousState = state.review_observed_states[issue.id] ?? null;
    if (
      reviewTransitionEligible(previousState, issue) &&
      !(issue.id in queue) &&
      !(issue.id in state.running) &&
      !(issue.id in state.blocked)
    ) {
      logger.info(
        `Queueing review agent from status edge: ${issueContext(issue)} previous_state=${previousState} state=${issue.state}`,
      );
      queue = { ...queue, [issue.id]: { issue, enqueued_at: new Date() } };
    }
  }

  return {
    ...state,
    review_queue: queue,
    review_observed_states: observed,
  };
}

function refreshReviewQueueEntries(
  queue: Record<string, ReviewQueueEntry>,
  issues: Issue[],
): Record<string, ReviewQueueEntry> {
  const byId = new Map(
    issues
      .filter((issue) => typeof issue.id === "string")
      .map((issue) => [issue.id as string, issue]),
  );
  const next: Record<string, ReviewQueueEntry> = {};
  for (const [issueId, entry] of Object.entries(queue)) {
    const current = byId.get(issueId);
    if (current === undefined) {
      next[issueId] = entry;
      continue;
    }
    if (reviewQueueCandidate(current)) {
      next[issueId] = { ...entry, issue: current };
    }
  }
  return next;
}

function reviewObservedStateMap(issues: Issue[]): Record<string, string> {
  const observed: Record<string, string> = {};
  for (const issue of issues) {
    if (typeof issue.id === "string" && typeof issue.state === "string") {
      observed[issue.id] = normalizeIssueState(issue.state);
    }
  }
  return observed;
}

function reviewTransitionEligible(previousState: string | null, issue: Issue): boolean {
  return previousState !== null && reviewSourceState(previousState) && reviewQueueCandidate(issue);
}

function reviewQueueCandidate(issue: Issue): boolean {
  return (
    typeof issue.id === "string" &&
    typeof issue.identifier === "string" &&
    typeof issue.title === "string" &&
    humanReviewIssueState(issue.state) &&
    issueRoutable(issue)
  );
}

function reviewSourceState(stateName: string): boolean {
  return REVIEW_SOURCE_STATES.some((source) => normalizeIssueState(source) === stateName);
}

// ---- retry lookup ----------------------------------------------------------

function handleRetryIssueLookup(
  issue: Issue | null,
  state: State,
  issueId: string,
  attempt: number,
  metadata: RetryMetadata,
  ctx: OrchestratorCtx,
): State {
  if (issue === null) {
    logger.debug(`Issue no longer visible, removing claim issue_id=${issueId}`);
    return releaseIssueClaim(state, issueId);
  }
  const terminalStates = terminalStateSet();
  if (terminalIssueState(issue.state, terminalStates)) {
    logger.info(
      `Issue state is terminal: issue_id=${issueId} issue_identifier=${issue.identifier} state=${issue.state}; removing associated workspace`,
    );
    cleanupIssueWorkspace(issue.identifier ?? null, metadata.worker_host ?? null);
    return releaseIssueClaim(state, issueId);
  }
  if (retryCandidateIssue(issue, terminalStates)) {
    return handleActiveRetry(state, issue, attempt, metadata, ctx);
  }
  logger.debug(
    `Issue left active states, removing claim issue_id=${issueId} issue_identifier=${issue.identifier}`,
  );
  return releaseIssueClaim(state, issueId);
}

function handleActiveRetry(
  state: State,
  issue: Issue,
  attempt: number,
  metadata: RetryMetadata,
  ctx: OrchestratorCtx,
): State {
  if (
    retryCandidateIssue(issue, terminalStateSet()) &&
    dispatchSlotsAvailable(issue, state) &&
    workerSlotsAvailable(state, metadata.worker_host ?? null)
  ) {
    return ctx.dispatch(state, issue, attempt, metadata.worker_host ?? null);
  }
  if (issue.id === null) {
    return state;
  }
  return ctx.scheduleRetry(state, issue.id, attempt, {
    ...metadata,
    identifier: issue.identifier,
    error: "no available orchestrator slots",
  });
}

async function revalidateIssueForDispatch(
  issue: Issue,
  fetcher: IssueStateFetcher,
  terminalStates: Set<string>,
): Promise<RevalidateOutcome> {
  if (issue.id === null) {
    return { kind: "ok", issue };
  }
  const result = await fetcher([issue.id]);
  if (!result.ok) {
    return { kind: "error", reason: result.error };
  }
  const refreshed = result.value[0];
  if (refreshed === undefined) {
    return { kind: "skip", issue: "missing" };
  }
  return retryCandidateIssue(refreshed, terminalStates)
    ? { kind: "ok", issue: refreshed }
    : { kind: "skip", issue: refreshed };
}

async function revalidateIssueForReviewDispatch(
  issue: Issue,
  fetcher: IssueStateFetcher,
): Promise<RevalidateOutcome> {
  if (issue.id === null) {
    return { kind: "skip", issue };
  }
  const result = await fetcher([issue.id]);
  if (!result.ok) {
    return { kind: "error", reason: result.error };
  }
  const refreshed = result.value[0];
  if (refreshed === undefined) {
    return { kind: "skip", issue: "missing" };
  }
  return reviewQueueCandidate(refreshed)
    ? { kind: "ok", issue: refreshed }
    : { kind: "skip", issue: refreshed };
}

// ---- dispatch decision -----------------------------------------------------

function sortIssuesForDispatch(issues: Issue[]): Issue[] {
  const key = (issue: Issue): [number, number, string] => [
    priorityRank(issue.priority),
    issueCreatedAtSortKey(issue),
    issue.identifier || issue.id || "",
  ];
  return [...issues].sort((a, b) => {
    const ka = key(a);
    const kb = key(b);
    if (ka[0] !== kb[0]) return ka[0] - kb[0];
    if (ka[1] !== kb[1]) return ka[1] < kb[1] ? -1 : 1;
    return ka[2] < kb[2] ? -1 : ka[2] > kb[2] ? 1 : 0;
  });
}

function priorityRank(priority: number | null): number {
  return typeof priority === "number" &&
    Number.isInteger(priority) &&
    priority >= 1 &&
    priority <= 4
    ? priority
    : 5;
}

function issueCreatedAtSortKey(issue: Issue): number {
  return issue.createdAt instanceof Date
    ? issue.createdAt.getTime() * 1000
    : Number.MAX_SAFE_INTEGER;
}

function shouldDispatchIssue(
  issue: Issue,
  state: State,
  activeStates: Set<string>,
  terminalStates: Set<string>,
): boolean {
  return (
    candidateIssue(issue, activeStates, terminalStates) &&
    !todoIssueBlockedByNonTerminal(issue, terminalStates) &&
    issue.id !== null &&
    !state.claimed.has(issue.id) &&
    !(issue.id in state.running) &&
    !(issue.id in state.blocked) &&
    availableSlots(state) > 0 &&
    stateSlotsAvailable(issue, state.running) &&
    workerSlotsAvailable(state, null)
  );
}

function shouldDispatchReviewIssue(issue: Issue, state: State): boolean {
  return (
    reviewQueueCandidate(issue) &&
    issue.id !== null &&
    !state.claimed.has(issue.id) &&
    !(issue.id in state.running) &&
    !(issue.id in state.blocked) &&
    availableSlots(state) > 0 &&
    stateSlotsAvailable(issue, state.running) &&
    workerSlotsAvailable(state, null)
  );
}

function candidateIssue(
  issue: Issue,
  activeStates: Set<string>,
  terminalStates: Set<string>,
): boolean {
  if (
    typeof issue.id !== "string" ||
    typeof issue.identifier !== "string" ||
    typeof issue.title !== "string" ||
    typeof issue.state !== "string"
  ) {
    return false;
  }
  return (
    issueRoutable(issue) &&
    activeIssueState(issue.state, activeStates) &&
    !terminalIssueState(issue.state, terminalStates)
  );
}

function issueRoutable(issue: Issue): boolean {
  return routable(issue, settingsBang().tracker.requiredLabels);
}

function todoIssueBlockedByNonTerminal(issue: Issue, terminalStates: Set<string>): boolean {
  if (typeof issue.state !== "string") {
    return false;
  }
  return (
    normalizeIssueState(issue.state) === "todo" &&
    issue.blockedBy.some((blocker) =>
      typeof blocker.state === "string" ? !terminalIssueState(blocker.state, terminalStates) : true,
    )
  );
}

function retryCandidateIssue(issue: Issue, terminalStates: Set<string>): boolean {
  return (
    candidateIssue(issue, activeStateSet(), terminalStates) &&
    !todoIssueBlockedByNonTerminal(issue, terminalStates)
  );
}

function blockedRerunCandidate(issue: Issue, runKind: RunKind): boolean {
  if (runKind === "review") {
    return reviewQueueCandidate(issue);
  }
  return retryCandidateIssue(issue, terminalStateSet());
}

function enteredReworkState(issue: Issue, state: State): boolean {
  if (issue.id === null || !isReworkState(issue.state)) {
    return false;
  }
  const previous = state.running[issue.id]?.issue?.state;
  return !isReworkState(previous);
}

function stateSlotsAvailable(issue: Issue, running: Record<string, RunningEntry>): boolean {
  if (typeof issue.state !== "string") {
    return false;
  }
  const limit = maxConcurrentAgentsForState(issue.state);
  return limit > runningIssueCountForState(running, issue.state);
}

function runningIssueCountForState(
  running: Record<string, RunningEntry>,
  issueState: string,
): number {
  const normalized = normalizeIssueState(issueState);
  return Object.values(running).filter((entry) => {
    const state = entry.issue?.state;
    return typeof state === "string" && normalizeIssueState(state) === normalized;
  }).length;
}

function availableSlots(state: State): number {
  const max = state.max_concurrent_agents ?? settingsBang().agent.maxConcurrentAgents;
  return Math.max(max - Object.keys(state.running).length, 0);
}

function dispatchSlotsAvailable(issue: Issue, state: State): boolean {
  return availableSlots(state) > 0 && stateSlotsAvailable(issue, state.running);
}

// ---- worker host selection -------------------------------------------------

function selectWorkerHost(
  state: State,
  preferredWorkerHost: string | null,
): string | null | "no_worker_capacity" {
  const hosts = settingsBang().worker.sshHosts;
  if (hosts.length === 0) {
    return null;
  }
  const available = hosts.filter((host) => workerHostSlotsAvailable(state, host));
  if (available.length === 0) {
    return "no_worker_capacity";
  }
  if (preferredWorkerHostAvailable(preferredWorkerHost, available)) {
    return preferredWorkerHost;
  }
  return leastLoadedWorkerHost(state, available);
}

function preferredWorkerHostAvailable(
  preferredWorkerHost: string | null,
  hosts: string[],
): preferredWorkerHost is string {
  return (
    typeof preferredWorkerHost === "string" &&
    preferredWorkerHost !== "" &&
    hosts.includes(preferredWorkerHost)
  );
}

function leastLoadedWorkerHost(state: State, hosts: string[]): string {
  let best = hosts[0] as string;
  let bestCount = runningWorkerHostCount(state.running, best);
  for (let i = 1; i < hosts.length; i++) {
    const host = hosts[i] as string;
    const count = runningWorkerHostCount(state.running, host);
    if (count < bestCount) {
      best = host;
      bestCount = count;
    }
  }
  return best;
}

function runningWorkerHostCount(running: Record<string, RunningEntry>, workerHost: string): number {
  return Object.values(running).filter((entry) => entry.worker_host === workerHost).length;
}

function workerSlotsAvailable(state: State, preferredWorkerHost: string | null): boolean {
  return selectWorkerHost(state, preferredWorkerHost) !== "no_worker_capacity";
}

function workerHostSlotsAvailable(state: State, workerHost: string): boolean {
  const limit = settingsBang().worker.maxConcurrentAgentsPerHost;
  if (typeof limit === "number" && Number.isInteger(limit) && limit > 0) {
    return runningWorkerHostCount(state.running, workerHost) < limit;
  }
  return true;
}

// ---- state-name helpers ----------------------------------------------------

function terminalIssueState(stateName: unknown, terminalStates: Set<string>): boolean {
  return typeof stateName === "string" && terminalStates.has(normalizeIssueState(stateName));
}

function activeIssueState(stateName: unknown, activeStates: Set<string>): boolean {
  return typeof stateName === "string" && activeStates.has(normalizeIssueState(stateName));
}

function humanReviewIssueState(stateName: unknown): boolean {
  return typeof stateName === "string" && normalizeIssueState(stateName) === "human review";
}

function runningReviewIssue(issue: Issue, state: State): boolean {
  return typeof issue.id === "string" && state.running[issue.id]?.run_kind === "review";
}

function normalizeIssueState(stateName: string): string {
  return stateName.trim().toLowerCase();
}

function terminalStateSet(): Set<string> {
  return new Set(
    settingsBang()
      .tracker.terminalStates.map((s) => normalizeIssueState(s))
      .filter((s) => s !== ""),
  );
}

function activeStateSet(): Set<string> {
  return new Set(
    settingsBang()
      .tracker.activeStates.map((s) => normalizeIssueState(s))
      .filter((s) => s !== ""),
  );
}

// ---- misc helpers ----------------------------------------------------------

// Exported for Commit 2 reuse.
export function retryDelay(attempt: number, metadata: RetryMetadata): number {
  if (Number.isInteger(attempt) && attempt > 0) {
    if (metadata.delay_type === "continuation" && attempt === 1) {
      return CONTINUATION_RETRY_DELAY_MS;
    }
    return failureRetryDelay(attempt);
  }
  return failureRetryDelay(attempt);
}

function failureRetryDelay(attempt: number): number {
  const maxDelayPower = Math.min(attempt - 1, 10);
  return Math.min(
    FAILURE_RETRY_BASE_MS * (1 << maxDelayPower),
    settingsBang().agent.maxRetryBackoffMs,
  );
}

function retryAttemptsExhausted(attempt: number, metadata: RetryMetadata): boolean {
  if (metadata.retry_class !== "retryable") {
    return false;
  }
  return attempt > settingsBang().agent.maxRetryAttempts;
}

function runningSeconds(startedAt: Date | null): number {
  if (startedAt instanceof Date) {
    return Math.max(0, Math.floor((Date.now() - startedAt.getTime()) / 1000));
  }
  return 0;
}

function applyTokenDelta(codexTotals: CodexTotals | null, delta: CodexTotals): CodexTotals {
  const base = codexTotals ?? EMPTY_CODEX_TOTALS;
  return {
    input_tokens: base.input_tokens + delta.input_tokens,
    output_tokens: base.output_tokens + delta.output_tokens,
    total_tokens: base.total_tokens + delta.total_tokens,
    seconds_running: base.seconds_running + delta.seconds_running,
  };
}

function issueContext(issue: Issue): string {
  return `issue_id=${issue.id} issue_identifier=${issue.identifier}`;
}

function omitKey<T>(record: Record<string, T>, key: string): Record<string, T> {
  const { [key]: _omitted, ...rest } = record;
  return rest;
}

function setWithout(set: Set<string>, key: string): Set<string> {
  const next = new Set(set);
  next.delete(key);
  return next;
}

const throwingCtx: OrchestratorCtx = {
  dispatch() {
    throw new Error("dispatch requires the live orchestrator (Commit 2)");
  },
  scheduleRetry() {
    throw new Error("scheduleRetry requires the live orchestrator (Commit 2)");
  },
};

// ============================================================================
// Commit 2 — the live GenServer
//
// Per the OTP→TS rulebook, the `Orchestrator` GenServer becomes a class holding
// `State` plus a serialized async mailbox (a promise-chained queue) so every
// handler runs one-at-a-time. `handle_info`/`handle_call` become `cast`/`call`
// dispatched through the mailbox; `Process.send_after` becomes `setTimeout`
// with the timer handle stored on state and tracked for cleanup. `self()`
// message sends become `this.cast(...)`.
// ============================================================================

const POLL_TRANSITION_RENDER_DELAY_MS = 20;

// A monotonic-ish millisecond clock (Elixir `System.monotonic_time(:millisecond)`).
export function nowMs(): number {
  return Date.now();
}

// The codex worker update envelope (Elixir's `%{event:, timestamp:, ...}` map).
// Top-level fields use the TS app-server's camelCase shape; nested `payload`
// stays string-keyed JSON exactly as it arrives off the Codex wire.
export type CodexUpdate = {
  event: string;
  timestamp: Date;
  payload?: unknown;
  raw?: unknown;
  sessionId?: string;
  // Neutral pid from the normalized envelope; `codexAppServerPid` is the frozen
  // codex-era alias, still emitted and still read as a fallback.
  backendPid?: string;
  codexAppServerPid?: string | number | number[];
  usage?: unknown;
  rate_limits?: unknown;
  [key: string]: unknown;
};

// The envelope is agent-backend-neutral now; `codex_*` wire/state names are
// frozen historical names (see MIGRATION.md). `AgentUpdate` is the forward name;
// `CodexUpdate` remains its permanent alias.
export type AgentUpdate = CodexUpdate;

export type Info =
  | { tag: "tick"; token: symbol | null }
  | { tag: "run_poll_cycle" }
  | { tag: "down"; ref: unknown; reason: unknown }
  | {
      tag: "worker_runtime_info";
      issueId: string;
      runtimeInfo: { worker_host?: string | null; workspace_path?: string | null };
    }
  | { tag: "codex_worker_update"; issueId: string; update: CodexUpdate }
  | { tag: "retry_issue"; issueId: string; retryToken: symbol };

export type SnapshotRunning = {
  issue_id: string;
  identifier: string | null | undefined;
  title?: string | null;
  backend?: string | null;
  issue_url: string | null | undefined;
  state: string | null | undefined;
  worker_host: string | null | undefined;
  workspace_path: string | null | undefined;
  session_id: string | null | undefined;
  codex_app_server_pid: string | null | undefined;
  codex_input_tokens: number;
  codex_output_tokens: number;
  codex_total_tokens: number;
  turn_count: number;
  started_at: Date | null | undefined;
  last_codex_timestamp: Date | null | undefined;
  last_codex_message: unknown;
  last_codex_event: string | null | undefined;
  runtime_seconds: number;
};

export type Snapshot = {
  running: SnapshotRunning[];
  retrying: Array<Record<string, unknown>>;
  blocked: Array<Record<string, unknown>>;
  codex_totals: CodexTotals | null;
  rate_limits: unknown;
  polling?: {
    checking: boolean;
    next_poll_in_ms: number | null;
    poll_interval_ms: number | undefined;
  };
};

export type RequestRefreshReply = {
  queued: true;
  coalesced: boolean;
  requested_at: Date;
  operations: string[];
};

export type RerunBlockedReply =
  | {
      queued: true;
      issue_id: string;
      issue_identifier: string | null;
      requested_at: Date;
      operation: "rerun_blocked";
    }
  | {
      queued: false;
      error:
        | "blocked_issue_not_found"
        | "issue_refresh_failed"
        | "issue_not_active"
        | "no_dispatch_capacity";
      requested_at: Date;
      reason?: unknown;
    };

function isObj(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function numOr0(value: unknown): number {
  return typeof value === "number" ? value : 0;
}

function inspectReason(reason: unknown): string {
  if (typeof reason === "string") {
    return reason;
  }
  if (reason instanceof Error) {
    return reason.message;
  }
  try {
    return JSON.stringify(reason);
  } catch {
    return String(reason);
  }
}

// ---- missing-issue reconciliation ------------------------------------------

function visibleIssueIdSet(issues: Issue[]): Set<string> {
  const ids = new Set<string>();
  for (const issue of issues) {
    if (typeof issue.id === "string") {
      ids.add(issue.id);
    }
  }
  return ids;
}

function reconcileMissingRunningIssueIds(
  state: State,
  requestedIssueIds: string[],
  issues: Issue[],
): State {
  const visible = visibleIssueIdSet(issues);
  return requestedIssueIds.reduce((acc, issueId) => {
    if (visible.has(issueId)) {
      return acc;
    }
    logMissingRunningIssue(acc, issueId);
    return terminateRunningIssue(
      acc,
      issueId,
      false,
      cancellationReason("issue_no_longer_visible"),
    );
  }, state);
}

function reconcileMissingBlockedIssueIds(
  state: State,
  requestedIssueIds: string[],
  issues: Issue[],
): State {
  const visible = visibleIssueIdSet(issues);
  return requestedIssueIds.reduce((acc, issueId) => {
    if (visible.has(issueId)) {
      return acc;
    }
    logger.info(
      `Blocked issue no longer visible during state refresh: issue_id=${issueId}; releasing block`,
    );
    return releaseIssueClaim(acc, issueId);
  }, state);
}

function logMissingRunningIssue(state: State, issueId: string): void {
  const identifier = state.running[issueId]?.identifier;
  if (typeof identifier === "string") {
    logger.info(
      `Issue no longer visible during running-state refresh: issue_id=${issueId} issue_identifier=${identifier}; stopping active agent`,
    );
  } else {
    logger.info(
      `Issue no longer visible during running-state refresh: issue_id=${issueId}; stopping active agent`,
    );
  }
}

// ---- stalled-worker reconciliation -----------------------------------------

function stallElapsedMs(entry: RunningEntry, now: Date): number | null {
  const timestamp = lastActivityTimestamp(entry);
  if (timestamp instanceof Date) {
    return Math.max(0, now.getTime() - timestamp.getTime());
  }
  return null;
}

function lastActivityTimestamp(entry: RunningEntry): Date | null {
  if (entry.last_codex_timestamp instanceof Date) {
    return entry.last_codex_timestamp;
  }
  if (entry.started_at instanceof Date) {
    return entry.started_at;
  }
  return null;
}

// ---- input-required / blocker classification -------------------------------

function inputRequiredBlocker(entry: RunningEntry | null | undefined): boolean {
  if (!entry) {
    return false;
  }
  const event = entry.blocker_codex_event ?? entry.last_codex_event;
  return (
    (typeof event === "string" &&
      (event === "turn_input_required" || event === "approval_required")) ||
    inputRequiredCompletionOutcome(entry.completion) !== null ||
    inputRequiredReason(entry.blocker_codex_message) !== null ||
    inputRequiredReason(entry.last_codex_message) !== null ||
    codexMessageMethod(entry.blocker_codex_message) === "mcpServer/elicitation/request" ||
    codexMessageMethod(entry.last_codex_message) === "mcpServer/elicitation/request"
  );
}

function inputRequiredCompletionOutcome(completion: unknown): string | null {
  if (!isObj(completion)) {
    return null;
  }
  return normalizeInputRequiredOutcome(completion.outcome);
}

function normalizeInputRequiredOutcome(outcome: unknown): string | null {
  if (
    outcome === "input_required" ||
    outcome === "needs_input" ||
    outcome === "approval_required"
  ) {
    return outcome;
  }
  return null;
}

function blockerError(entry: RunningEntry, fallback: string): string {
  return (
    codexEventBlockerError(entry.blocker_codex_event) ??
    codexEventBlockerError(entry.last_codex_event) ??
    completionBlockerError(entry.completion) ??
    codexMessageBlockerError(entry.blocker_codex_message) ??
    codexMessageBlockerError(entry.last_codex_message) ??
    fallback
  );
}

function codexEventBlockerError(event: unknown): string | null {
  if (event === "turn_input_required") {
    return "codex turn requires operator input";
  }
  if (event === "approval_required") {
    return "codex turn requires approval";
  }
  return null;
}

function completionBlockerError(completion: unknown): string | null {
  const outcome = inputRequiredCompletionOutcome(completion);
  if (outcome === "input_required" || outcome === "needs_input") {
    return "codex turn requires operator input";
  }
  if (outcome === "approval_required") {
    return "codex turn requires approval";
  }
  return null;
}

function codexMessageBlockerError(message: unknown): string | null {
  if (codexMessageMethod(message) === "mcpServer/elicitation/request") {
    return "codex MCP elicitation requires operator input";
  }
  const reason = inputRequiredReason(message);
  if (reason === "turn_input_required") {
    return "codex turn requires operator input";
  }
  if (reason === "approval_required") {
    return "codex turn requires approval";
  }
  return null;
}

function codexMessageMethod(message: unknown): string | null {
  if (!isObj(message)) {
    return null;
  }
  const inner = message.message;
  if (isObj(inner) && typeof inner.method === "string") {
    return inner.method;
  }
  if (typeof message.method === "string") {
    return message.method;
  }
  return null;
}

function blockerEventForUpdate(update: CodexUpdate, summary: unknown): string | null {
  if (update.event === "turn_input_required" || update.event === "approval_required") {
    return update.event;
  }
  const reason = inputRequiredReason(update.reason) ?? inputRequiredReason(summary);
  if (reason !== null) {
    return reason;
  }
  return codexMessageMethod(summary) === "mcpServer/elicitation/request"
    ? "turn_input_required"
    : null;
}

function inputRequiredReason(value: unknown): string | null {
  const tag = failureTag(value);
  if (tag === "turn_input_required" || tag === "input_required" || tag === "needs_input") {
    return "turn_input_required";
  }
  if (tag === "approval_required") {
    return "approval_required";
  }
  if (!isObj(value)) {
    return null;
  }
  return (
    inputRequiredReason(value.reason) ??
    inputRequiredReason(value.error) ??
    inputRequiredReason(value.message)
  );
}

type AgentFailureDisposition =
  | { kind: "blocked"; error: string }
  | { kind: "retryable"; error: string };

function classifyAgentFailure(reason: unknown, entry: RunningEntry): AgentFailureDisposition {
  if (inputRequiredBlocker(entry)) {
    return {
      kind: "blocked",
      error: blockerError(entry, `agent exited: ${inspectReason(reason)}`),
    };
  }
  const error = nonRetryableOrRetryableError(reason, entry);
  return retryableFailure(reason, entry)
    ? { kind: "retryable", error }
    : { kind: "blocked", error: `agent failure is not retryable: ${error}` };
}

function nonRetryableOrRetryableError(reason: unknown, entry: RunningEntry): string {
  const event = typeof entry.last_codex_event === "string" ? entry.last_codex_event : null;
  const tag = firstFailureTag(reason, entry);
  if (event === "turn_cancelled" || tag === "turn_cancelled") {
    return "agent turn was cancelled";
  }
  if (event === "unsupported_tool_call" || tag === "unsupported_tool_call") {
    return "agent requested an unsupported tool";
  }
  if (event === "tool_call_failed" || tag === "tool_call_failed") {
    return "agent tool call failed";
  }
  if (event === "turn_failed" || tag === "turn_failed") {
    return "agent turn failed";
  }
  return `agent exited: ${inspectReason(reason)}`;
}

function retryableFailure(reason: unknown, entry: RunningEntry): boolean {
  return failureSignals(reason, entry).some(retryableSignal);
}

function firstFailureTag(reason: unknown, entry: RunningEntry): string | null {
  for (const signal of failureSignals(reason, entry)) {
    const tag = failureTag(signal);
    if (tag !== null) {
      return tag;
    }
  }
  return null;
}

function failureSignals(reason: unknown, entry: RunningEntry): unknown[] {
  return [
    reason,
    entry.completion,
    entry.last_codex_event,
    entry.last_codex_message,
    entry.blocker_codex_event,
    entry.blocker_codex_message,
  ];
}

function retryableSignal(signal: unknown): boolean {
  const tag = failureTag(signal);
  if (
    tag === "turn_timeout" ||
    tag === "port_exit" ||
    tag === "response_timeout" ||
    tag === "network_error" ||
    tag === "network_disconnected" ||
    tag === "connection_reset" ||
    tag === "connection_refused" ||
    tag === "socket_closed"
  ) {
    return true;
  }
  return retryableHttpSignal(signal, 0);
}

function failureTag(value: unknown): string | null {
  if (typeof value === "string") {
    return failureTagFromString(value);
  }
  if (!isObj(value)) {
    return null;
  }
  for (const key of ["tag", "type", "code", "shutdown", "outcome"]) {
    const field = value[key];
    if (typeof field === "string" && field.trim() !== "") {
      return field.trim();
    }
  }
  return (
    failureTag(value.reason) ??
    failureTag(value.error) ??
    failureTag(value.payload) ??
    failureTag(value.params) ??
    failureTag(value.details) ??
    failureTag(value.message)
  );
}

function failureTagFromString(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed === "") {
    return null;
  }
  try {
    return failureTag(JSON.parse(trimmed));
  } catch {
    // Keep scanning below.
  }
  const jsonTag = /"(?:tag|type|code|shutdown|outcome)"\s*:\s*"([^"]+)"/.exec(trimmed);
  if (jsonTag) {
    return jsonTag[1] ?? null;
  }
  for (const tag of [
    "turn_input_required",
    "approval_required",
    "input_required",
    "needs_input",
    "turn_timeout",
    "port_exit",
    "response_timeout",
    "turn_cancelled",
    "turn_failed",
    "unsupported_tool_call",
    "tool_call_failed",
  ]) {
    if (trimmed.includes(tag)) {
      return tag;
    }
  }
  return null;
}

function retryableHttpSignal(value: unknown, depth: number): boolean {
  if (depth > 4) {
    return false;
  }
  if (typeof value === "string") {
    return /\b(?:HTTP\s*)?(429|5\d\d)\b/i.test(value);
  }
  if (!isObj(value)) {
    return false;
  }
  const status = httpStatus(value);
  if (status === 429 || (status >= 500 && status <= 599)) {
    return true;
  }
  return ["reason", "error", "payload", "params", "details", "cause", "message"].some((key) =>
    retryableHttpSignal(value[key], depth + 1),
  );
}

function httpStatus(value: Record<string, unknown>): number {
  for (const key of ["status", "statusCode", "http_status", "httpStatus", "code"]) {
    const status = integerFromUnknown(value[key]);
    if (status !== null) {
      return status;
    }
  }
  return 0;
}

function integerFromUnknown(value: unknown): number | null {
  if (typeof value === "number" && Number.isInteger(value)) {
    return value;
  }
  if (typeof value === "string" && /^\d+$/.test(value.trim())) {
    return Number.parseInt(value.trim(), 10);
  }
  return null;
}

// ---- blocking --------------------------------------------------------------

function stopAndBlockIssue(
  state: State,
  issueId: string,
  entry: RunningEntry,
  error: string,
): State {
  stopRunningTask(
    entry.task ?? null,
    entry.ref,
    cancellationReason("issue_blocked_input_required", { error }),
  );
  return blockIssueFromEntry(state, issueId, entry, error);
}

function blockIssueFromEntry(
  state: State,
  issueId: string,
  entry: RunningEntry,
  error: string,
  disposition: FailureDispositionKind = "blocked",
): State {
  const lastMessage = entry.blocker_codex_message ?? entry.last_codex_message;
  const lastEvent = entry.blocker_codex_event ?? entry.last_codex_event;
  const lastTimestamp = entry.blocker_codex_timestamp ?? entry.last_codex_timestamp;
  const sessionId = entry.blocker_session_id ?? runningEntrySessionId(entry);
  const payload = rawBlockerPayload(lastMessage);
  const prompt = operatorPromptFromPayload(payload);
  const blockedEntry: BlockedEntry = {
    issue_id: issueId,
    identifier: (entry.identifier as string | null | undefined) ?? issueId,
    issue: entry.issue,
    title: isIssue(entry.issue) ? entry.issue.title : null,
    issue_url: isIssue(entry.issue) ? entry.issue.url : null,
    run_kind: entry.run_kind ?? "normal",
    backend: entry.backend ?? null,
    worker_host: entry.worker_host ?? null,
    workspace_path: entry.workspace_path ?? null,
    session_id: sessionId,
    error,
    blocked_reason: error,
    disposition,
    operator_prompt: prompt,
    raw_blocker_payload: payload,
    manual_recovery: manualRecoveryInfo(disposition, error, prompt, payload, sessionId),
    retry_attempt: normalizeRetryAttempt(entry.retry_attempt),
    blocked_at: new Date(),
    last_codex_message: lastMessage,
    last_codex_event: lastEvent,
    last_codex_timestamp: lastTimestamp,
  };
  return {
    ...state,
    running: omitKey(state.running, issueId),
    retry_attempts: omitKey(state.retry_attempts, issueId),
    claimed: new Set(state.claimed).add(issueId),
    blocked: { ...state.blocked, [issueId]: blockedEntry },
  };
}

function blockIssueFromRetryMetadata(
  state: State,
  issueId: string,
  attempt: number,
  metadata: RetryMetadata,
  error: string,
): State {
  const sessionId = null;
  const payload = metadata.error ?? null;
  const blockedEntry: BlockedEntry = {
    issue_id: issueId,
    identifier: metadata.identifier ?? issueId,
    issue_url: metadata.issue_url ?? null,
    run_kind: metadata.run_kind ?? "normal",
    worker_host: metadata.worker_host ?? null,
    workspace_path: metadata.workspace_path ?? null,
    session_id: sessionId,
    error,
    blocked_reason: error,
    disposition: "terminal",
    operator_prompt: null,
    raw_blocker_payload: payload,
    manual_recovery: manualRecoveryInfo("terminal", error, null, payload, sessionId),
    retry_attempt: attempt,
    blocked_at: new Date(),
    last_codex_message: payload,
    last_codex_event: "retry_attempts_exhausted",
    last_codex_timestamp: new Date(),
  };
  return {
    ...state,
    retry_attempts: omitKey(state.retry_attempts, issueId),
    claimed: new Set(state.claimed).add(issueId),
    blocked: { ...state.blocked, [issueId]: blockedEntry },
  };
}

function manualRecoveryInfo(
  disposition: FailureDispositionKind,
  error: string,
  prompt: string | null,
  payload: unknown,
  sessionId: string | null,
): ManualRecoveryInfo {
  return {
    action: manualRecoveryAction(disposition, error, prompt, payload),
    reason: error,
    prompt,
    payload,
    session_id: sessionId,
    automatic_retry: false,
    resume_supported: false,
    rerun_supported: true,
  };
}

function manualRecoveryAction(
  disposition: FailureDispositionKind,
  error: string,
  prompt: string | null,
  payload: unknown,
): string {
  if (disposition === "terminal") {
    return "inspect_failure_then_rerun";
  }
  if (inputOrApprovalRecovery(error, prompt, payload)) {
    return "provide_required_input_or_approval_then_rerun";
  }
  if (configurationOrPermissionRecovery(error, payload)) {
    return "fix_configuration_or_permissions_then_rerun";
  }
  return "inspect_failure_then_rerun";
}

function inputOrApprovalRecovery(error: string, prompt: string | null, payload: unknown): boolean {
  const normalized = error.toLowerCase();
  return (
    prompt !== null ||
    normalized.includes("requires operator input") ||
    normalized.includes("requires approval") ||
    codexMessageMethod(payload) === "mcpServer/elicitation/request" ||
    inputRequiredReason(payload) !== null
  );
}

function configurationOrPermissionRecovery(error: string, payload: unknown): boolean {
  const normalized = `${error} ${inspectReason(payload)}`.toLowerCase();
  return (
    normalized.includes("config") ||
    normalized.includes("permission") ||
    normalized.includes("invalid_workspace") ||
    normalized.includes("workspace_path") ||
    normalized.includes("unsupported")
  );
}

function rawBlockerPayload(message: unknown): unknown {
  const payload = summarizedMessagePayload(message);
  if (isObj(payload)) {
    const reason = payload.reason;
    if (isObj(reason) && "payload" in reason) {
      return reason.payload;
    }
    if ("payload" in payload && !("method" in payload)) {
      return payload.payload;
    }
  }
  return payload;
}

function summarizedMessagePayload(message: unknown): unknown {
  if (isObj(message) && "message" in message) {
    return message.message;
  }
  return message;
}

function operatorPromptFromPayload(payload: unknown): string | null {
  for (const path of [
    ["params", "message"],
    ["params", "prompt"],
    ["params", "reason"],
    ["params", "title"],
    ["message"],
    ["prompt"],
    ["reason"],
    ["title"],
  ]) {
    const value = valueAtPath(payload, path);
    if (typeof value === "string" && value.trim() !== "") {
      return value.trim();
    }
  }
  return null;
}

function valueAtPath(payload: unknown, path: string[]): unknown {
  let current: unknown = payload;
  for (const key of path) {
    if (!isObj(current)) {
      return null;
    }
    current = current[key];
  }
  return current;
}

// ---- completion / retry bookkeeping ----------------------------------------

function completeIssue(state: State, issueId: string): State {
  return {
    ...state,
    completed: new Set(state.completed).add(issueId),
    retry_attempts: omitKey(state.retry_attempts, issueId),
  };
}

function normalizeRetryAttempt(attempt: number | null | undefined): number {
  return typeof attempt === "number" && Number.isInteger(attempt) && attempt > 0 ? attempt : 0;
}

function nextRetryAttemptFromRunning(entry: RunningEntry): number | null {
  const attempt = entry.retry_attempt;
  if (typeof attempt === "number" && Number.isInteger(attempt) && attempt > 0) {
    return attempt + 1;
  }
  return null;
}

function pickRetryString(
  issueId: string | null,
  previous: RetryAttempt | undefined,
  fromMetadata: string | null | undefined,
  fromPrevious: string | null | undefined,
): string | null {
  return fromMetadata ?? fromPrevious ?? issueId;
}

function runningEntrySessionId(entry: RunningEntry | null | undefined): string {
  if (entry && typeof entry.session_id === "string") {
    return entry.session_id;
  }
  return "n/a";
}

function findIssueById(issues: Issue[], issueId: string): Issue | null {
  return issues.find((issue) => issue.id === issueId) ?? null;
}

function findIssueIdForRef(running: Record<string, RunningEntry>, ref: unknown): string | null {
  for (const [issueId, entry] of Object.entries(running)) {
    if (entry.ref === ref) {
      return issueId;
    }
  }
  return null;
}

function findBlockedEntry(state: State, issueIdentifier: string): [string, BlockedEntry] | null {
  for (const [issueId, entry] of Object.entries(state.blocked)) {
    if (issueId === issueIdentifier || entry.identifier === issueIdentifier) {
      return [issueId, entry];
    }
  }
  return null;
}

function maybePutRuntimeValue(
  entry: RunningEntry,
  key: "worker_host" | "workspace_path",
  value: string | null | undefined,
): RunningEntry {
  if (value === null || value === undefined) {
    return entry;
  }
  return { ...entry, [key]: value };
}

// ---- codex update integration ----------------------------------------------

function integrateCodexUpdate(
  entry: RunningEntry,
  update: CodexUpdate,
): { entry: RunningEntry; tokenDelta: TokenDelta } {
  const tokenDelta = extractTokenDelta(entry, update);
  const codexInput = numOr0(entry.codex_input_tokens);
  const codexOutput = numOr0(entry.codex_output_tokens);
  const codexTotal = numOr0(entry.codex_total_tokens);
  const lastReportedInput = numOr0(entry.codex_last_reported_input_tokens);
  const lastReportedOutput = numOr0(entry.codex_last_reported_output_tokens);
  const lastReportedTotal = numOr0(entry.codex_last_reported_total_tokens);
  const turnCount = numOr0(entry.turn_count);
  const priorSessionId = typeof entry.session_id === "string" ? entry.session_id : null;
  const nextSessionId = sessionIdForUpdate(entry.session_id ?? null, update);
  const summary = summarizeCodexUpdate(update);
  const blockerEvent = blockerEventForUpdate(update, summary);
  const blockerUpdate =
    blockerEvent === null
      ? {}
      : blockerFieldsForUpdate(
          entry,
          blockerEvent,
          update.event,
          summary,
          update.timestamp,
          nextSessionId,
        );

  return {
    entry: {
      ...entry,
      last_codex_timestamp: update.timestamp,
      last_codex_message: summary,
      session_id: nextSessionId,
      last_codex_event: update.event,
      codex_app_server_pid: codexAppServerPidForUpdate(entry.codex_app_server_pid ?? null, update),
      codex_input_tokens: codexInput + tokenDelta.input_tokens,
      codex_output_tokens: codexOutput + tokenDelta.output_tokens,
      codex_total_tokens: codexTotal + tokenDelta.total_tokens,
      codex_last_reported_input_tokens: Math.max(lastReportedInput, tokenDelta.input_reported),
      codex_last_reported_output_tokens: Math.max(lastReportedOutput, tokenDelta.output_reported),
      codex_last_reported_total_tokens: Math.max(lastReportedTotal, tokenDelta.total_reported),
      turn_count: turnCountForUpdate(turnCount, priorSessionId, update),
      ...blockerUpdate,
    },
    tokenDelta,
  };
}

function blockerFieldsForUpdate(
  entry: RunningEntry,
  event: string,
  updateEvent: string,
  message: unknown,
  timestamp: Date,
  sessionId: string | null,
): Partial<RunningEntry> {
  const hasExistingBlocker = typeof entry.blocker_codex_event === "string";
  if (hasExistingBlocker) {
    return {};
  }
  return {
    blocker_codex_message: message,
    blocker_codex_event: event,
    blocker_codex_timestamp: timestamp,
    blocker_session_id: sessionId,
  };
}

function sessionIdForUpdate(existing: string | null, update: CodexUpdate): string | null {
  return typeof update.sessionId === "string" ? update.sessionId : existing;
}

function codexAppServerPidForUpdate(existing: string | null, update: CodexUpdate): string | null {
  // Prefer the neutral envelope alias; fall back to the frozen codex name.
  const pid = update.backendPid ?? update.codexAppServerPid;
  if (typeof pid === "string") {
    return pid;
  }
  if (typeof pid === "number") {
    return String(pid);
  }
  if (Array.isArray(pid)) {
    return pid.join("");
  }
  return existing;
}

function turnCountForUpdate(
  existingCount: number,
  existingSessionId: string | null,
  update: CodexUpdate,
): number {
  if (update.event === "session_started" && typeof update.sessionId === "string") {
    return update.sessionId === existingSessionId ? existingCount : existingCount + 1;
  }
  return existingCount;
}

function summarizeCodexUpdate(update: CodexUpdate): {
  event: string;
  message: unknown;
  timestamp: Date;
} {
  return {
    event: update.event,
    message: update.payload ?? update.raw ?? terminalUpdateDetails(update),
    timestamp: update.timestamp,
  };
}

function terminalUpdateDetails(update: CodexUpdate): unknown {
  if ("reason" in update) {
    return { reason: update.reason };
  }
  if ("error" in update) {
    return { error: update.error };
  }
  return null;
}

function applyCodexTokenDelta(state: State, tokenDelta: TokenDelta): State {
  return { ...state, codex_totals: applyTokenDelta(state.codex_totals, tokenDelta) };
}

function applyCodexRateLimits(state: State, update: CodexUpdate): State {
  const rateLimits = extractRateLimits(update);
  if (isObj(rateLimits)) {
    return { ...state, codex_rate_limits: rateLimits };
  }
  return state;
}

// ---- token / rate-limit extraction -----------------------------------------

type TokenDelta = CodexTotals & {
  input_reported: number;
  output_reported: number;
  total_reported: number;
};

function extractTokenDelta(entry: RunningEntry, update: CodexUpdate): TokenDelta {
  const usage = extractTokenUsage(update);
  const input = computeTokenDelta(entry, "input", usage, "codex_last_reported_input_tokens");
  const output = computeTokenDelta(entry, "output", usage, "codex_last_reported_output_tokens");
  const total = computeTokenDelta(entry, "total", usage, "codex_last_reported_total_tokens");
  return {
    input_tokens: input.delta,
    output_tokens: output.delta,
    total_tokens: total.delta,
    seconds_running: 0,
    input_reported: input.reported,
    output_reported: output.reported,
    total_reported: total.reported,
  };
}

function computeTokenDelta(
  entry: RunningEntry,
  tokenKey: "input" | "output" | "total",
  usage: Record<string, unknown>,
  reportedKey: keyof RunningEntry,
): { delta: number; reported: number } {
  const nextTotal = getTokenUsage(usage, tokenKey);
  const prevReported = numOr0(entry[reportedKey as string]);
  const delta =
    typeof nextTotal === "number" && nextTotal >= prevReported ? nextTotal - prevReported : 0;
  return {
    delta: Math.max(delta, 0),
    reported: typeof nextTotal === "number" ? nextTotal : prevReported,
  };
}

function extractTokenUsage(update: CodexUpdate): Record<string, unknown> {
  // Normalized envelope: a flat cumulative token map on `update.usage` is
  // authoritative (a backend that reports totals directly, e.g. claude-code's
  // result.usage). The codex deep-path sniffing below is kept as a fallback.
  if (isObj(update.usage) && integerTokenMap(update.usage)) {
    return update.usage;
  }
  const payloads = [update.usage, update.payload, update];
  for (const payload of payloads) {
    const found = absoluteTokenUsageFromPayload(payload);
    if (found) {
      return found;
    }
  }
  for (const payload of payloads) {
    const found = turnCompletedUsageFromPayload(payload);
    if (found) {
      return found;
    }
  }
  return {};
}

function absoluteTokenUsageFromPayload(payload: unknown): Record<string, unknown> | null {
  if (!isObj(payload)) {
    return null;
  }
  const paths = [
    ["params", "msg", "payload", "info", "total_token_usage"],
    ["params", "msg", "info", "total_token_usage"],
    ["params", "tokenUsage", "total"],
    ["tokenUsage", "total"],
  ];
  for (const path of paths) {
    const value = mapAtPath(payload, path);
    if (isObj(value) && integerTokenMap(value)) {
      return value;
    }
  }
  return null;
}

function turnCompletedUsageFromPayload(payload: unknown): Record<string, unknown> | null {
  if (!isObj(payload)) {
    return null;
  }
  const method = payload.method;
  if (method === "turn/completed" || method === "turn_completed") {
    const direct = payload.usage ?? mapAtPath(payload, ["params", "usage"]);
    if (isObj(direct) && integerTokenMap(direct)) {
      return direct;
    }
  }
  return null;
}

function extractRateLimits(update: CodexUpdate): Record<string, unknown> | null {
  return (
    rateLimitsFromPayload(update.rate_limits) ??
    rateLimitsFromPayload(update.payload) ??
    rateLimitsFromPayload(update)
  );
}

function rateLimitsFromPayload(payload: unknown): Record<string, unknown> | null {
  if (Array.isArray(payload)) {
    return rateLimitPayloads(payload);
  }
  if (!isObj(payload)) {
    return null;
  }
  const direct = payload.rate_limits;
  if (rateLimitsMap(direct)) {
    return direct;
  }
  if (rateLimitsMap(payload)) {
    return payload;
  }
  return rateLimitPayloads(Object.values(payload));
}

function rateLimitPayloads(values: unknown[]): Record<string, unknown> | null {
  for (const value of values) {
    const found = rateLimitsFromPayload(value);
    if (found) {
      return found;
    }
  }
  return null;
}

function rateLimitsMap(payload: unknown): payload is Record<string, unknown> {
  if (!isObj(payload)) {
    return false;
  }
  const limitId = payload.limit_id ?? payload.limit_name;
  const hasBuckets = ["primary", "secondary", "credits"].some((key) => key in payload);
  return limitId !== null && limitId !== undefined && hasBuckets;
}

function mapAtPath(payload: unknown, path: string[]): unknown {
  let acc: unknown = payload;
  for (const key of path) {
    if (isObj(acc) && key in acc) {
      acc = acc[key];
    } else {
      return null;
    }
  }
  return acc;
}

const TOKEN_FIELDS = [
  "input_tokens",
  "output_tokens",
  "total_tokens",
  "prompt_tokens",
  "completion_tokens",
  "inputTokens",
  "outputTokens",
  "totalTokens",
  "promptTokens",
  "completionTokens",
];

function integerTokenMap(payload: Record<string, unknown>): boolean {
  return TOKEN_FIELDS.some((field) => integerLike(payload[field]) !== null);
}

const TOKEN_USAGE_FIELDS: Record<"input" | "output" | "total", string[]> = {
  input: ["input_tokens", "prompt_tokens", "input", "promptTokens", "inputTokens"],
  output: [
    "output_tokens",
    "completion_tokens",
    "output",
    "completion",
    "outputTokens",
    "completionTokens",
  ],
  total: ["total_tokens", "total", "totalTokens"],
};

function getTokenUsage(
  usage: Record<string, unknown>,
  tokenKey: "input" | "output" | "total",
): number | null {
  for (const field of TOKEN_USAGE_FIELDS[tokenKey]) {
    const value = integerLike(usage[field]);
    if (value !== null) {
      return value;
    }
  }
  return null;
}

function integerLike(value: unknown): number | null {
  if (typeof value === "number" && Number.isInteger(value) && value >= 0) {
    return value;
  }
  if (typeof value === "string") {
    const match = /^[+-]?\d+/.exec(value.trim());
    if (match) {
      const num = Number.parseInt(match[0], 10);
      return num >= 0 ? num : null;
    }
  }
  return null;
}

// ---- snapshot construction -------------------------------------------------

function blockedIssueState(entry: BlockedEntry): string | null | undefined {
  return isIssue(entry.issue) ? entry.issue.state : null;
}

function blockedIssueUrl(entry: BlockedEntry): string | null | undefined {
  if (isIssue(entry.issue)) {
    return entry.issue.url;
  }
  return typeof entry.issue_url === "string" ? entry.issue_url : null;
}

function nextPollInMs(nextPollDueAtMs: number | null | undefined, now: number): number | null {
  if (typeof nextPollDueAtMs !== "number") {
    return null;
  }
  return Math.max(0, nextPollDueAtMs - now);
}

export class Orchestrator {
  private state: State;
  private mailbox: Promise<unknown> = Promise.resolve();
  private timers = new Set<ReturnType<typeof setTimeout>>();
  private stopped = false;

  constructor() {
    this.state = newState({
      next_poll_due_at_ms: null,
      poll_check_in_progress: false,
      tick_timer_ref: null,
      tick_token: null,
    });
  }

  // ---- lifecycle -----------------------------------------------------------

  // Port of `init/1`.
  async start(): Promise<void> {
    const config = settingsBang();
    this.state = newState({
      poll_interval_ms: config.polling.intervalMs,
      max_concurrent_agents: config.agent.maxConcurrentAgents,
      next_poll_due_at_ms: nowMs(),
      poll_check_in_progress: false,
      tick_timer_ref: null,
      tick_token: null,
    });
    await this.runTerminalWorkspaceCleanup();
    this.state = this.scheduleTick(this.state, 0);
  }

  // Port of `GenServer.stop/1`: clears every outstanding timer so the process
  // can be reclaimed (the test-suite equivalent of `Process.exit/2`).
  stop(): void {
    this.stopped = true;
    for (const timer of this.timers) {
      clearTimeout(timer);
    }
    this.timers.clear();
  }

  // ---- mailbox -------------------------------------------------------------

  private enqueue<T>(fn: () => T | Promise<T>): Promise<T> {
    const result = this.mailbox.then(() => fn());
    this.mailbox = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  cast(msg: Info): Promise<void> {
    return this.enqueue(async () => {
      if (this.stopped) {
        return;
      }
      this.state = await this.handleInfo(this.state, msg);
      notifyDashboard();
    });
  }

  call(
    msg:
      | { tag: "snapshot" }
      | { tag: "request_refresh" }
      | { tag: "rerun_blocked_issue"; issueIdentifier: string },
  ): Promise<Snapshot | RequestRefreshReply | RerunBlockedReply> {
    return this.enqueue(() => {
      if (msg.tag === "snapshot") {
        return this.handleSnapshot(this.state).then((result) => {
          this.state = result.state;
          return result.reply;
        });
      }
      if (msg.tag === "rerun_blocked_issue") {
        return this.handleRerunBlockedIssue(this.state, msg.issueIdentifier).then((result) => {
          this.state = result.state;
          return result.reply;
        });
      }
      const { reply, state } = this.handleRequestRefresh(this.state);
      this.state = state;
      return reply;
    });
  }

  // ---- public API (Elixir `snapshot/2`, `request_refresh/1`) ---------------

  async snapshot(timeoutMs: number): Promise<Snapshot | "timeout" | "unavailable"> {
    if (this.stopped) {
      return "unavailable";
    }
    const callPromise = this.call({ tag: "snapshot" }) as Promise<Snapshot>;
    // The timer must be cleared once the race settles: dashboard/SSE polling
    // calls this continuously, and every leaked handle stayed in `timers`
    // forever (unbounded growth, and the process kept being kept alive).
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), timeoutMs);
      this.timers.add(timer);
    });
    try {
      return await Promise.race([callPromise, timeout]);
    } finally {
      if (timer !== undefined) {
        clearTimeout(timer);
        this.timers.delete(timer);
      }
    }
  }

  requestRefresh(): Promise<RequestRefreshReply> {
    return this.call({ tag: "request_refresh" }) as Promise<RequestRefreshReply>;
  }

  rerunBlockedIssue(issueIdentifier: string): Promise<RerunBlockedReply> {
    return this.call({
      tag: "rerun_blocked_issue",
      issueIdentifier,
    }) as Promise<RerunBlockedReply>;
  }

  // ---- test seams (Elixir `:sys.get_state` / `:sys.replace_state`) ---------

  getState(): State {
    return this.state;
  }

  replaceState(fn: (state: State) => State): void {
    this.state = fn(this.state);
  }

  // Stalls the serialized mailbox for `ms` (used to exercise `snapshot`
  // timeouts, mirroring an unresponsive GenServer).
  stallForTest(ms: number): void {
    this.enqueue(
      () =>
        new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, ms);
          this.timers.add(timer);
        }),
    );
  }

  handleRequestRefreshForTest(state: State): { reply: RequestRefreshReply; state: State } {
    return this.handleRequestRefresh(state);
  }

  handleTickInfoForTest(state: State, token: symbol | null): Promise<State> {
    return this.handleInfo(state, { tag: "tick", token });
  }

  // ---- handlers ------------------------------------------------------------

  private async handleInfo(state: State, msg: Info): Promise<State> {
    switch (msg.tag) {
      case "tick":
        return this.handleTick(state, msg.token);
      case "run_poll_cycle":
        return this.handleRunPollCycle(state);
      case "down":
        return this.handleDown(state, msg.ref, msg.reason);
      case "worker_runtime_info":
        return this.handleWorkerRuntimeInfo(state, msg.issueId, msg.runtimeInfo);
      case "codex_worker_update":
        return this.handleCodexWorkerUpdate(state, msg.issueId, msg.update);
      case "retry_issue":
        return this.handleRetryIssueInfo(state, msg.issueId, msg.retryToken);
    }
  }

  private handleTick(state: State, token: symbol | null): State {
    if (token !== null && token !== state.tick_token) {
      return state;
    }
    let next = refreshRuntimeConfig(state);
    next = {
      ...next,
      poll_check_in_progress: true,
      next_poll_due_at_ms: null,
      tick_timer_ref: null,
      tick_token: null,
    };
    this.schedulePollCycleStart();
    return next;
  }

  private async handleRunPollCycle(state: State): Promise<State> {
    let next = refreshRuntimeConfig(state);
    next = await this.maybeDispatch(next);
    next = this.scheduleTick(next, next.poll_interval_ms ?? 0);
    return { ...next, poll_check_in_progress: false };
  }

  private handleDown(state: State, ref: unknown, reason: unknown): State {
    const issueId = findIssueIdForRef(state.running, ref);
    if (issueId === null) {
      return state;
    }
    const entry = state.running[issueId] as RunningEntry;
    let next: State = { ...state, running: omitKey(state.running, issueId) };
    next = recordSessionCompletionTotals(next, entry);
    const sessionId = runningEntrySessionId(entry);
    next = this.handleAgentDown(reason, next, issueId, entry, sessionId);
    logger.info(
      `Agent task finished for issue_id=${issueId} session_id=${sessionId} reason=${inspectReason(reason)}`,
    );
    return next;
  }

  private handleAgentDown(
    reason: unknown,
    state: State,
    issueId: string,
    entry: RunningEntry,
    sessionId: string,
  ): State {
    if (reason === "normal") {
      if (inputRequiredBlocker(entry)) {
        return this.blockInputRequiredAgentDown(state, issueId, entry, sessionId, reason);
      }
      if (entry.run_kind === "review") {
        logger.info(
          `Review agent completed for issue_id=${issueId} session_id=${sessionId}; returning control to state polling`,
        );
        return releaseIssueClaim(completeIssue(state, issueId), issueId);
      }
      logger.info(
        `Agent task completed for issue_id=${issueId} session_id=${sessionId}; scheduling active-state continuation check`,
      );
      return this.scheduleIssueRetry(completeIssue(state, issueId), issueId, 1, {
        identifier: entry.identifier ?? null,
        issue_url: isIssue(entry.issue) ? entry.issue.url : null,
        delay_type: "continuation",
        run_kind: entry.run_kind ?? "normal",
        worker_host: entry.worker_host ?? null,
        workspace_path: entry.workspace_path ?? null,
      });
    }
    if (inputRequiredBlocker(entry)) {
      return this.blockInputRequiredAgentDown(state, issueId, entry, sessionId, reason);
    }
    const disposition = classifyAgentFailure(reason, entry);
    if (disposition.kind === "blocked") {
      logger.warning(
        `Agent task blocked for issue_id=${issueId} issue_identifier=${entry.identifier} session_id=${sessionId}: ${disposition.error}`,
      );
      return blockIssueFromEntry(state, issueId, entry, disposition.error);
    }
    return this.retryAgentDown(state, issueId, entry, sessionId, disposition.error);
  }

  private blockInputRequiredAgentDown(
    state: State,
    issueId: string,
    entry: RunningEntry,
    sessionId: string,
    reason: unknown,
  ): State {
    const error = blockerError(entry, `agent exited: ${inspectReason(reason)}`);
    logger.warning(
      `Agent task blocked for issue_id=${issueId} issue_identifier=${entry.identifier} session_id=${sessionId}: ${error}`,
    );
    return blockIssueFromEntry(state, issueId, entry, error);
  }

  private retryAgentDown(
    state: State,
    issueId: string,
    entry: RunningEntry,
    sessionId: string,
    error: string,
  ): State {
    logger.warning(
      `Agent task exited for issue_id=${issueId} session_id=${sessionId} reason=${error}; scheduling retry`,
    );
    return this.scheduleIssueRetry(state, issueId, nextRetryAttemptFromRunning(entry), {
      identifier: entry.identifier ?? null,
      issue_url: isIssue(entry.issue) ? entry.issue.url : null,
      error,
      retry_class: "retryable",
      run_kind: entry.run_kind ?? "normal",
      worker_host: entry.worker_host ?? null,
      workspace_path: entry.workspace_path ?? null,
    });
  }

  private handleWorkerRuntimeInfo(
    state: State,
    issueId: string,
    runtimeInfo: { worker_host?: string | null; workspace_path?: string | null },
  ): State {
    const entry = state.running[issueId];
    if (entry === undefined) {
      return state;
    }
    let updated = maybePutRuntimeValue(entry, "worker_host", runtimeInfo.worker_host);
    updated = maybePutRuntimeValue(updated, "workspace_path", runtimeInfo.workspace_path);
    return { ...state, running: { ...state.running, [issueId]: updated } };
  }

  private handleCodexWorkerUpdate(state: State, issueId: string, update: CodexUpdate): State {
    const entry = state.running[issueId];
    if (entry === undefined) {
      return state;
    }
    const { entry: updatedEntry, tokenDelta } = integrateCodexUpdate(entry, update);
    let next = applyCodexTokenDelta(state, tokenDelta);
    next = applyCodexRateLimits(next, update);
    return { ...next, running: { ...next.running, [issueId]: updatedEntry } };
  }

  private async handleRetryIssueInfo(
    state: State,
    issueId: string,
    retryToken: symbol,
  ): Promise<State> {
    const popped = popRetryAttemptState(state, issueId, retryToken);
    if (!popped.ok) {
      return state;
    }
    return this.handleRetryIssue(popped.state, issueId, popped.attempt, popped.metadata);
  }

  // ---- handle_call ---------------------------------------------------------

  private async handleSnapshot(state: State): Promise<{ reply: Snapshot; state: State }> {
    const next = refreshRuntimeConfig(state);
    const now = new Date();
    const currentMs = nowMs();

    const running: SnapshotRunning[] = Object.entries(next.running).map(([issueId, entry]) => ({
      issue_id: issueId,
      identifier: entry.identifier,
      title: isIssue(entry.issue) ? entry.issue.title : null,
      backend: typeof entry.backend === "string" ? entry.backend : null,
      issue_url: isIssue(entry.issue) ? entry.issue.url : null,
      state: isIssue(entry.issue) ? entry.issue.state : null,
      worker_host: entry.worker_host ?? null,
      workspace_path: entry.workspace_path ?? null,
      session_id: typeof entry.session_id === "string" ? entry.session_id : null,
      codex_app_server_pid: entry.codex_app_server_pid ?? null,
      codex_input_tokens: numOr0(entry.codex_input_tokens),
      codex_output_tokens: numOr0(entry.codex_output_tokens),
      codex_total_tokens: numOr0(entry.codex_total_tokens),
      turn_count: numOr0(entry.turn_count),
      started_at: entry.started_at ?? null,
      last_codex_timestamp: entry.last_codex_timestamp ?? null,
      last_codex_message: entry.last_codex_message,
      last_codex_event: entry.last_codex_event ?? null,
      runtime_seconds: runningSeconds(entry.started_at ?? null),
    }));

    const retrying = Object.entries(next.retry_attempts).map(([issueId, retry]) => ({
      issue_id: issueId,
      attempt: retry.attempt,
      due_in_ms: Math.max(0, (retry.due_at_ms ?? currentMs) - currentMs),
      identifier: retry.identifier ?? null,
      issue_url: retry.issue_url ?? null,
      error: retry.error ?? null,
      worker_host: retry.worker_host ?? null,
      workspace_path: retry.workspace_path ?? null,
    }));

    const blocked = Object.entries(next.blocked).map(([issueId, entry]) => ({
      issue_id: issueId,
      identifier: entry.identifier ?? null,
      title: isIssue(entry.issue) ? entry.issue.title : (entry.title ?? null),
      backend: typeof entry.backend === "string" ? entry.backend : null,
      issue_url: blockedIssueUrl(entry),
      state: blockedIssueState(entry),
      worker_host: entry.worker_host ?? null,
      workspace_path: entry.workspace_path ?? null,
      session_id: entry.session_id ?? null,
      error: entry.error ?? null,
      blocked_reason: entry.blocked_reason ?? entry.error ?? null,
      disposition: entry.disposition ?? "blocked",
      operator_prompt: entry.operator_prompt ?? null,
      raw_blocker_payload: entry.raw_blocker_payload ?? null,
      manual_recovery: entry.manual_recovery ?? null,
      retry_attempt: entry.retry_attempt ?? null,
      blocked_at: entry.blocked_at ?? null,
      last_codex_timestamp: entry.last_codex_timestamp ?? null,
      last_codex_message: entry.last_codex_message ?? null,
      last_codex_event: entry.last_codex_event ?? null,
    }));

    const reply: Snapshot = {
      running,
      retrying,
      blocked,
      codex_totals: next.codex_totals,
      rate_limits: next.codex_rate_limits,
      polling: {
        checking: next.poll_check_in_progress === true,
        next_poll_in_ms: nextPollInMs(next.next_poll_due_at_ms, currentMs),
        poll_interval_ms: next.poll_interval_ms,
      },
    };
    return { reply, state: next };
  }

  private handleRequestRefresh(state: State): { reply: RequestRefreshReply; state: State } {
    const currentMs = nowMs();
    const alreadyDue =
      typeof state.next_poll_due_at_ms === "number" && state.next_poll_due_at_ms <= currentMs;
    const coalesced = state.poll_check_in_progress === true || alreadyDue;
    const next = coalesced ? state : this.scheduleTick(state, 0);
    return {
      reply: {
        queued: true,
        coalesced,
        requested_at: new Date(),
        operations: ["poll", "reconcile"],
      },
      state: next,
    };
  }

  private async handleRerunBlockedIssue(
    state: State,
    issueIdentifier: string,
  ): Promise<{ reply: RerunBlockedReply; state: State }> {
    const requestedAt = new Date();
    const found = findBlockedEntry(state, issueIdentifier);
    if (found === null) {
      return {
        reply: { queued: false, error: "blocked_issue_not_found", requested_at: requestedAt },
        state,
      };
    }
    const [issueId, entry] = found;
    const fetched = await Tracker.fetchIssueStatesByIds([issueId]);
    if (!fetched.ok) {
      return {
        reply: {
          queued: false,
          error: "issue_refresh_failed",
          requested_at: requestedAt,
          reason: fetched.error,
        },
        state,
      };
    }
    const issue = fetched.value[0] ?? null;
    const runKind = entry.run_kind === "review" ? "review" : "normal";
    if (issue === null || !blockedRerunCandidate(issue, runKind)) {
      return {
        reply: { queued: false, error: "issue_not_active", requested_at: requestedAt },
        state,
      };
    }
    if (
      !dispatchSlotsAvailable(issue, state) ||
      !workerSlotsAvailable(state, entry.worker_host ?? null)
    ) {
      return {
        reply: { queued: false, error: "no_dispatch_capacity", requested_at: requestedAt },
        state,
      };
    }

    const unblocked = {
      ...state,
      blocked: omitKey(state.blocked, issueId),
      retry_attempts: omitKey(state.retry_attempts, issueId),
      claimed: setWithout(state.claimed, issueId),
      review_queue: omitKey(state.review_queue, issueId),
    };
    const next = this.doDispatchIssue(unblocked, issue, null, entry.worker_host ?? null, runKind);
    if (!(issueId in next.running)) {
      return {
        reply: { queued: false, error: "no_dispatch_capacity", requested_at: requestedAt },
        state,
      };
    }
    return {
      reply: {
        queued: true,
        issue_id: issueId,
        issue_identifier: issue.identifier ?? null,
        requested_at: requestedAt,
        operation: "rerun_blocked",
      },
      state: next,
    };
  }

  // ---- poll cycle ----------------------------------------------------------

  private async maybeDispatch(state: State): Promise<State> {
    let next = await this.reconcileRunningIssues(state);
    next = await this.reconcileBlockedIssues(next);

    const validated = validate();
    if (!validated.ok) {
      logDispatchError(validated.error);
      return next;
    }
    const [reviewIssues, candidates] = await Promise.all([
      Tracker.fetchIssuesByStates([...REVIEW_OBSERVED_STATES]),
      Tracker.fetchCandidateIssues(),
    ]);
    if (reviewIssues.ok) {
      next = reconcileReviewQueue(reviewIssues.value, next);
    } else {
      logger.error(`Failed to fetch review issue states: ${inspectReason(reviewIssues.error)}`);
    }
    next = await this.dispatchReviewQueue(next);
    if (!candidates.ok) {
      logger.error(`Failed to fetch from tracker: ${inspectReason(candidates.error)}`);
      return next;
    }
    if (availableSlots(next) <= 0) {
      return next;
    }
    return this.chooseIssues(candidates.value, next);
  }

  private async reconcileRunningIssues(state: State): Promise<State> {
    const next = this.reconcileStalledRunningIssues(state);
    const runningIds = Object.keys(next.running);
    if (runningIds.length === 0) {
      return next;
    }
    const result = await Tracker.fetchIssueStatesByIds(runningIds);
    if (!result.ok) {
      logger.debug(
        `Failed to refresh running issue states: ${inspectReason(result.error)}; keeping active workers`,
      );
      return next;
    }
    const reconciled = reconcileRunningIssueStates(
      result.value,
      next,
      activeStateSet(),
      terminalStateSet(),
    );
    return reconcileMissingRunningIssueIds(reconciled, runningIds, result.value);
  }

  private reconcileStalledRunningIssues(state: State): State {
    // Stalling is backend-neutral, so `agent.stall_timeout_ms` wins when set;
    // `codex.stall_timeout_ms` remains the fallback (it predates pluggable
    // backends, and existing WORKFLOW.md files still set it there).
    const settings = settingsBang();
    const timeoutMs = settings.agent.stallTimeoutMs ?? settings.codex.stallTimeoutMs;
    if (timeoutMs <= 0 || Object.keys(state.running).length === 0) {
      return state;
    }
    const now = new Date();
    return Object.entries(state.running).reduce((acc, [issueId, entry]) => {
      if (issueId in acc.blocked) {
        return acc;
      }
      return this.restartStalledIssue(acc, issueId, entry, now, timeoutMs);
    }, state);
  }

  private restartStalledIssue(
    state: State,
    issueId: string,
    entry: RunningEntry,
    now: Date,
    timeoutMs: number,
  ): State {
    const elapsedMs = stallElapsedMs(entry, now);
    if (elapsedMs === null || elapsedMs <= timeoutMs) {
      return state;
    }
    const identifier = (entry.identifier as string | null | undefined) ?? issueId;
    const sessionId = runningEntrySessionId(entry);

    if (inputRequiredBlocker(entry)) {
      const error = blockerError(
        entry,
        `stalled for ${elapsedMs}ms after Codex requested operator input`,
      );
      logger.warning(
        `Issue blocked: issue_id=${issueId} issue_identifier=${identifier} session_id=${sessionId} elapsed_ms=${elapsedMs}; ${error}`,
      );
      return stopAndBlockIssue(recordSessionCompletionTotals(state, entry), issueId, entry, error);
    }

    logger.warning(
      `Issue stalled: issue_id=${issueId} issue_identifier=${identifier} session_id=${sessionId} elapsed_ms=${elapsedMs}; restarting with backoff`,
    );
    const terminated = terminateRunningIssue(
      state,
      issueId,
      false,
      cancellationReason("issue_stalled", { elapsed_ms: elapsedMs, session_id: sessionId }),
    );
    return this.scheduleIssueRetry(terminated, issueId, nextRetryAttemptFromRunning(entry), {
      identifier,
      issue_url: isIssue(entry.issue) ? entry.issue.url : null,
      error: `stalled for ${elapsedMs}ms without codex activity`,
      retry_class: "retryable",
      run_kind: entry.run_kind ?? "normal",
    });
  }

  private async reconcileBlockedIssues(state: State): Promise<State> {
    const blockedIds = Object.keys(state.blocked);
    if (blockedIds.length === 0) {
      return state;
    }
    const result = await Tracker.fetchIssueStatesByIds(blockedIds);
    if (!result.ok) {
      logger.debug(
        `Failed to refresh blocked issue states: ${inspectReason(result.error)}; keeping blocked issues`,
      );
      return state;
    }
    const reconciled = reconcileBlockedIssueStates(
      result.value,
      state,
      activeStateSet(),
      terminalStateSet(),
    );
    return reconcileMissingBlockedIssueIds(reconciled, blockedIds, result.value);
  }

  private async chooseIssues(issues: Issue[], state: State): Promise<State> {
    const activeStates = activeStateSet();
    const terminalStates = terminalStateSet();
    let next = state;
    for (const issue of sortIssuesForDispatch(issues)) {
      if (shouldDispatchIssue(issue, next, activeStates, terminalStates)) {
        next = await this.dispatchIssue(next, issue, null, null);
      }
    }
    return next;
  }

  private async dispatchReviewQueue(state: State): Promise<State> {
    let next = state;
    const entries = sortIssuesForDispatch(
      Object.values(next.review_queue).map((entry) => entry.issue),
    );
    for (const issue of entries) {
      if (shouldDispatchReviewIssue(issue, next)) {
        next = await this.dispatchReviewIssue(next, issue, null, null);
      }
    }
    return next;
  }

  // ---- dispatch ------------------------------------------------------------

  private async dispatchReviewIssue(
    state: State,
    issue: Issue,
    attempt: number | null,
    preferredWorkerHost: string | null,
  ): Promise<State> {
    if (typeof issue.id !== "string") {
      return state;
    }
    const outcome = await revalidateIssueForReviewDispatch(issue, (ids) =>
      Tracker.fetchIssueStatesByIds(ids),
    );
    if (outcome.kind === "ok") {
      return this.doDispatchIssue(state, outcome.issue, attempt, preferredWorkerHost, "review");
    }
    if (outcome.kind === "skip") {
      logger.info(
        `Skipping review dispatch; issue no longer in Human Review: ${issueContext(issue)}`,
      );
      return releaseIssueClaim(
        { ...state, review_queue: omitKey(state.review_queue, issue.id) },
        issue.id,
      );
    }
    logger.warning(
      `Skipping review dispatch; issue refresh failed for ${issueContext(issue)}: ${inspectReason(outcome.reason)}`,
    );
    return state;
  }

  private async dispatchIssue(
    state: State,
    issue: Issue,
    attempt: number | null,
    preferredWorkerHost: string | null,
  ): Promise<State> {
    const outcome = await revalidateIssueForDispatch(
      issue,
      (ids) => Tracker.fetchIssueStatesByIds(ids),
      terminalStateSet(),
    );
    if (outcome.kind === "ok") {
      return this.doDispatchIssue(state, outcome.issue, attempt, preferredWorkerHost, "normal");
    }
    if (outcome.kind === "skip") {
      logger.info(`Skipping dispatch; issue no longer active or visible: ${issueContext(issue)}`);
      return state;
    }
    logger.warning(
      `Skipping dispatch; issue refresh failed for ${issueContext(issue)}: ${inspectReason(outcome.reason)}`,
    );
    return state;
  }

  private doDispatchIssue(
    state: State,
    issue: Issue,
    attempt: number | null,
    preferredWorkerHost: string | null,
    runKind: RunKind,
  ): State {
    const workerHost = selectWorkerHost(state, preferredWorkerHost);
    if (workerHost === "no_worker_capacity") {
      logger.debug(`No SSH worker slots available for ${issueContext(issue)}`);
      return state;
    }
    return this.spawnIssueOnWorkerHost(state, issue, attempt, workerHost, runKind);
  }

  private spawnIssueOnWorkerHost(
    state: State,
    issue: Issue,
    attempt: number | null,
    workerHost: string | null,
    runKind: RunKind,
  ): State {
    const issueId = issue.id;
    if (issueId === null) {
      return state;
    }
    const ref = Symbol("agent-ref");
    let aborted = false;
    // Elixir's stop_running_task kills the worker process. Here stop() aborts
    // the signal so the runner tears the backend session (and its subprocess)
    // down; otherwise a stalled/terminal/blocked issue leaves the agent running
    // until turn_timeout_ms, and a retry can dispatch a second agent into the
    // same workspace concurrently.
    const abortController = new AbortController();
    const task: RunningTask = {
      stop(reason = cancellationReason("explicit_stop")) {
        aborted = true;
        abortController.abort(reason);
      },
    };
    AgentRunner.run(issue, (update) => this.onWorkerUpdate(update), {
      workerHost,
      attempt,
      rework: runKind === "normal" && attempt === null && isReworkState(issue.state),
      review: runKind === "review",
      signal: abortController.signal,
    })
      .then(() => {
        if (!aborted) {
          this.cast({ tag: "down", ref, reason: "normal" });
        }
      })
      .catch((error) => {
        if (!aborted) {
          this.cast({
            tag: "down",
            ref,
            reason: inspectReason(error),
          });
        }
      });

    logger.info(
      `Dispatching issue to agent: ${issueContext(issue)} attempt=${attempt} worker_host=${workerHost ?? "local"} run_kind=${runKind}`,
    );

    const entry: RunningEntry = {
      task,
      ref,
      identifier: issue.identifier,
      issue,
      run_kind: runKind,
      backend: settingsBang().agent.backend,
      worker_host: workerHost,
      workspace_path: null,
      session_id: null,
      last_codex_message: null,
      last_codex_timestamp: null,
      last_codex_event: null,
      codex_app_server_pid: null,
      codex_input_tokens: 0,
      codex_output_tokens: 0,
      codex_total_tokens: 0,
      codex_last_reported_input_tokens: 0,
      codex_last_reported_output_tokens: 0,
      codex_last_reported_total_tokens: 0,
      turn_count: 0,
      retry_attempt: normalizeRetryAttempt(attempt),
      started_at: new Date(),
    };

    return {
      ...state,
      running: { ...state.running, [issueId]: entry },
      claimed: new Set(state.claimed).add(issueId),
      retry_attempts: omitKey(state.retry_attempts, issueId),
      review_queue: omitKey(state.review_queue, issueId),
    };
  }

  private onWorkerUpdate(update: AgentRunner.WorkerUpdate): void {
    if (update.tag === "codex_worker_update") {
      this.cast({
        tag: "codex_worker_update",
        issueId: update.issueId,
        update: update.message as unknown as CodexUpdate,
      });
      return;
    }
    this.cast({
      tag: "worker_runtime_info",
      issueId: update.issueId,
      runtimeInfo: {
        worker_host: update.info.workerHost,
        workspace_path: update.info.workspacePath,
      },
    });
  }

  // ---- retry ---------------------------------------------------------------

  private async handleRetryIssue(
    state: State,
    issueId: string,
    attempt: number,
    metadata: RetryMetadata,
  ): Promise<State> {
    if (metadata.run_kind === "review") {
      return this.handleReviewRetryIssue(state, issueId, attempt, metadata);
    }
    const candidates = await Tracker.fetchCandidateIssues();
    if (!candidates.ok) {
      logger.warning(
        `Retry poll failed for issue_id=${issueId} issue_identifier=${metadata.identifier ?? issueId}: ${inspectReason(candidates.error)}`,
      );
      return this.scheduleIssueRetry(state, issueId, attempt + 1, {
        ...metadata,
        error: `retry poll failed: ${inspectReason(candidates.error)}`,
        retry_class: "retryable",
      });
    }
    const issue = findIssueById(candidates.value, issueId);
    return this.handleRetryIssueLookupLive(issue, state, issueId, attempt, metadata);
  }

  private async handleReviewRetryIssue(
    state: State,
    issueId: string,
    attempt: number,
    metadata: RetryMetadata,
  ): Promise<State> {
    const fetched = await Tracker.fetchIssueStatesByIds([issueId]);
    if (!fetched.ok) {
      logger.warning(
        `Review retry refresh failed for issue_id=${issueId} issue_identifier=${metadata.identifier ?? issueId}: ${inspectReason(fetched.error)}`,
      );
      return this.scheduleIssueRetry(state, issueId, attempt + 1, {
        ...metadata,
        error: `review retry refresh failed: ${inspectReason(fetched.error)}`,
        retry_class: "retryable",
        run_kind: "review",
      });
    }
    const issue = fetched.value[0] ?? null;
    if (issue !== null && reviewQueueCandidate(issue)) {
      return this.dispatchReviewIssue(
        {
          ...state,
          review_queue: { ...state.review_queue, [issueId]: { issue, enqueued_at: new Date() } },
        },
        issue,
        attempt,
        metadata.worker_host ?? null,
      );
    }
    logger.debug(
      `Review retry issue left Human Review, removing claim issue_id=${issueId} issue_identifier=${metadata.identifier ?? issueId}`,
    );
    return releaseIssueClaim(state, issueId);
  }

  private async handleRetryIssueLookupLive(
    issue: Issue | null,
    state: State,
    issueId: string,
    attempt: number,
    metadata: RetryMetadata,
  ): Promise<State> {
    if (issue === null) {
      logger.debug(`Issue no longer visible, removing claim issue_id=${issueId}`);
      return releaseIssueClaim(state, issueId);
    }
    const terminalStates = terminalStateSet();
    if (typeof issue.state === "string" && terminalStates.has(issue.state.trim().toLowerCase())) {
      logger.info(
        `Issue state is terminal: issue_id=${issueId} issue_identifier=${issue.identifier} state=${issue.state}; removing associated workspace`,
      );
      cleanupIssueWorkspace(issue.identifier ?? null, metadata.worker_host ?? null);
      return releaseIssueClaim(state, issueId);
    }
    if (retryCandidateIssue(issue, terminalStates)) {
      return this.handleActiveRetryLive(state, issue, attempt, metadata);
    }
    logger.debug(
      `Issue left active states, removing claim issue_id=${issueId} issue_identifier=${issue.identifier}`,
    );
    return releaseIssueClaim(state, issueId);
  }

  private async handleActiveRetryLive(
    state: State,
    issue: Issue,
    attempt: number,
    metadata: RetryMetadata,
  ): Promise<State> {
    if (
      dispatchSlotsAvailable(issue, state) &&
      workerSlotsAvailable(state, metadata.worker_host ?? null)
    ) {
      return this.dispatchIssue(state, issue, attempt, metadata.worker_host ?? null);
    }
    logger.debug(`No available slots for retrying ${issueContext(issue)}; retrying again`);
    if (issue.id === null) {
      return state;
    }
    return this.scheduleIssueRetry(state, issue.id, attempt, {
      ...metadata,
      identifier: issue.identifier,
      error: "no available orchestrator slots",
    });
  }

  private scheduleIssueRetry(
    state: State,
    issueId: string,
    attempt: number | null,
    metadata: RetryMetadata,
  ): State {
    const previous = state.retry_attempts[issueId] ?? { attempt: 0 };
    const nextAttempt =
      typeof attempt === "number" && Number.isInteger(attempt) ? attempt : previous.attempt + 1;
    const oldTimer = previous.timer_ref;
    if (oldTimer) {
      clearTimeout(oldTimer);
      this.timers.delete(oldTimer);
    }
    if (retryAttemptsExhausted(nextAttempt, metadata)) {
      const maxAttempts = settingsBang().agent.maxRetryAttempts;
      const error = `retry attempts exhausted after ${maxAttempts} attempts: ${metadata.error ?? "retryable agent failure"}`;
      logger.warning(
        `Retry exhausted issue_id=${issueId} issue_identifier=${metadata.identifier ?? issueId} attempts=${maxAttempts} error=${error}`,
      );
      return blockIssueFromRetryMetadata(state, issueId, maxAttempts, metadata, error);
    }
    const delayMs = retryDelay(nextAttempt, metadata);
    const retryToken = Symbol("retry");
    const dueAtMs = nowMs() + delayMs;
    const identifier = pickRetryString(issueId, previous, metadata.identifier, previous.identifier);
    const issueUrl = metadata.issue_url ?? previous.issue_url ?? null;
    const error = metadata.error ?? previous.error ?? null;
    const workerHost = metadata.worker_host ?? previous.worker_host ?? null;
    const workspacePath = metadata.workspace_path ?? previous.workspace_path ?? null;
    const runKind = metadata.run_kind ?? previous.run_kind;

    const timerRef = setTimeout(() => {
      this.timers.delete(timerRef);
      this.cast({ tag: "retry_issue", issueId, retryToken });
    }, delayMs);
    this.timers.add(timerRef);

    const errorSuffix = typeof error === "string" ? ` error=${error}` : "";
    logger.warning(
      `Retrying issue_id=${issueId} issue_identifier=${identifier} in ${delayMs}ms (attempt ${nextAttempt})${errorSuffix}`,
    );

    return {
      ...state,
      retry_attempts: {
        ...state.retry_attempts,
        [issueId]: {
          attempt: nextAttempt,
          timer_ref: timerRef,
          retry_token: retryToken,
          due_at_ms: dueAtMs,
          identifier,
          issue_url: issueUrl,
          error,
          worker_host: workerHost,
          workspace_path: workspacePath,
          ...(metadata.retry_class === undefined ? {} : { retry_class: metadata.retry_class }),
          ...(runKind === undefined ? {} : { run_kind: runKind }),
        },
      },
    };
  }

  // ---- timers --------------------------------------------------------------

  private scheduleTick(state: State, delayMs: number): State {
    if (state.tick_timer_ref) {
      clearTimeout(state.tick_timer_ref);
      this.timers.delete(state.tick_timer_ref);
    }
    const tickToken = Symbol("tick");
    const timerRef = setTimeout(() => {
      this.timers.delete(timerRef);
      this.cast({ tag: "tick", token: tickToken });
    }, delayMs);
    this.timers.add(timerRef);
    return {
      ...state,
      tick_timer_ref: timerRef,
      tick_token: tickToken,
      next_poll_due_at_ms: nowMs() + delayMs,
    };
  }

  private schedulePollCycleStart(): void {
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      this.cast({ tag: "run_poll_cycle" });
    }, POLL_TRANSITION_RENDER_DELAY_MS);
    this.timers.add(timer);
  }

  private async runTerminalWorkspaceCleanup(): Promise<void> {
    const result = await Tracker.fetchIssuesByStates(settingsBang().tracker.terminalStates);
    if (!result.ok) {
      logger.warning(
        `Skipping startup terminal workspace cleanup; failed to fetch terminal issues: ${inspectReason(result.error)}`,
      );
      return;
    }
    for (const issue of result.value) {
      if (typeof issue.identifier === "string") {
        cleanupIssueWorkspace(issue.identifier, null);
      }
    }
  }
}

function popRetryAttemptState(
  state: State,
  issueId: string,
  retryToken: symbol,
): { ok: true; attempt: number; metadata: RetryMetadata; state: State } | { ok: false } {
  const entry = state.retry_attempts[issueId];
  if (entry && entry.retry_token === retryToken) {
    const metadata: RetryMetadata = {
      identifier: entry.identifier ?? null,
      issue_url: entry.issue_url ?? null,
      error: entry.error ?? null,
      worker_host: entry.worker_host ?? null,
      workspace_path: entry.workspace_path ?? null,
      ...(entry.retry_class === undefined ? {} : { retry_class: entry.retry_class }),
      ...(entry.run_kind === undefined ? {} : { run_kind: entry.run_kind }),
    };
    return {
      ok: true,
      attempt: entry.attempt,
      metadata,
      state: { ...state, retry_attempts: omitKey(state.retry_attempts, issueId) },
    };
  }
  return { ok: false };
}

function refreshRuntimeConfig(state: State): State {
  const config = settingsBang();
  return {
    ...state,
    poll_interval_ms: config.polling.intervalMs,
    max_concurrent_agents: config.agent.maxConcurrentAgents,
  };
}

function logDispatchError(error: unknown): void {
  // TrackerError-shaped failures carry their own operator copy; the plugin
  // supplies it so the core stays provider-agnostic.
  if (
    isObj(error) &&
    typeof error.tag === "string" &&
    typeof error.code === "string" &&
    typeof error.message === "string"
  ) {
    logger.error(error.message);
    return;
  }
  const tag = isObj(error) && typeof error.tag === "string" ? error.tag : null;
  switch (tag) {
    case "missing_linear_api_token":
      logger.error("Linear API token missing in WORKFLOW.md");
      break;
    case "missing_linear_project_slug":
      logger.error("Linear project slug missing in WORKFLOW.md");
      break;
    case "missing_tracker_kind":
      logger.error("Tracker kind missing in WORKFLOW.md");
      break;
    default:
      logger.error(`Invalid WORKFLOW.md config: ${inspectReason(error)}`);
  }
}
