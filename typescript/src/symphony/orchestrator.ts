// Literal port of `symphony_elixir/orchestrator.ex` — Commit 1: the pure
// decision/reconcile/retry-lookup/worker-host functions and their `_for_test`
// seams. The GenServer integration (poll loop, dispatch/spawn, snapshot, retry
// scheduling) is added in Commit 2; functions that require the live runtime
// take an `OrchestratorCtx`.

import { maxConcurrentAgentsForState, settingsBang } from "./config.ts";
import { type Issue, routable } from "./linear/issue.ts";
import { logger } from "./logger.ts";
import * as Workspace from "./workspace.ts";

const CONTINUATION_RETRY_DELAY_MS = 1_000;
const FAILURE_RETRY_BASE_MS = 10_000;

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
export type RunningTask = { stop(): void };

export type RunningEntry = {
  task?: RunningTask | null;
  ref?: unknown;
  identifier?: string | null;
  issue: Issue;
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
  [key: string]: unknown;
};

export type BlockedEntry = {
  identifier?: string | null;
  issue?: Issue;
  error?: unknown;
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
};

export type RetryAttempt = RetryMetadata & {
  attempt: number;
  timer_ref?: ReturnType<typeof setTimeout> | null;
  retry_token?: symbol;
  due_at_ms?: number;
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
  if (terminalIssueState(issue.state, terminalStates)) {
    logger.info(
      `Issue moved to terminal state: ${issueContext(issue)} state=${issue.state}; stopping active agent`,
    );
    return terminateRunningIssue(state, issue.id, true);
  }
  if (!issueRoutable(issue)) {
    logger.info(
      `Issue no longer routed to this worker: ${issueContext(issue)}; stopping active agent`,
    );
    return terminateRunningIssue(state, issue.id, false);
  }
  if (activeIssueState(issue.state, activeStates)) {
    return refreshRunningIssueState(state, issue);
  }
  logger.info(
    `Issue moved to non-active state: ${issueContext(issue)} state=${issue.state}; stopping active agent`,
  );
  return terminateRunningIssue(state, issue.id, false);
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
  stopRunningTask(entry.task ?? null, entry.ref);
  next = {
    ...next,
    running: omitKey(next.running, issueId),
    claimed: setWithout(next.claimed, issueId),
    blocked: omitKey(next.blocked, issueId),
    retry_attempts: omitKey(next.retry_attempts, issueId),
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

function stopRunningTask(task: RunningTask | null, _ref: unknown): void {
  if (task && typeof task.stop === "function") {
    task.stop();
  }
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
  return ctx.scheduleRetry(state, issue.id, attempt + 1, {
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
