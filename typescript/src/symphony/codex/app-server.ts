// Literal port of `symphony_elixir/codex/app_server.ex`.
//
// Minimal client for the Codex app-server JSON-RPC 2.0 stream over stdio. The
// Elixir Port (line-framed stdio) maps to a Transport abstraction: a real
// Bun.spawn (or SSH.startPort) process, or an in-memory replay used by the
// differential oracle. All protocol I/O is async (stream-based).

import { codexRuntimeSettings, settingsBang } from "../config.ts";
import { logger } from "../logger.ts";
import { ProcessTransport } from "../plugins/agents/transport.ts";
import type { AgentStream, LineEvent, Transport } from "../plugins/agents/transport.ts";
import { type Result, err, ok } from "../result.ts";
import * as SSH from "../ssh.ts";
import { type WorkspaceGuardViolation, guardWorkspacePath } from "../workspace-guard.ts";
import * as DynamicTool from "./dynamic-tool.ts";

const INITIALIZE_ID = 1;
const THREAD_START_ID = 2;
const TURN_START_ID = 3;
const MAX_STREAM_LOG_BYTES = 1_000;
const NON_INTERACTIVE_TOOL_INPUT_ANSWER =
  "This is a non-interactive session. Operator input is unavailable.";

type JsonObject = Record<string, unknown>;

export type AppServerMessage = JsonObject & { event: string; timestamp: Date };
export type OnMessage = (message: AppServerMessage) => void;
export type ToolExecutor = (
  tool: string | null,
  args: unknown,
) => DynamicTool.DynamicToolResponse | Promise<DynamicTool.DynamicToolResponse>;

export type IssueLike = { id?: string | null; identifier?: string | null; title?: string | null };

export type RunOpts = {
  workerHost?: string | null;
  onMessage?: OnMessage;
  toolExecutor?: ToolExecutor;
};

type SessionPolicies = {
  approvalPolicy: string | JsonObject;
  threadSandbox: string;
  turnSandboxPolicy: JsonObject;
};

export type Session = {
  transport: Transport;
  stderrListenerCleanup?: () => void;
  metadata: JsonObject;
  approvalPolicy: string | JsonObject;
  autoApproveRequests: boolean;
  threadSandbox: string;
  turnSandboxPolicy: JsonObject;
  threadId: string;
  workspace: string;
  workerHost: string | null;
};

// ---- Transport -------------------------------------------------------------

// The line-framed JSON transport moved to the shared plugins/agents module so
// the claude-code backend reuses the exact same process client. Re-exported
// here (with local bindings for internal use in startPort / signatures) to keep
// app-server's existing import paths and public `Transport` type unchanged.
// ReplayTransport (codex differential-oracle only) stays below.
export { ProcessTransport };
export type { LineEvent, Transport };

class ReplayTransport implements Transport {
  private index = 0;
  readonly sent: JsonObject[] = [];

  constructor(private serverMessages: unknown[]) {}

  send(message: JsonObject): void {
    this.sent.push(message);
  }

  next(_timeoutMs: number): Promise<LineEvent> {
    if (this.index < this.serverMessages.length) {
      const message = this.serverMessages[this.index++];
      const data = typeof message === "string" ? message : JSON.stringify(message);
      return Promise.resolve({ type: "line", data, stream: "stdout" });
    }
    return Promise.resolve({ type: "exit", status: 0 });
  }

  subscribeStderr(_listener: (data: string) => void): () => void {
    return () => {};
  }

  close(): void {}

  osPid(): string | undefined {
    return undefined;
  }
}

// ---- public API ------------------------------------------------------------

export async function run(
  workspace: string,
  prompt: string,
  issue: IssueLike,
  opts: RunOpts = {},
): Promise<Result<JsonObject, unknown>> {
  const session = await startSession(workspace, opts);
  if (!session.ok) {
    return err(session.error);
  }
  try {
    return await runTurn(session.value, prompt, issue, opts);
  } finally {
    stopSession(session.value);
  }
}

export async function startSession(
  workspace: string,
  opts: RunOpts = {},
): Promise<Result<Session, unknown>> {
  const workerHost = opts.workerHost ?? null;

  const expanded = validateWorkspaceCwd(workspace, workerHost);
  if (!expanded.ok) {
    return err(expanded.error);
  }
  const transportResult = startPort(expanded.value, workerHost);
  if (!transportResult.ok) {
    return err(transportResult.error);
  }
  const transport = transportResult.value;
  const metadata = portMetadata(transport, workerHost);

  const policies = await sessionPolicies(expanded.value, workerHost);
  if (!policies.ok) {
    transport.close();
    return err(policies.error);
  }

  const threadId = await doStartSession(transport, expanded.value, policies.value);
  if (!threadId.ok) {
    transport.close();
    return err(threadId.error);
  }

  return ok({
    transport,
    metadata,
    approvalPolicy: policies.value.approvalPolicy,
    autoApproveRequests: policies.value.approvalPolicy === "never",
    threadSandbox: policies.value.threadSandbox,
    turnSandboxPolicy: policies.value.turnSandboxPolicy,
    threadId: threadId.value,
    workspace: expanded.value,
    workerHost,
  });
}

export async function runTurn(
  session: Session,
  prompt: string,
  issue: IssueLike,
  opts: RunOpts = {},
): Promise<Result<JsonObject, unknown>> {
  const onMessage = opts.onMessage ?? (() => {});
  const toolExecutor: ToolExecutor =
    opts.toolExecutor ?? ((tool, args) => DynamicTool.execute(tool, args));

  if (session.stderrListenerCleanup === undefined) {
    session.stderrListenerCleanup = session.transport.subscribeStderr((line) => {
      if (line.trim() === "") {
        return;
      }
      logNonJsonStreamLine(line, "stderr");
      const details = { payload: line, raw: line };
      emitMessage(
        onMessage,
        protocolMessageCandidate(line) ? "malformed" : "notification",
        details,
        metadataFromMessage(session.transport, details, "stderr"),
      );
    });
  }

  const turn = await startTurn(
    session.transport,
    session.threadId,
    prompt,
    issue,
    session.workspace,
    session.approvalPolicy,
    session.turnSandboxPolicy,
  );
  if (!turn.ok) {
    logger.error(`Codex session failed for ${issueContext(issue)}: ${inspect(turn.error)}`);
    emitMessage(onMessage, "startup_failed", { reason: turn.error }, session.metadata);
    return err(turn.error);
  }

  const turnId = turn.value;
  const sessionId = `${session.threadId}-${turnId}`;
  logger.info(`Codex session started for ${issueContext(issue)} session_id=${sessionId}`);
  emitMessage(
    onMessage,
    "session_started",
    { sessionId, threadId: session.threadId, turnId },
    session.metadata,
  );

  const completion = await awaitTurnCompletion(
    session.transport,
    onMessage,
    toolExecutor,
    session.autoApproveRequests,
  );
  if (completion.ok) {
    logger.info(`Codex session completed for ${issueContext(issue)} session_id=${sessionId}`);
    return ok({ result: completion.value, sessionId, threadId: session.threadId, turnId });
  }
  logger.warning(
    `Codex session ended with error for ${issueContext(issue)} session_id=${sessionId}: ${inspect(completion.error)}`,
  );
  emitMessage(
    onMessage,
    "turn_ended_with_error",
    { sessionId, reason: completion.error },
    session.metadata,
  );
  return err(completion.error);
}

export function stopSession(session: Session): void {
  session.transport.close();
}

// Differential-oracle replay adapter (see harness/README.md). Given the
// codex -> symphony messages, returns the symphony -> codex messages the TS
// client emits. Parity vs recorded Elixir fixtures is pending the Elixir
// toolchain; the protocol logic is shared with the live client.
export async function replayTranscript(serverMessages: unknown[]): Promise<unknown[]> {
  const transport = new ReplayTransport(serverMessages);
  const onMessage: OnMessage = () => {};
  const toolExecutor: ToolExecutor = (tool, args) => DynamicTool.execute(tool, args);

  const policies = await sessionPolicies("/workspace", null).catch(() => null);
  const resolved: SessionPolicies = policies?.ok
    ? policies.value
    : { approvalPolicy: "never", threadSandbox: "workspace-write", turnSandboxPolicy: {} };

  const thread = await doStartSession(transport, "/workspace", resolved);
  if (thread.ok) {
    const turn = await startTurn(
      transport,
      thread.value,
      "",
      { identifier: "", title: "" },
      "/workspace",
      resolved.approvalPolicy,
      resolved.turnSandboxPolicy,
    );
    if (turn.ok) {
      await awaitTurnCompletion(
        transport,
        onMessage,
        toolExecutor,
        resolved.approvalPolicy === "never",
      );
    }
  }
  return transport.sent;
}

// ---- workspace cwd validation ----------------------------------------------

// Delegates to the shared workspace guard (workspace-guard.ts) and maps each
// violation back to codex's frozen `invalid_workspace_cwd` error family (tests
// and logs consume the exact `reason`/`path` shapes below).
function validateWorkspaceCwd(
  workspace: string,
  workerHost: string | null,
): Result<string, unknown> {
  const guard = guardWorkspacePath(workspace, settingsBang().workspace.root, workerHost);
  if (guard.ok) {
    return ok(guard.value);
  }
  return err(invalidWorkspaceCwd(guard.error, workerHost));
}

function invalidWorkspaceCwd(v: WorkspaceGuardViolation, workerHost: string | null): JsonObject {
  switch (v.kind) {
    case "path_unreadable":
      return {
        tag: "invalid_workspace_cwd",
        reason: "path_unreadable",
        path: v.path,
        detail: v.reason,
      };
    case "equals_root":
      return { tag: "invalid_workspace_cwd", reason: "workspace_root", path: v.canonicalWorkspace };
    case "symlink_escape":
      return {
        tag: "invalid_workspace_cwd",
        reason: "symlink_escape",
        path: v.expandedWorkspace,
        root: v.canonicalRoot,
      };
    case "outside_root":
      return {
        tag: "invalid_workspace_cwd",
        reason: "outside_workspace_root",
        path: v.canonicalWorkspace,
        root: v.canonicalRoot,
      };
    case "empty_remote":
      return { tag: "invalid_workspace_cwd", reason: "empty_remote_workspace", workerHost };
    case "invalid_remote_characters":
      return {
        tag: "invalid_workspace_cwd",
        reason: "invalid_remote_workspace",
        workerHost,
        workspace: v.workspace,
      };
  }
}

// ---- process launch --------------------------------------------------------

function startPort(workspace: string, workerHost: string | null): Result<Transport, unknown> {
  if (workerHost === null) {
    const executable = Bun.which("bash", { PATH: process.env.PATH ?? "" });
    if (executable === null) {
      return err({ tag: "bash_not_found" });
    }
    const proc = Bun.spawn([executable, "-lc", settingsBang().codex.command], {
      cwd: workspace,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    }) as Bun.Subprocess<"pipe", "pipe", "pipe">;
    return ok(new ProcessTransport(proc));
  }

  const remoteCommand = remoteLaunchCommand(workspace);
  const portResult = SSH.startPort(workerHost, remoteCommand, { line: 1_048_576 });
  if (!portResult.ok) {
    return err(portResult.error);
  }
  return ok(new ProcessTransport(portResult.value as Bun.Subprocess<"pipe", "pipe", "pipe">));
}

function remoteLaunchCommand(workspace: string): string {
  return [`cd ${shellEscape(workspace)}`, `exec ${settingsBang().codex.command}`].join(" && ");
}

function portMetadata(transport: Transport, workerHost: string | null): JsonObject {
  const base: JsonObject = {};
  const pid = transport.osPid();
  if (pid !== undefined) {
    base.codexAppServerPid = pid;
  }
  if (typeof workerHost === "string") {
    base.workerHost = workerHost;
  }
  return base;
}

// ---- session/thread/turn ---------------------------------------------------

async function sessionPolicies(
  workspace: string,
  workerHost: string | null,
): Promise<Result<SessionPolicies, unknown>> {
  const runtime = codexRuntimeSettings(workspace, workerHost === null ? {} : { remote: true });
  if (!runtime.ok) {
    return err(runtime.error);
  }
  return ok({
    approvalPolicy: runtime.value.approvalPolicy,
    threadSandbox: runtime.value.threadSandbox,
    turnSandboxPolicy: runtime.value.turnSandboxPolicy,
  });
}

async function doStartSession(
  transport: Transport,
  workspace: string,
  policies: SessionPolicies,
): Promise<Result<string, unknown>> {
  const init = await sendInitialize(transport);
  if (!init.ok) {
    return err(init.error);
  }
  return startThread(transport, workspace, policies);
}

async function sendInitialize(transport: Transport): Promise<Result<undefined, unknown>> {
  transport.send({
    method: "initialize",
    id: INITIALIZE_ID,
    params: {
      capabilities: { experimentalApi: true },
      clientInfo: {
        name: "symphony-orchestrator",
        title: "Symphony Orchestrator",
        version: "0.1.0",
      },
    },
  });
  const response = await awaitResponse(transport, INITIALIZE_ID);
  if (!response.ok) {
    return err(response.error);
  }
  transport.send({ method: "initialized", params: {} });
  return ok(undefined);
}

async function startThread(
  transport: Transport,
  workspace: string,
  policies: SessionPolicies,
): Promise<Result<string, unknown>> {
  transport.send({
    method: "thread/start",
    id: THREAD_START_ID,
    params: {
      approvalPolicy: policies.approvalPolicy,
      sandbox: policies.threadSandbox,
      cwd: workspace,
      dynamicTools: DynamicTool.toolSpecs(),
    },
  });
  const response = await awaitResponse(transport, THREAD_START_ID);
  if (!response.ok) {
    return err(response.error);
  }
  const thread = isObject(response.value) ? response.value.thread : undefined;
  if (isObject(thread) && typeof thread.id === "string") {
    return ok(thread.id);
  }
  return err({ tag: "invalid_thread_payload", payload: thread });
}

async function startTurn(
  transport: Transport,
  threadId: string,
  prompt: string,
  issue: IssueLike,
  workspace: string,
  approvalPolicy: string | JsonObject,
  turnSandboxPolicy: JsonObject,
): Promise<Result<string, unknown>> {
  transport.send({
    method: "turn/start",
    id: TURN_START_ID,
    params: {
      threadId,
      input: [{ type: "text", text: prompt }],
      cwd: workspace,
      title: `${issue.identifier}: ${issue.title}`,
      approvalPolicy,
      sandboxPolicy: turnSandboxPolicy,
    },
  });
  const response = await awaitResponse(transport, TURN_START_ID);
  if (!response.ok) {
    return err(response.error);
  }
  const turn = isObject(response.value) ? response.value.turn : undefined;
  if (isObject(turn) && typeof turn.id === "string") {
    return ok(turn.id);
  }
  return err(response.value);
}

function awaitTurnCompletion(
  transport: Transport,
  onMessage: OnMessage,
  toolExecutor: ToolExecutor,
  autoApprove: boolean,
): Promise<Result<unknown, unknown>> {
  return receiveLoop(
    transport,
    onMessage,
    settingsBang().codex.turnTimeoutMs,
    toolExecutor,
    autoApprove,
  );
}

async function receiveLoop(
  transport: Transport,
  onMessage: OnMessage,
  timeoutMs: number,
  toolExecutor: ToolExecutor,
  autoApprove: boolean,
): Promise<Result<unknown, unknown>> {
  // Iterative loop (TS has no tail-call recursion); each iteration mirrors one
  // pass of the Elixir receive_loop.
  for (;;) {
    const event = await transport.next(timeoutMs);
    if (event.type === "timeout") {
      return err({ tag: "turn_timeout" });
    }
    if (event.type === "exit") {
      return err({ tag: "port_exit", status: event.status });
    }

    const outcome = await handleIncoming(
      transport,
      onMessage,
      event.data,
      event.stream,
      toolExecutor,
      autoApprove,
    );
    if (outcome.kind === "continue") {
      continue;
    }
    return outcome.result;
  }
}

type LoopOutcome = { kind: "continue" } | { kind: "return"; result: Result<unknown, unknown> };

const CONTINUE: LoopOutcome = { kind: "continue" };
const ret = (result: Result<unknown, unknown>): LoopOutcome => ({ kind: "return", result });

async function handleIncoming(
  transport: Transport,
  onMessage: OnMessage,
  data: string,
  stream: AgentStream,
  toolExecutor: ToolExecutor,
  autoApprove: boolean,
): Promise<LoopOutcome> {
  const payloadString = data;
  const decoded = tryDecode(payloadString);

  if (!decoded.ok) {
    logNonJsonStreamLine(payloadString, "turn stream");
    if (payloadString.trim() !== "") {
      emitMessage(
        onMessage,
        protocolMessageCandidate(payloadString) ? "malformed" : "notification",
        { payload: payloadString, raw: payloadString },
        metadataFromMessage(transport, { raw: payloadString }, stream),
      );
    }
    return CONTINUE;
  }

  const payload = decoded.value;
  const method = isObject(payload) ? payload.method : undefined;

  if (isObject(payload) && method === "turn/completed") {
    emitTurnEvent(onMessage, "turn_completed", payload, payloadString, transport, payload, stream);
    return ret(ok("turn_completed"));
  }
  if (isObject(payload) && method === "turn/failed" && "params" in payload) {
    emitTurnEvent(
      onMessage,
      "turn_failed",
      payload,
      payloadString,
      transport,
      payload.params,
      stream,
    );
    return ret(err({ tag: "turn_failed", params: payload.params }));
  }
  if (isObject(payload) && method === "turn/cancelled" && "params" in payload) {
    emitTurnEvent(
      onMessage,
      "turn_cancelled",
      payload,
      payloadString,
      transport,
      payload.params,
      stream,
    );
    return ret(err({ tag: "turn_cancelled", params: payload.params }));
  }
  if (isObject(payload) && typeof method === "string") {
    return handleTurnMethod(
      transport,
      onMessage,
      payload,
      payloadString,
      method,
      stream,
      toolExecutor,
      autoApprove,
    );
  }

  emitMessage(
    onMessage,
    "other_message",
    { payload, raw: payloadString },
    metadataFromMessage(transport, payload, stream),
  );
  return CONTINUE;
}

function emitTurnEvent(
  onMessage: OnMessage,
  event: string,
  payload: JsonObject,
  payloadString: string,
  transport: Transport,
  details: unknown,
  stream: AgentStream,
): void {
  emitMessage(
    onMessage,
    event,
    { payload, raw: payloadString, details },
    metadataFromMessage(transport, payload, stream),
  );
}

async function handleTurnMethod(
  transport: Transport,
  onMessage: OnMessage,
  payload: JsonObject,
  payloadString: string,
  method: string,
  stream: AgentStream,
  toolExecutor: ToolExecutor,
  autoApprove: boolean,
): Promise<LoopOutcome> {
  const metadata = metadataFromMessage(transport, payload, stream);
  const handled = await maybeHandleApprovalRequest(
    transport,
    method,
    payload,
    payloadString,
    onMessage,
    metadata,
    toolExecutor,
    autoApprove,
  );

  switch (handled) {
    case "input_required":
      emitMessage(onMessage, "turn_input_required", { payload, raw: payloadString }, metadata);
      return ret(err({ tag: "turn_input_required", payload }));
    case "approved":
      return CONTINUE;
    case "approval_required":
      emitMessage(onMessage, "approval_required", { payload, raw: payloadString }, metadata);
      return ret(err({ tag: "approval_required", payload }));
    default:
      if (needsInput(method, payload)) {
        emitMessage(onMessage, "turn_input_required", { payload, raw: payloadString }, metadata);
        return ret(err({ tag: "turn_input_required", payload }));
      }
      emitMessage(onMessage, "notification", { payload, raw: payloadString }, metadata);
      logger.debug(`Codex notification: ${inspect(method)}`);
      return CONTINUE;
  }
}

type ApprovalOutcome = "input_required" | "approved" | "approval_required" | "unhandled";

async function maybeHandleApprovalRequest(
  transport: Transport,
  method: string,
  payload: JsonObject,
  payloadString: string,
  onMessage: OnMessage,
  metadata: JsonObject,
  toolExecutor: ToolExecutor,
  autoApprove: boolean,
): Promise<ApprovalOutcome> {
  const id = payload.id;

  switch (method) {
    case "item/commandExecution/requestApproval":
      return approveOrRequire(
        transport,
        id,
        "acceptForSession",
        payload,
        payloadString,
        onMessage,
        metadata,
        autoApprove,
      );
    case "execCommandApproval":
    case "applyPatchApproval":
      return approveOrRequire(
        transport,
        id,
        "approved_for_session",
        payload,
        payloadString,
        onMessage,
        metadata,
        autoApprove,
      );
    case "item/fileChange/requestApproval":
      return approveOrRequire(
        transport,
        id,
        "acceptForSession",
        payload,
        payloadString,
        onMessage,
        metadata,
        autoApprove,
      );
    case "item/tool/call":
      return handleToolCall(
        transport,
        id,
        payload,
        payloadString,
        onMessage,
        metadata,
        toolExecutor,
      );
    case "item/tool/requestUserInput":
      return maybeAutoAnswerToolRequestUserInput(
        transport,
        id,
        payload.params,
        payload,
        payloadString,
        onMessage,
        metadata,
        autoApprove,
      );
    default:
      return "unhandled";
  }
}

async function handleToolCall(
  transport: Transport,
  id: unknown,
  payload: JsonObject,
  payloadString: string,
  onMessage: OnMessage,
  metadata: JsonObject,
  toolExecutor: ToolExecutor,
): Promise<ApprovalOutcome> {
  const params = payload.params;
  const toolName = toolCallName(params);
  const args = toolCallArguments(params);

  const result = normalizeDynamicToolResult(await toolExecutor(toolName, args));
  transport.send({ id, result });

  const event =
    result.success === true
      ? "tool_call_completed"
      : toolName === null
        ? "unsupported_tool_call"
        : "tool_call_failed";
  emitMessage(onMessage, event, { payload, raw: payloadString }, metadata);
  return "approved";
}

type NormalizedToolResult = JsonObject & {
  success: boolean;
  output: string;
  contentItems: unknown[];
};

function normalizeDynamicToolResult(result: unknown): NormalizedToolResult {
  if (isObject(result) && typeof result.success === "boolean") {
    const output = typeof result.output === "string" ? result.output : dynamicToolOutput(result);
    const contentItems = Array.isArray(result.contentItems)
      ? result.contentItems
      : dynamicToolContentItems(output);
    return { ...result, success: result.success, output, contentItems };
  }
  const output = inspect(result);
  return { success: false, output, contentItems: dynamicToolContentItems(output) };
}

function dynamicToolOutput(result: JsonObject): string {
  const items = result.contentItems;
  if (Array.isArray(items) && isObject(items[0]) && typeof items[0].text === "string") {
    return items[0].text;
  }
  return JSON.stringify(result, null, 2);
}

function dynamicToolContentItems(output: string): unknown[] {
  return [{ type: "inputText", text: output }];
}

function approveOrRequire(
  transport: Transport,
  id: unknown,
  decision: string,
  payload: JsonObject,
  payloadString: string,
  onMessage: OnMessage,
  metadata: JsonObject,
  autoApprove: boolean,
): ApprovalOutcome {
  if (!autoApprove) {
    return "approval_required";
  }
  transport.send({ id, result: { decision } });
  emitMessage(
    onMessage,
    "approval_auto_approved",
    { payload, raw: payloadString, decision },
    metadata,
  );
  return "approved";
}

function maybeAutoAnswerToolRequestUserInput(
  transport: Transport,
  id: unknown,
  params: unknown,
  payload: JsonObject,
  payloadString: string,
  onMessage: OnMessage,
  metadata: JsonObject,
  autoApprove: boolean,
): ApprovalOutcome {
  if (autoApprove) {
    const approval = toolRequestUserInputApprovalAnswers(params);
    if (approval !== null) {
      transport.send({ id, result: { answers: approval.answers } });
      emitMessage(
        onMessage,
        "approval_auto_approved",
        { payload, raw: payloadString, decision: approval.decision },
        metadata,
      );
      return "approved";
    }
  }
  return replyWithNonInteractiveToolInputAnswer(
    transport,
    id,
    params,
    payload,
    payloadString,
    onMessage,
    metadata,
  );
}

function replyWithNonInteractiveToolInputAnswer(
  transport: Transport,
  id: unknown,
  params: unknown,
  payload: JsonObject,
  payloadString: string,
  onMessage: OnMessage,
  metadata: JsonObject,
): ApprovalOutcome {
  const answers = toolRequestUserInputUnavailableAnswers(params);
  if (answers === null) {
    return "input_required";
  }
  transport.send({ id, result: { answers } });
  emitMessage(
    onMessage,
    "tool_input_auto_answered",
    { payload, raw: payloadString, answer: NON_INTERACTIVE_TOOL_INPUT_ANSWER },
    metadata,
  );
  return "approved";
}

function toolRequestUserInputApprovalAnswers(
  params: unknown,
): { answers: JsonObject; decision: string } | null {
  if (!isObject(params) || !Array.isArray(params.questions)) {
    return null;
  }
  const answers: JsonObject = {};
  for (const question of params.questions) {
    const answer = toolRequestUserInputApprovalAnswer(question);
    if (answer === null) {
      return null;
    }
    answers[answer.questionId] = { answers: [answer.label] };
  }
  return Object.keys(answers).length > 0 ? { answers, decision: "Approve this Session" } : null;
}

function toolRequestUserInputUnavailableAnswers(params: unknown): JsonObject | null {
  if (!isObject(params) || !Array.isArray(params.questions)) {
    return null;
  }
  const answers: JsonObject = {};
  for (const question of params.questions) {
    const questionId = toolRequestUserInputQuestionId(question);
    if (questionId === null) {
      return null;
    }
    answers[questionId] = { answers: [NON_INTERACTIVE_TOOL_INPUT_ANSWER] };
  }
  return Object.keys(answers).length > 0 ? answers : null;
}

function toolRequestUserInputQuestionId(question: unknown): string | null {
  if (isObject(question) && typeof question.id === "string") {
    return question.id;
  }
  return null;
}

function toolRequestUserInputApprovalAnswer(
  question: unknown,
): { questionId: string; label: string } | null {
  if (isObject(question) && typeof question.id === "string" && Array.isArray(question.options)) {
    const label = toolRequestUserInputApprovalOptionLabel(question.options);
    return label === null ? null : { questionId: question.id, label };
  }
  return null;
}

function toolRequestUserInputApprovalOptionLabel(options: unknown[]): string | null {
  const labels = options
    .map((option) => (isObject(option) && typeof option.label === "string" ? option.label : null))
    .filter((label): label is string => label !== null);
  return (
    labels.find((label) => label === "Approve this Session") ??
    labels.find((label) => label === "Approve Once") ??
    labels.find(approvalOptionLabel) ??
    null
  );
}

function approvalOptionLabel(label: string): boolean {
  const normalized = label.trim().toLowerCase();
  return normalized.startsWith("approve") || normalized.startsWith("allow");
}

// ---- response handling -----------------------------------------------------

async function awaitResponse(
  transport: Transport,
  requestId: number,
): Promise<Result<unknown, unknown>> {
  const timeoutMs = settingsBang().codex.readTimeoutMs;
  for (;;) {
    const event = await transport.next(timeoutMs);
    if (event.type === "timeout") {
      return err({ tag: "response_timeout" });
    }
    if (event.type === "exit") {
      return err({ tag: "port_exit", status: event.status });
    }
    const decoded = tryDecode(event.data);
    if (!decoded.ok) {
      logNonJsonStreamLine(event.data, "response stream");
      continue;
    }
    const payload = decoded.value;
    if (isObject(payload) && payload.id === requestId) {
      if ("error" in payload) {
        return err({ tag: "response_error", error: payload.error });
      }
      if ("result" in payload) {
        return ok(payload.result);
      }
      return err({ tag: "response_error", payload });
    }
    if (isObject(payload)) {
      logger.debug(`Ignoring message while waiting for response: ${inspect(payload)}`);
    }
  }
}

// ---- helpers ---------------------------------------------------------------

function emitMessage(
  onMessage: OnMessage,
  event: string,
  details: JsonObject,
  metadata: JsonObject,
): void {
  onMessage({ ...metadata, ...details, event, timestamp: new Date() });
}

function metadataFromMessage(
  transport: Transport,
  payload: unknown,
  stream: AgentStream | null = null,
): JsonObject {
  const metadata = maybeSetUsage(portMetadata(transport, null), payload);
  return stream === null ? metadata : { ...metadata, stream };
}

function maybeSetUsage(metadata: JsonObject, payload: unknown): JsonObject {
  if (isObject(payload) && isObject(payload.usage)) {
    return { ...metadata, usage: payload.usage };
  }
  return metadata;
}

function logNonJsonStreamLine(data: string, streamLabel: string): void {
  const text = data.trim().slice(0, MAX_STREAM_LOG_BYTES);
  if (text === "") {
    return;
  }
  if (/\b(error|warn|warning|failed|fatal|panic|exception)\b/i.test(text)) {
    logger.warning(`Codex ${streamLabel} output: ${text}`);
  } else {
    logger.debug(`Codex ${streamLabel} output: ${text}`);
  }
}

function protocolMessageCandidate(data: string): boolean {
  return data.replace(/^\s+/, "").startsWith("{");
}

function needsInput(method: string, payload: JsonObject): boolean {
  if (method === "mcpServer/elicitation/request") {
    return true;
  }
  return method.startsWith("turn/") && inputRequiredMethod(method, payload);
}

function inputRequiredMethod(method: string, payload: JsonObject): boolean {
  const known = [
    "turn/input_required",
    "turn/needs_input",
    "turn/need_input",
    "turn/request_input",
    "turn/request_response",
    "turn/provide_input",
    "turn/approval_required",
  ];
  return known.includes(method) || requestPayloadRequiresInput(payload);
}

function requestPayloadRequiresInput(payload: JsonObject): boolean {
  return needsInputField(payload) || needsInputField(payload.params);
}

function needsInputField(payload: unknown): boolean {
  if (!isObject(payload)) {
    return false;
  }
  return (
    payload.requiresInput === true ||
    payload.needsInput === true ||
    payload.input_required === true ||
    payload.inputRequired === true ||
    payload.type === "input_required" ||
    payload.type === "needs_input"
  );
}

function toolCallName(params: unknown): string | null {
  if (!isObject(params)) {
    return null;
  }
  const name = params.tool ?? params.name;
  if (typeof name === "string") {
    const trimmed = name.trim();
    return trimmed === "" ? null : trimmed;
  }
  return null;
}

function toolCallArguments(params: unknown): unknown {
  if (!isObject(params)) {
    return {};
  }
  return params.arguments ?? {};
}

function issueContext(issue: IssueLike): string {
  return `issue_id=${issue.id} issue_identifier=${issue.identifier}`;
}

function shellEscape(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function tryDecode(text: string): Result<unknown, unknown> {
  try {
    return ok(JSON.parse(text));
  } catch (error) {
    return err(error);
  }
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
