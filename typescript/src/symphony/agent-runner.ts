// Literal port of `symphony_elixir/agent_runner.ex`.
//
// Executes a single Linear issue in its workspace with Codex. The Elixir
// `send(pid, tuple)` recipient becomes a callback invoked with tagged updates.

import * as AppServer from "./codex/app-server.ts";
import { settingsBang } from "./config.ts";
import { type Issue, routable } from "./linear/issue.ts";
import { logger } from "./logger.ts";
import { buildPrompt } from "./prompt-builder.ts";
import { type Result, err, ok } from "./result.ts";
import * as Tracker from "./tracker/tracker.ts";
import * as Workspace from "./workspace.ts";

export type WorkerUpdate =
  | { tag: "codex_worker_update"; issueId: string; message: AppServer.AppServerMessage }
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
  const workerHost = selectedWorkerHost(opts.workerHost ?? null, settingsBang().worker.sshHosts);
  logger.info(
    `Starting agent run for ${issueContext(issue)} worker_host=${workerHostForLog(workerHost)}`,
  );

  const result = await runOnWorkerHost(issue, recipient, opts, workerHost);
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
    return await runCodexTurns(workspace, issue, recipient, opts, workerHost);
  } finally {
    Workspace.runAfterRunHook(workspace, issue, workerHost);
  }
}

function codexMessageHandler(recipient: UpdateRecipient, issue: Issue): AppServer.OnMessage {
  return (message) => sendCodexUpdate(recipient, issue, message);
}

function sendCodexUpdate(
  recipient: UpdateRecipient,
  issue: Issue,
  message: AppServer.AppServerMessage,
): void {
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

async function runCodexTurns(
  workspace: string,
  issue: Issue,
  recipient: UpdateRecipient,
  opts: RunOpts,
  workerHost: string | null,
): Promise<Result<undefined, unknown>> {
  const maxTurns = opts.maxTurns ?? settingsBang().agent.maxTurns;
  const issueStateFetcher: IssueStateFetcher =
    opts.issueStateFetcher ?? ((ids) => Tracker.fetchIssueStatesByIds(ids));

  const session = await AppServer.startSession(workspace, { workerHost });
  if (!session.ok) {
    return err(session.error);
  }
  try {
    return await doRunCodexTurns(
      session.value,
      workspace,
      issue,
      recipient,
      opts,
      issueStateFetcher,
      1,
      maxTurns,
    );
  } finally {
    AppServer.stopSession(session.value);
  }
}

async function doRunCodexTurns(
  appSession: AppServer.Session,
  workspace: string,
  issue: Issue,
  recipient: UpdateRecipient,
  opts: RunOpts,
  issueStateFetcher: IssueStateFetcher,
  turnNumber: number,
  maxTurns: number,
): Promise<Result<undefined, unknown>> {
  const prompt = buildTurnPrompt(issue, opts, turnNumber, maxTurns);

  const turnSession = await AppServer.runTurn(appSession, prompt, issue, {
    onMessage: codexMessageHandler(recipient, issue),
  });
  if (!turnSession.ok) {
    return err(turnSession.error);
  }
  logger.info(
    `Completed agent run for ${issueContext(issue)} session_id=${turnSession.value.sessionId} workspace=${workspace} turn=${turnNumber}/${maxTurns}`,
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
    return doRunCodexTurns(
      appSession,
      workspace,
      outcome.issue,
      recipient,
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

function buildTurnPrompt(
  issue: Issue,
  opts: RunOpts,
  turnNumber: number,
  maxTurns: number,
): string {
  if (turnNumber === 1) {
    return buildPrompt(issue, { attempt: opts.attempt ?? null });
  }
  return `Continuation guidance:

- The previous Codex turn completed normally, but the Linear issue is still in an active state.
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
