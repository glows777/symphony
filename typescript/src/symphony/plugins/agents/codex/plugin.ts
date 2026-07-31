// Codex app-server agent backend plugin. Wraps codex/app-server.ts (the
// unchanged JSON-RPC 2.0 client) behind the AgentBackendPlugin contract:
//
//   - `sessions` forwards to AppServer.{startSession,runTurn,stopSession},
//     storing the AppServer.Session plus the session-scoped onMessage /
//     toolProvider in the opaque `handle`;
//   - the ToolProvider is encoded into an AppServer.ToolExecutor at runTurn;
//   - app-server's wrapped events already are the normalized envelope, so
//     `normalizeCodexMessage` is the identity in P2 (P3 adds the neutral
//     `backendPid` alias and the envelope `rate_limits` lift);
//   - `replay` re-exports the differential-oracle seam.
//
// Module evaluation only builds an object literal (no AppServer call), keeping
// the config <-> plugins <-> app-server ESM cycle side-effect free.

import path from "node:path";
import * as AppServer from "../../../codex/app-server.ts";
import * as DynamicTool from "../../../codex/dynamic-tool.ts";
import { type Result, err, ok } from "../../../result.ts";
import type {
  AgentBackendPlugin,
  AgentMessage,
  AgentSession,
  OnAgentMessage,
  StartSessionOpts,
  ToolProvider,
  TurnContext,
  TurnResult,
} from "../types.ts";
import { humanizeCodexMessage } from "./humanize.ts";

type CodexHandle = {
  appSession: AppServer.Session;
  onMessage: OnAgentMessage | null;
  toolProvider: ToolProvider | null;
};

async function startSession(
  workspace: string,
  opts: StartSessionOpts = {},
): Promise<Result<AgentSession, unknown>> {
  // Tool-spec advertisement on thread/start comes from app-server's global
  // DynamicTool.toolSpecs() (= trackerToolProvider().listSpecs()), which is the
  // same provider agent-runner injects here, so specs and execution agree in
  // production. Threading opts.toolProvider.listSpecs() through thread/start
  // would require changing the frozen app-server startThread signature; that is
  // deferred to the P5 ProcessTransport/app-server refactor.
  const started = await AppServer.startSession(workspace, {
    workerHost: opts.workerHost ?? null,
  });
  if (!started.ok) {
    return err(started.error);
  }
  const appSession = started.value;
  const handle: CodexHandle = {
    appSession,
    onMessage: opts.onMessage ?? null,
    toolProvider: opts.toolProvider ?? null,
  };
  const session: AgentSession = {
    backendId: "codex",
    workspace: appSession.workerHost === null ? path.resolve(workspace) : appSession.workspace,
    workerHost: appSession.workerHost,
    runId: appSession.threadId,
    handle,
  };
  const pid = codexPid(appSession);
  if (pid !== undefined) {
    session.backendPid = pid;
  }
  return ok(session);
}

async function runTurn(
  session: AgentSession,
  prompt: string,
  context: TurnContext,
): Promise<Result<TurnResult, unknown>> {
  const handle = session.handle as CodexHandle;
  const forward = handle.onMessage;
  const runOpts: AppServer.RunOpts = {
    onMessage: (message) => forward?.(normalizeCodexMessage(message)),
  };
  if (handle.toolProvider !== null) {
    runOpts.toolExecutor = toolExecutorFor(handle.toolProvider);
  }
  const result = await AppServer.runTurn(handle.appSession, prompt, context.issue, runOpts);
  if (!result.ok) {
    return err(result.error);
  }
  return ok(result.value as TurnResult);
}

function stopSession(session: AgentSession): void {
  AppServer.stopSession((session.handle as CodexHandle).appSession);
}

// AppServerMessage is a structural superset of AgentMessage and already carries
// the frozen `codexAppServerPid` and cumulative `usage`. P3 adds two purely
// additive fields:
//   - the neutral `backendPid` alias (the frozen `codexAppServerPid` stays);
//   - the envelope `rate_limits`, lifted out of the codex/event/token_count
//     payload (the orchestrator keeps its own payload sniffing as a fallback).
function normalizeCodexMessage(message: AppServer.AppServerMessage): AgentMessage {
  const normalized = { ...message } as AgentMessage;
  const pid = message.codexAppServerPid;
  if (typeof pid === "string" && normalized.backendPid === undefined) {
    normalized.backendPid = pid;
  }
  if (normalized.rate_limits === undefined) {
    const rateLimits = rateLimitsFromPayload(message.payload);
    if (rateLimits !== null) {
      normalized.rate_limits = rateLimits;
    }
  }
  Object.assign(normalized, codexOutputFields(message));
  return normalized;
}

type CodexOutputFields = Pick<
  AgentMessage,
  | "activity_type"
  | "activity_status"
  | "activity_id"
  | "presentation_role"
  | "final_activity_id"
  | "final_content"
  | "parent_message_id"
  | "chat_id"
  | "chat_phase"
  | "chat_delta"
  | "thinking_summary_delta"
  | "tool_name"
  | "tool_input"
  | "tool_command"
  | "tool_output_delta"
  | "tool_error"
>;

function codexOutputFields(message: AppServer.AppServerMessage): CodexOutputFields {
  const payload = message.payload;
  const method = stringAt(payload, [["method"]]);
  const itemType = stringAt(payload, [
    ["params", "item", "type"],
    ["params", "itemType"],
    ["params", "msg", "item", "type"],
  ]);
  const activityId = stringAt(payload, [
    ["params", "itemId"],
    ["params", "item", "id"],
    ["params", "toolCallId"],
    ["params", "callId"],
    ["params", "msg", "itemId"],
    ["params", "msg", "item", "id"],
  ]);
  const parentMessageId = stringAt(payload, [
    ["params", "parentMessageId"],
    ["params", "parentItemId"],
    ["params", "item", "parentMessageId"],
    ["params", "item", "parentItemId"],
  ]);

  if (message.event === "turn_completed" || method === "turn/completed") {
    const status = stringAt(payload, [
      ["params", "turn", "status"],
      ["params", "status"],
    ]);
    if (status !== null && status !== "completed") {
      return {};
    }
    const final = finalAgentMessage(payload);
    if (final === null || final.text.trim() === "") {
      return {};
    }
    const turnId =
      stringAt(payload, [
        ["params", "turn", "id"],
        ["params", "turnId"],
      ]) ?? "unknown";
    return {
      final_activity_id: final.id ?? `codex:turn:${turnId}`,
      final_content: final.text,
    };
  }

  const normalizedMethod = method?.toLowerCase() ?? "";
  const phase = itemPhase(normalizedMethod);
  const normalizedItemType = normalizeType(itemType);
  const isAgentMessage =
    normalizedItemType === "agentmessage" || normalizedMethod.includes("agentmessage");
  if (isAgentMessage) {
    const delta = stringAt(payload, [
      ["params", "delta"],
      ["params", "textDelta"],
      ["params", "text"],
      ["params", "msg", "delta"],
    ]);
    return {
      activity_type: "assistant_message",
      activity_status: phase === "complete" ? "completed" : "streaming",
      presentation_role: "working",
      ...(activityId !== null ? { activity_id: activityId, chat_id: activityId } : {}),
      ...(phase !== null ? { chat_phase: phase } : {}),
      ...(delta !== null ? { chat_delta: delta } : {}),
      ...(parentMessageId !== null ? { parent_message_id: parentMessageId } : {}),
    };
  }

  if (normalizedMethod.includes("reasoning") || normalizedTypeIs(normalizedItemType, "reasoning")) {
    const summary = stringAt(payload, [
      ["params", "summaryTextDelta"],
      ["params", "summaryText"],
      ["params", "msg", "summaryTextDelta"],
    ]);
    return {
      activity_type: "thinking",
      activity_status: phase === "complete" ? "completed" : "streaming",
      presentation_role: "working",
      ...(activityId !== null ? { activity_id: activityId } : {}),
      ...(summary !== null ? { thinking_summary_delta: summary } : {}),
      ...(parentMessageId !== null ? { parent_message_id: parentMessageId } : {}),
    };
  }

  if (
    normalizedMethod.includes("commandexecution") ||
    normalizedMethod.includes("filechange") ||
    normalizedMethod.includes("mcptoolcall") ||
    normalizedMethod.includes("tool/call") ||
    isCodexToolType(normalizedItemType)
  ) {
    const toolName =
      stringAt(payload, [
        ["params", "name"],
        ["params", "tool"],
        ["params", "item", "type"],
      ]) ?? (normalizedItemType === "commandexecution" ? "commandExecution" : itemType);
    const toolInput = valueAtPaths(payload, [
      ["params", "arguments"],
      ["params", "input"],
      ["params", "item", "arguments"],
    ]);
    const toolCommand = stringAt(payload, [
      ["params", "command"],
      ["params", "cmd"],
      ["params", "item", "command"],
    ]);
    const toolOutput = stringAt(payload, [
      ["params", "outputDelta"],
      ["params", "delta"],
      ["params", "output"],
    ]);
    const toolError = stringAt(payload, [
      ["params", "error"],
      ["params", "error", "message"],
    ]);
    return {
      activity_type: "tool_call",
      activity_status: phase === "complete" ? "completed" : "streaming",
      presentation_role: "working",
      ...(activityId !== null ? { activity_id: activityId } : {}),
      ...(toolName !== null ? { tool_name: toolName } : {}),
      ...(toolInput !== undefined ? { tool_input: toolInput } : {}),
      ...(toolCommand !== null ? { tool_command: toolCommand } : {}),
      ...(toolOutput !== null ? { tool_output_delta: toolOutput } : {}),
      ...(toolError !== null ? { tool_error: toolError } : {}),
      ...(parentMessageId !== null ? { parent_message_id: parentMessageId } : {}),
    };
  }

  return {};
}

function itemPhase(method: string): "start" | "delta" | "complete" | null {
  if (method === "item/started" || method.endsWith("item_started")) {
    return "start";
  }
  if (method === "item/completed" || method.endsWith("item_completed")) {
    return "complete";
  }
  if (method.includes("/delta") || method.endsWith("_delta")) {
    return "delta";
  }
  return null;
}

function isCodexToolType(value: string): boolean {
  return ["commandexecution", "filechange", "mcptoolcall", "mcpcall", "toolcall"].includes(value);
}

function normalizedTypeIs(value: string, expected: string): boolean {
  return value === expected || value === `${expected}item`;
}

function finalAgentMessage(value: unknown, depth = 0): { id: string | null; text: string } | null {
  if (depth > 8) {
    return null;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = finalAgentMessage(item, depth + 1);
      if (found !== null) {
        return found;
      }
    }
    return null;
  }
  if (!isObject(value)) {
    return null;
  }
  if (normalizeType(value.type as unknown) === "agentmessage" && typeof value.text === "string") {
    return {
      id: typeof value.id === "string" ? value.id : null,
      text: value.text,
    };
  }
  const preferred = ["turn", "items", "item", "finalAgentMessage", "params", "payload"];
  for (const key of preferred) {
    if (!(key in value)) {
      continue;
    }
    const found = finalAgentMessage(value[key], depth + 1);
    if (found !== null) {
      return found;
    }
  }
  for (const child of Object.values(value)) {
    const found = finalAgentMessage(child, depth + 1);
    if (found !== null) {
      return found;
    }
  }
  return null;
}

function normalizeType(value: unknown): string {
  return typeof value === "string" ? value.replace(/[^a-z]/gi, "").toLowerCase() : "";
}

function stringAt(value: unknown, paths: string[][]): string | null {
  for (const path of paths) {
    const candidate = valueAt(value, path);
    if (typeof candidate === "string" && candidate.trim() !== "") {
      return candidate;
    }
  }
  return null;
}

function valueAt(value: unknown, path: string[]): unknown {
  let current: unknown = value;
  for (const key of path) {
    if (!isObject(current) || !(key in current)) {
      return undefined;
    }
    current = current[key];
  }
  return current;
}

function valueAtPaths(value: unknown, paths: string[][]): unknown {
  for (const path of paths) {
    const candidate = valueAt(value, path);
    if (candidate !== undefined) {
      return candidate;
    }
  }
  return undefined;
}

// Focused copy of the orchestrator's rate-limit sniffing: finds a
// { limit_id|limit_name, primary|secondary|credits } map anywhere under the
// codex payload. Kept independent of orchestrator.ts so the envelope lift and
// the orchestrator's fallback stay decoupled but agree on the same shape.
function rateLimitsFromPayload(payload: unknown): Record<string, unknown> | null {
  if (Array.isArray(payload)) {
    return firstRateLimits(payload);
  }
  if (!isObject(payload)) {
    return null;
  }
  const direct = payload.rate_limits;
  if (isRateLimitsMap(direct)) {
    return direct;
  }
  if (isRateLimitsMap(payload)) {
    return payload;
  }
  return firstRateLimits(Object.values(payload));
}

function firstRateLimits(values: unknown[]): Record<string, unknown> | null {
  for (const value of values) {
    const found = rateLimitsFromPayload(value);
    if (found !== null) {
      return found;
    }
  }
  return null;
}

function isRateLimitsMap(payload: unknown): payload is Record<string, unknown> {
  if (!isObject(payload)) {
    return false;
  }
  const limitId = payload.limit_id ?? payload.limit_name;
  const hasBuckets = ["primary", "secondary", "credits"].some((key) => key in payload);
  return limitId !== null && limitId !== undefined && hasBuckets;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toolExecutorFor(provider: ToolProvider): AppServer.ToolExecutor {
  return async (tool, args) => DynamicTool.encodeToolOutcome(await provider.execute(tool, args));
}

function codexPid(appSession: AppServer.Session): string | undefined {
  const pid = appSession.metadata.codexAppServerPid;
  return typeof pid === "string" ? pid : undefined;
}

export const CodexPlugin: AgentBackendPlugin = {
  id: "codex",
  displayName: "Codex app-server",

  sessions: {
    startSession,
    runTurn,
    stopSession,
  },

  capabilities: {
    multiTurnSessions: true,
    remoteWorkers: true,
    rateLimitTelemetry: true,
  },

  ui: {
    humanizeMessage: (message) => humanizeCodexMessage(message),
  },

  replay: {
    replayTranscript: (serverMessages) => AppServer.replayTranscript(serverMessages),
  },
};
