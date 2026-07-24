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
    workspace: appSession.workspace,
    workerHost: appSession.workerHost,
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
  return normalized;
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
