// Literal port of `symphony_elixir/status_dashboard.ex` (rendering pipeline).
//
// Renders the orchestrator/worker status snapshot as an ANSI terminal UI. This
// port covers the pure rendering + Codex-message humanization exercised by the
// golden snapshot fixtures and unit seams; the GenServer render loop is a thin
// wrapper added when the orchestrator is wired. Snapshot data uses Elixir's
// snake_case field names so the orchestrator snapshot maps over unchanged.

import { serverPort, settingsBang } from "./config.ts";
import { trackerPluginOrNull } from "./plugins/registry.ts";
import type { Result } from "./result.ts";
import { boundPort } from "./web/server-port.ts";

// ---- ANSI ------------------------------------------------------------------

const ANSI_RESET = "\x1b[0m";
const ANSI_BOLD = "\x1b[1m";
const ANSI_BLUE = "\x1b[34m";
const ANSI_CYAN = "\x1b[36m";
const ANSI_DIM = "\x1b[2m";
const ANSI_GREEN = "\x1b[32m";
const ANSI_RED = "\x1b[31m";
const ANSI_ORANGE = "\x1b[33m";
const ANSI_YELLOW = "\x1b[33m";
const ANSI_MAGENTA = "\x1b[35m";
const ANSI_GRAY = "\x1b[90m";

const RUNNING_ID_WIDTH = 8;
const RUNNING_STAGE_WIDTH = 14;
const RUNNING_PID_WIDTH = 8;
const RUNNING_AGE_WIDTH = 12;
const RUNNING_TOKENS_WIDTH = 10;
const RUNNING_SESSION_WIDTH = 14;
const RUNNING_EVENT_DEFAULT_WIDTH = 44;
const RUNNING_EVENT_MIN_WIDTH = 12;
const RUNNING_ROW_CHROME_WIDTH = 10;
const DEFAULT_TERMINAL_COLUMNS = 115;

// ---- types -----------------------------------------------------------------

type Json = Record<string, unknown>;

export type RunningEntry = {
  identifier?: string | null;
  state?: string | null;
  session_id?: string | null;
  codex_app_server_pid?: string | null;
  codex_total_tokens?: number | null;
  runtime_seconds?: number | null;
  turn_count?: number;
  last_codex_event?: string | null;
  last_codex_message?: unknown;
};

export type RetryEntry = {
  issue_id?: string | null;
  identifier?: string | null;
  attempt?: number | null;
  due_in_ms?: number | null;
  error?: unknown;
};

export type SnapshotData = {
  running: RunningEntry[];
  retrying: RetryEntry[];
  codex_totals: Json;
  rate_limits?: unknown;
  polling?: unknown;
};

// ---- public test seams -----------------------------------------------------

export function formatSnapshotContentForTest(
  snapshotData: Result<SnapshotData, unknown>,
  tps: number,
  terminalColumns: number | null = null,
): string {
  return formatSnapshotContent(snapshotData, tps, terminalColumns);
}

export function formatRunningSummaryForTest(
  entry: RunningEntry,
  terminalColumns: number | null = null,
): string {
  return formatRunningSummary(entry, runningEventWidth(terminalColumns));
}

export function formatTpsForTest(value: number): string {
  return formatTps(value);
}

export function dashboardUrlForTest(
  host: string,
  configuredPort: number | null,
  bound: number | null,
): string | null {
  return dashboardUrl(host, configuredPort, bound);
}

export function humanizeCodexMessageExport(message: unknown): string {
  return humanizeCodexMessage(message);
}

// ---- live-dashboard notification hook --------------------------------------
//
// Port of `StatusDashboard.notify_update/0`: the orchestrator pings the live
// dashboard process after every state change so it can re-render. The live
// render loop (a GenServer in Elixir) is ported in a later phase and registers
// itself here; until then this is a safe no-op.

export type LiveDashboard = { notifyUpdate(): void };

let liveDashboard: LiveDashboard | null = null;

export function registerLiveDashboard(dashboard: LiveDashboard | null): void {
  liveDashboard = dashboard;
}

export function notifyUpdate(): void {
  liveDashboard?.notifyUpdate();
}

// ---- snapshot rendering ----------------------------------------------------

function formatSnapshotContent(
  snapshotData: Result<SnapshotData, unknown>,
  tps: number,
  terminalColumnsOverride: number | null,
): string {
  if (!snapshotData.ok) {
    return [
      colorize("╭─ SYMPHONY STATUS", ANSI_BOLD),
      colorize("│ Orchestrator snapshot unavailable", ANSI_RED),
      `${colorize("│ Throughput: ", ANSI_BOLD)}${colorize(`${formatTps(tps)} tps`, ANSI_CYAN)}`,
      ...formatProjectLinkLines(),
      formatProjectRefreshLine(null),
      closingBorder(),
    ].join("\n");
  }

  const snapshot = snapshotData.value;
  const codexTotals = snapshot.codex_totals;
  const codexInput = numberOr(codexTotals.input_tokens, 0);
  const codexOutput = numberOr(codexTotals.output_tokens, 0);
  const codexTotal = numberOr(codexTotals.total_tokens, 0);
  const codexSeconds = numberOr(codexTotals.seconds_running, 0);
  const agentCount = snapshot.running.length;
  const maxAgents = settingsBang().agent.maxConcurrentAgents;
  const eventWidth = runningEventWidth(terminalColumnsOverride);
  const runningRows = formatRunningRows(snapshot.running, eventWidth);
  const spacer = snapshot.running.length === 0 ? [] : ["│"];
  const backoffRows = formatRetryRows(snapshot.retrying);

  return [
    colorize("╭─ SYMPHONY STATUS", ANSI_BOLD),
    colorize("│ Agents: ", ANSI_BOLD) +
      colorize(`${agentCount}`, ANSI_GREEN) +
      colorize("/", ANSI_GRAY) +
      colorize(`${maxAgents}`, ANSI_GRAY),
    `${colorize("│ Throughput: ", ANSI_BOLD)}${colorize(`${formatTps(tps)} tps`, ANSI_CYAN)}`,
    colorize("│ Runtime: ", ANSI_BOLD) + colorize(formatRuntimeSeconds(codexSeconds), ANSI_MAGENTA),
    colorize("│ Tokens: ", ANSI_BOLD) +
      colorize(`in ${formatCount(codexInput)}`, ANSI_YELLOW) +
      colorize(" | ", ANSI_GRAY) +
      colorize(`out ${formatCount(codexOutput)}`, ANSI_YELLOW) +
      colorize(" | ", ANSI_GRAY) +
      colorize(`total ${formatCount(codexTotal)}`, ANSI_YELLOW),
    `${colorize("│ Rate Limits: ", ANSI_BOLD)}${formatRateLimits(snapshot.rate_limits ?? null)}`,
    ...formatProjectLinkLines(),
    formatProjectRefreshLine(snapshot.polling ?? null),
    colorize("├─ Running", ANSI_BOLD),
    "│",
    runningTableHeaderRow(eventWidth),
    runningTableSeparatorRow(eventWidth),
    ...runningRows,
    ...spacer,
    colorize("├─ Backoff queue", ANSI_BOLD),
    "│",
    ...backoffRows,
    closingBorder(),
  ].join("\n");
}

function formatProjectLinkLines(): string[] {
  const config = settingsBang();
  const projectUrl = trackerPluginOrNull(config.tracker.kind)?.ui?.projectUrl?.(config) ?? null;
  const projectPart =
    projectUrl !== null ? colorize(projectUrl, ANSI_CYAN) : colorize("n/a", ANSI_GRAY);
  const projectLine = colorize("│ Project: ", ANSI_BOLD) + projectPart;

  const url = dashboardUrl(config.server.host, serverPort(), boundPort());
  if (typeof url === "string") {
    return [projectLine, colorize("│ Dashboard: ", ANSI_BOLD) + colorize(url, ANSI_CYAN)];
  }
  return [projectLine];
}

function formatProjectRefreshLine(polling: unknown): string {
  if (isObject(polling) && polling.checking === true) {
    return colorize("│ Next refresh: ", ANSI_BOLD) + colorize("checking now…", ANSI_CYAN);
  }
  if (isObject(polling) && typeof polling.next_poll_in_ms === "number") {
    const dueInMs = Math.max(polling.next_poll_in_ms, 0);
    const seconds = Math.floor((dueInMs + 999) / 1000);
    return colorize("│ Next refresh: ", ANSI_BOLD) + colorize(`${seconds}s`, ANSI_CYAN);
  }
  return colorize("│ Next refresh: ", ANSI_BOLD) + colorize("n/a", ANSI_GRAY);
}

function dashboardUrl(
  host: string,
  configuredPort: number | null,
  bound: number | null,
): string | null {
  if (configuredPort === null) {
    return null;
  }
  const port = bound ?? configuredPort;
  if (Number.isInteger(port) && port > 0) {
    return `http://${dashboardUrlHost(host)}:${port}/`;
  }
  return null;
}

function dashboardUrlHost(host: string): string {
  const trimmed = host.trim();
  if (["0.0.0.0", "::", "[::]", ""].includes(trimmed)) {
    return "127.0.0.1";
  }
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    return trimmed;
  }
  if (trimmed.includes(":")) {
    return `[${trimmed}]`;
  }
  return trimmed;
}

// ---- running rows ----------------------------------------------------------

function formatRunningRows(running: RunningEntry[], eventWidth: number): string[] {
  if (running.length === 0) {
    return [`│  ${colorize("No active agents", ANSI_GRAY)}`, "│"];
  }
  return [...running]
    .sort((a, b) => compareStrings(a.identifier ?? "", b.identifier ?? ""))
    .map((entry) => formatRunningSummary(entry, eventWidth));
}

function formatRunningSummary(entry: RunningEntry, eventWidth: number): string {
  const issue = formatCell(entry.identifier || "unknown", RUNNING_ID_WIDTH);
  const stateDisplay = formatCell(String(entry.state || "unknown"), RUNNING_STAGE_WIDTH);
  const session = formatCell(compactSessionId(entry.session_id ?? null), RUNNING_SESSION_WIDTH);
  const pid = formatCell(entry.codex_app_server_pid || "n/a", RUNNING_PID_WIDTH);
  const totalTokens = entry.codex_total_tokens ?? 0;
  const runtimeSeconds = entry.runtime_seconds ?? 0;
  const turnCount = entry.turn_count ?? 0;
  const age = formatCell(formatRuntimeAndTurns(runtimeSeconds, turnCount), RUNNING_AGE_WIDTH);
  const event = entry.last_codex_event ?? "none";
  const eventLabel = formatCell(summarizeMessage(entry.last_codex_message), eventWidth);
  const tokens = formatCell(formatCount(totalTokens), RUNNING_TOKENS_WIDTH, "right");

  const statusColor =
    event === "codex/event/token_count"
      ? ANSI_YELLOW
      : event === "codex/event/task_started"
        ? ANSI_GREEN
        : event === "turn_completed"
          ? ANSI_MAGENTA
          : ANSI_BLUE;

  return [
    "│ ",
    statusDot(statusColor),
    " ",
    colorize(issue, ANSI_CYAN),
    " ",
    colorize(stateDisplay, statusColor),
    " ",
    colorize(pid, ANSI_YELLOW),
    " ",
    colorize(age, ANSI_MAGENTA),
    " ",
    colorize(tokens, ANSI_YELLOW),
    " ",
    colorize(session, ANSI_CYAN),
    " ",
    colorize(eventLabel, statusColor),
  ].join("");
}

function runningTableHeaderRow(eventWidth: number): string {
  const header = [
    formatCell("ID", RUNNING_ID_WIDTH),
    formatCell("STAGE", RUNNING_STAGE_WIDTH),
    formatCell("PID", RUNNING_PID_WIDTH),
    formatCell("AGE / TURN", RUNNING_AGE_WIDTH),
    formatCell("TOKENS", RUNNING_TOKENS_WIDTH),
    formatCell("SESSION", RUNNING_SESSION_WIDTH),
    formatCell("EVENT", eventWidth),
  ].join(" ");
  return `│   ${colorize(header, ANSI_GRAY)}`;
}

function runningTableSeparatorRow(eventWidth: number): string {
  const separatorWidth =
    RUNNING_ID_WIDTH +
    RUNNING_STAGE_WIDTH +
    RUNNING_PID_WIDTH +
    RUNNING_AGE_WIDTH +
    RUNNING_TOKENS_WIDTH +
    RUNNING_SESSION_WIDTH +
    eventWidth +
    6;
  return `│   ${colorize("─".repeat(separatorWidth), ANSI_GRAY)}`;
}

function runningEventWidth(terminalColumns: number | null): number {
  const columns = terminalColumns ?? defaultColumns();
  return Math.max(
    RUNNING_EVENT_MIN_WIDTH,
    columns - fixedRunningWidth() - RUNNING_ROW_CHROME_WIDTH,
  );
}

function fixedRunningWidth(): number {
  return (
    RUNNING_ID_WIDTH +
    RUNNING_STAGE_WIDTH +
    RUNNING_PID_WIDTH +
    RUNNING_AGE_WIDTH +
    RUNNING_TOKENS_WIDTH +
    RUNNING_SESSION_WIDTH
  );
}

function defaultColumns(): number {
  const env = process.env.COLUMNS;
  if (env === undefined) {
    return fixedRunningWidth() + RUNNING_ROW_CHROME_WIDTH + RUNNING_EVENT_DEFAULT_WIDTH;
  }
  const parsed = Number.parseInt(env.trim(), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : DEFAULT_TERMINAL_COLUMNS;
}

function formatCell(value: unknown, width: number, align: "left" | "right" = "left"): string {
  const cleaned = String(value).replace(/\n/g, " ").replace(/\s+/g, " ").trim();
  const truncated = truncatePlain(cleaned, width);
  return align === "right" ? truncated.padStart(width) : truncated.padEnd(width);
}

function truncatePlain(value: string, width: number): string {
  if (byteLength(value) <= width) {
    return value;
  }
  return `${value.slice(0, width - 3)}...`;
}

function compactSessionId(sessionId: string | null): string {
  if (typeof sessionId !== "string") {
    return "n/a";
  }
  if (sessionId.length > 10) {
    return `${sessionId.slice(0, 4)}...${sessionId.slice(-6)}`;
  }
  return sessionId;
}

function statusDot(colorCode: string): string {
  return colorize("●", colorCode);
}

// ---- retry rows ------------------------------------------------------------

function formatRetryRows(retrying: RetryEntry[]): string[] {
  if (retrying.length === 0) {
    return [`│  ${colorize("No queued retries", ANSI_GRAY)}`];
  }
  return [...retrying]
    .sort((a, b) => (a.due_in_ms ?? 0) - (b.due_in_ms ?? 0))
    .map(formatRetrySummary)
    .join(", ")
    .split(", ");
}

function formatRetrySummary(entry: RetryEntry): string {
  const issueId = entry.issue_id || "unknown";
  const identifier = entry.identifier || issueId;
  const attempt = entry.attempt ?? 0;
  const dueInMs = entry.due_in_ms ?? 0;
  const error = formatRetryError(entry.error);

  return `│  ${colorize("↻", ANSI_ORANGE)} ${colorize(`${identifier}`, ANSI_RED)} ${colorize(`attempt=${attempt}`, ANSI_YELLOW)}${colorize(" in ", ANSI_DIM)}${colorize(nextInWords(dueInMs), ANSI_CYAN)}${error}`;
}

function nextInWords(dueInMs: unknown): string {
  if (typeof dueInMs === "number" && Number.isInteger(dueInMs)) {
    const secs = Math.trunc(dueInMs / 1000);
    const millis = dueInMs % 1000;
    return `${secs}.${String(millis).padStart(3, "0")}s`;
  }
  return "n/a";
}

function formatRetryError(error: unknown): string {
  if (typeof error !== "string") {
    return "";
  }
  const sanitized = error
    .replace(/\\r\\n/g, " ")
    .replace(/\\r/g, " ")
    .replace(/\\n/g, " ")
    .replace(/\r\n/g, " ")
    .replace(/\r/g, " ")
    .replace(/\n/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (sanitized === "") {
    return "";
  }
  return ` ${colorize(`error=${truncate(sanitized, 96)}`, ANSI_DIM)}`;
}

// ---- numeric formatting ----------------------------------------------------

function formatRuntimeSeconds(seconds: unknown): string {
  if (typeof seconds === "number" && Number.isInteger(seconds)) {
    return `${Math.trunc(seconds / 60)}m ${seconds % 60}s`;
  }
  if (typeof seconds === "string") {
    return seconds;
  }
  return "0m 0s";
}

function formatRuntimeAndTurns(seconds: unknown, turnCount: number): string {
  if (Number.isInteger(turnCount) && turnCount > 0) {
    return `${formatRuntimeSeconds(seconds)} / ${turnCount}`;
  }
  return formatRuntimeSeconds(seconds);
}

function formatCount(value: unknown): string {
  if (value === null || value === undefined) {
    return "0";
  }
  if (typeof value === "number" && Number.isInteger(value)) {
    return groupThousands(String(value));
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    return /^-?\d+$/.test(trimmed) ? groupThousands(String(Number.parseInt(trimmed, 10))) : value;
  }
  return String(value);
}

function groupThousands(value: string): string {
  const sign = value.startsWith("-") ? "-" : "";
  const unsigned = sign === "" ? value : value.slice(1);
  return sign + unsigned.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

function formatTps(value: number): string {
  return groupThousands(String(Math.trunc(value)));
}

function formatNumber(value: number): string {
  if (Number.isInteger(value)) {
    return formatCount(value);
  }
  return value.toFixed(2);
}

// ---- rate limits -----------------------------------------------------------

function formatRateLimits(rateLimits: unknown): string {
  if (rateLimits === null) {
    return colorize("unavailable", ANSI_GRAY);
  }
  if (isObject(rateLimits)) {
    const limitId = mapValue(rateLimits, ["limit_id", "limit_name"]) ?? "unknown";
    const primary = formatRateLimitBucket(mapValue(rateLimits, ["primary"]));
    const secondary = formatRateLimitBucket(mapValue(rateLimits, ["secondary"]));
    const credits = formatRateLimitCredits(mapValue(rateLimits, ["credits"]));
    return (
      colorize(String(limitId), ANSI_YELLOW) +
      colorize(" | ", ANSI_GRAY) +
      colorize(`primary ${primary}`, ANSI_CYAN) +
      colorize(" | ", ANSI_GRAY) +
      colorize(`secondary ${secondary}`, ANSI_CYAN) +
      colorize(" | ", ANSI_GRAY) +
      colorize(credits, ANSI_GREEN)
    );
  }
  return colorize(truncate(inspect(rateLimits), 80), ANSI_GRAY);
}

function formatRateLimitBucket(bucket: unknown): string {
  if (bucket === null || bucket === undefined) {
    return "n/a";
  }
  if (isObject(bucket)) {
    const remaining = mapValue(bucket, ["remaining"]);
    const limit = mapValue(bucket, ["limit"]);
    const resetValue = mapValue(bucket, [
      "reset_in_seconds",
      "resetInSeconds",
      "reset_at",
      "resetAt",
      "resets_at",
      "resetsAt",
    ]);

    let base: string;
    if (integerLike(remaining) && integerLike(limit)) {
      base = `${formatCount(remaining)}/${formatCount(limit)}`;
    } else if (integerLike(remaining)) {
      base = `remaining ${formatCount(remaining)}`;
    } else if (integerLike(limit)) {
      base = `limit ${formatCount(limit)}`;
    } else if (Object.keys(bucket).length === 0) {
      base = "n/a";
    } else {
      base = truncate(inspect(bucket), 40);
    }

    if (resetValue === null || resetValue === undefined) {
      return base;
    }
    return `${base} reset ${formatResetValue(resetValue)}`;
  }
  return String(bucket);
}

function formatRateLimitCredits(credits: unknown): string {
  if (credits === null || credits === undefined) {
    return "credits n/a";
  }
  if (isObject(credits)) {
    const unlimited = mapValue(credits, ["unlimited"]) === true;
    const hasCredits = mapValue(credits, ["has_credits"]) === true;
    const balance = mapValue(credits, ["balance"]);
    if (unlimited) {
      return "credits unlimited";
    }
    if (hasCredits && typeof balance === "number") {
      return `credits ${formatNumber(balance)}`;
    }
    if (hasCredits) {
      return "credits available";
    }
    return "credits none";
  }
  return `credits ${String(credits)}`;
}

function formatResetValue(value: unknown): string {
  if (typeof value === "number" && Number.isInteger(value)) {
    return `${formatCount(value)}s`;
  }
  if (typeof value === "string") {
    return value;
  }
  return String(value);
}

function integerLike(value: unknown): boolean {
  return typeof value === "number" && Number.isInteger(value);
}

// ---- Codex message humanization --------------------------------------------

function summarizeMessage(message: unknown): string {
  return humanizeCodexMessage(message);
}

function humanizeCodexMessage(message: unknown): string {
  if (message === null || message === undefined) {
    return "no codex message yet";
  }
  if (isObject(message) && "event" in message && "message" in message) {
    const payload = unwrapCodexMessagePayload(message.message);
    return truncate(
      humanizeCodexEvent(message.event, message.message, payload) ?? humanizeCodexPayload(payload),
      140,
    );
  }
  if (isObject(message) && "message" in message) {
    return truncate(humanizeCodexPayload(unwrapCodexMessagePayload(message.message)), 140);
  }
  return truncate(humanizeCodexPayload(unwrapCodexMessagePayload(message)), 140);
}

function unwrapCodexMessagePayload(message: unknown): unknown {
  if (!isObject(message)) {
    return message;
  }
  if (typeof mapValue(message, ["method"]) === "string") {
    return message;
  }
  if (typeof mapValue(message, ["session_id"]) === "string") {
    return message;
  }
  if (typeof mapValue(message, ["reason"]) === "string") {
    return message;
  }
  return mapValue(message, ["payload"]) ?? message;
}

function humanizeCodexEvent(event: unknown, message: unknown, payload: unknown): string | null {
  switch (event) {
    case "session_started": {
      const sessionId = mapValue(payload, ["session_id"]);
      return typeof sessionId === "string" ? `session started (${sessionId})` : "session started";
    }
    case "turn_input_required":
      return "turn blocked: waiting for user input";
    case "approval_auto_approved": {
      const method = mapValue(payload, ["method"]) ?? mapPath(message, ["payload", "method"]);
      const decision = mapValue(message, ["decision"]);
      const base =
        typeof method === "string"
          ? `${humanizeCodexMethod(method, payload)} (auto-approved)`
          : "approval request auto-approved";
      return typeof decision === "string" ? `${base}: ${decision}` : base;
    }
    case "tool_input_auto_answered": {
      const answer = mapValue(message, ["answer"]);
      const text = humanizeCodexMethod("item/tool/requestUserInput", payload);
      const base = text === null ? "tool input auto-answered" : `${text} (auto-answered)`;
      return typeof answer === "string" ? `${base}: ${inlineText(answer)}` : base;
    }
    case "tool_call_completed":
      return humanizeDynamicToolEvent("dynamic tool call completed", payload);
    case "tool_call_failed":
      return humanizeDynamicToolEvent("dynamic tool call failed", payload);
    case "unsupported_tool_call":
      return humanizeDynamicToolEvent("unsupported dynamic tool call rejected", payload);
    case "turn_ended_with_error":
      return `turn ended with error: ${formatReason(message)}`;
    case "startup_failed":
      return `startup failed: ${formatReason(message)}`;
    case "turn_failed":
      return humanizeCodexMethod("turn/failed", payload);
    case "turn_cancelled":
      return "turn cancelled";
    case "malformed":
      return "malformed JSON event from codex";
    default:
      return null;
  }
}

function humanizeCodexPayload(payload: unknown): string {
  if (isObject(payload)) {
    const method = mapValue(payload, ["method"]);
    if (typeof method === "string") {
      return humanizeCodexMethod(method, payload) ?? method;
    }
    const sessionId = mapValue(payload, ["session_id"]);
    if (typeof sessionId === "string") {
      return `session started (${sessionId})`;
    }
    if ("error" in payload) {
      return `error: ${formatErrorValue(payload.error)}`;
    }
    return sanitizeAnsiAndControlBytes(inspect(payload).replace(/\n/g, " ")).trim();
  }
  if (typeof payload === "string") {
    return sanitizeAnsiAndControlBytes(payload.replace(/\n/g, " ")).trim();
  }
  return sanitizeAnsiAndControlBytes(inspect(payload).replace(/\n/g, " ")).trim();
}

// Built at runtime from char codes so no literal control bytes appear in source.
const ESC_CHAR = String.fromCharCode(27);
const ANSI_CSI_RE = new RegExp(`${ESC_CHAR}\\[[0-9;]*[A-Za-z]`, "g");
const ANSI_ESC_RE = new RegExp(`${ESC_CHAR}.`, "g");
const CONTROL_BYTES_RE = new RegExp(
  `[${String.fromCharCode(0)}-${String.fromCharCode(31)}${String.fromCharCode(127)}]`,
  "g",
);

function sanitizeAnsiAndControlBytes(value: string): string {
  return value.replace(ANSI_CSI_RE, "").replace(ANSI_ESC_RE, "").replace(CONTROL_BYTES_RE, "");
}

function humanizeCodexMethod(method: string, payload: unknown): string | null {
  switch (method) {
    case "thread/started": {
      const threadId = mapPath(payload, ["params", "thread", "id"]);
      return typeof threadId === "string" ? `thread started (${threadId})` : "thread started";
    }
    case "turn/started": {
      const turnId = mapPath(payload, ["params", "turn", "id"]);
      return typeof turnId === "string" ? `turn started (${turnId})` : "turn started";
    }
    case "turn/completed": {
      const status = mapPath(payload, ["params", "turn", "status"]) ?? "completed";
      const usage =
        mapPath(payload, ["params", "usage"]) ??
        mapPath(payload, ["params", "tokenUsage"]) ??
        mapValue(payload, ["usage"]);
      const usageText = formatUsageCounts(usage);
      const suffix = usageText === null ? "" : ` (${usageText})`;
      return `turn completed (${status})${suffix}`;
    }
    case "turn/failed": {
      const errorMessage = mapPath(payload, ["params", "error", "message"]);
      return typeof errorMessage === "string" ? `turn failed: ${errorMessage}` : "turn failed";
    }
    case "turn/cancelled":
      return "turn cancelled";
    case "turn/diff/updated": {
      const diff = mapPath(payload, ["params", "diff"]) ?? "";
      if (typeof diff === "string" && diff !== "") {
        const lineCount = diff.split("\n").filter((l) => l !== "").length;
        return `turn diff updated (${lineCount} lines)`;
      }
      return "turn diff updated";
    }
    case "turn/plan/updated": {
      const planEntries =
        mapPath(payload, ["params", "plan"]) ??
        mapPath(payload, ["params", "steps"]) ??
        mapPath(payload, ["params", "items"]) ??
        [];
      return Array.isArray(planEntries)
        ? `plan updated (${planEntries.length} steps)`
        : "plan updated";
    }
    case "thread/tokenUsage/updated": {
      const usage =
        mapPath(payload, ["params", "tokenUsage", "total"]) ?? mapValue(payload, ["usage"]);
      const usageText = formatUsageCounts(usage);
      return usageText === null
        ? "thread token usage updated"
        : `thread token usage updated (${usageText})`;
    }
    case "item/started":
      return humanizeItemLifecycle("started", payload);
    case "item/completed":
      return humanizeItemLifecycle("completed", payload);
    case "item/agentMessage/delta":
      return humanizeStreamingEvent("agent message streaming", payload);
    case "item/plan/delta":
      return humanizeStreamingEvent("plan streaming", payload);
    case "item/reasoning/summaryTextDelta":
      return humanizeStreamingEvent("reasoning summary streaming", payload);
    case "item/reasoning/summaryPartAdded":
      return humanizeStreamingEvent("reasoning summary section added", payload);
    case "item/reasoning/textDelta":
      return humanizeStreamingEvent("reasoning text streaming", payload);
    case "item/commandExecution/outputDelta":
      return humanizeStreamingEvent("command output streaming", payload);
    case "item/fileChange/outputDelta":
      return humanizeStreamingEvent("file change output streaming", payload);
    case "item/commandExecution/requestApproval": {
      const command = extractCommand(payload);
      return typeof command === "string"
        ? `command approval requested (${command})`
        : "command approval requested";
    }
    case "item/fileChange/requestApproval": {
      const changeCount =
        mapPath(payload, ["params", "fileChangeCount"]) ??
        mapPath(payload, ["params", "changeCount"]);
      return typeof changeCount === "number" && changeCount > 0
        ? `file change approval requested (${changeCount} files)`
        : "file change approval requested";
    }
    case "item/tool/requestUserInput":
    case "tool/requestUserInput": {
      const question =
        mapPath(payload, ["params", "question"]) ?? mapPath(payload, ["params", "prompt"]);
      return typeof question === "string" && question.trim() !== ""
        ? `tool requires user input: ${inlineText(question)}`
        : "tool requires user input";
    }
    case "account/updated": {
      const authMode = mapPath(payload, ["params", "authMode"]) ?? "unknown";
      return `account updated (auth ${authMode})`;
    }
    case "account/rateLimits/updated": {
      const rateLimits = mapPath(payload, ["params", "rateLimits"]);
      return `rate limits updated: ${formatRateLimitsSummary(rateLimits)}`;
    }
    case "account/chatgptAuthTokens/refresh":
      return "account auth token refresh requested";
    case "item/tool/call": {
      const tool = dynamicToolName(payload);
      return typeof tool === "string" && tool.trim() !== ""
        ? `dynamic tool call requested (${tool})`
        : "dynamic tool call requested";
    }
    default: {
      if (method.startsWith("codex/event/")) {
        return humanizeCodexWrapperEvent(method.slice("codex/event/".length), payload);
      }
      const msgType = mapPath(payload, ["params", "msg", "type"]);
      return typeof msgType === "string" ? `${method} (${msgType})` : method;
    }
  }
}

function humanizeDynamicToolEvent(base: string, payload: unknown): string {
  const tool = dynamicToolName(payload);
  if (typeof tool === "string") {
    const trimmed = tool.trim();
    return trimmed === "" ? base : `${base} (${trimmed})`;
  }
  return base;
}

function dynamicToolName(payload: unknown): unknown {
  return mapPath(payload, ["params", "tool"]) ?? mapPath(payload, ["params", "name"]);
}

function humanizeItemLifecycle(state: string, payload: unknown): string {
  const item = mapPath(payload, ["params", "item"]) ?? {};
  const itemType = humanizeItemType(mapValue(item, ["type"]));
  const itemStatus = mapValue(item, ["status"]);
  const itemId = mapValue(item, ["id"]);

  const details: string[] = [];
  appendIfPresent(details, shortId(itemId));
  appendIfPresent(details, humanizeStatus(itemStatus));
  const suffix = details.length === 0 ? "" : ` (${details.join(", ")})`;
  return `item ${state}: ${itemType}${suffix}`;
}

function humanizeCodexWrapperEvent(event: string, payload: unknown): string {
  switch (event) {
    case "mcp_startup_update": {
      const server = mapPath(payload, ["params", "msg", "server"]) ?? "mcp";
      const state = mapPath(payload, ["params", "msg", "status", "state"]) ?? "updated";
      return `mcp startup: ${server} ${state}`;
    }
    case "mcp_startup_complete":
      return "mcp startup complete";
    case "task_started":
      return "task started";
    case "user_message":
      return "user message received";
    case "item_started": {
      const type = wrapperPayloadType(payload);
      if (type === "token_count") {
        return humanizeCodexWrapperEvent("token_count", payload);
      }
      return typeof type === "string" ? `item started (${humanizeItemType(type)})` : "item started";
    }
    case "item_completed": {
      const type = wrapperPayloadType(payload);
      if (type === "token_count") {
        return humanizeCodexWrapperEvent("token_count", payload);
      }
      return typeof type === "string"
        ? `item completed (${humanizeItemType(type)})`
        : "item completed";
    }
    case "agent_message_delta":
      return humanizeStreamingEvent("agent message streaming", payload);
    case "agent_message_content_delta":
      return humanizeStreamingEvent("agent message content streaming", payload);
    case "agent_reasoning_delta":
      return humanizeStreamingEvent("reasoning streaming", payload);
    case "reasoning_content_delta":
      return humanizeStreamingEvent("reasoning content streaming", payload);
    case "agent_reasoning_section_break":
      return "reasoning section break";
    case "agent_reasoning":
      return humanizeReasoningUpdate(payload);
    case "turn_diff":
      return "turn diff updated";
    case "exec_command_begin":
      return humanizeExecCommandBegin(payload);
    case "exec_command_end":
      return humanizeExecCommandEnd(payload);
    case "exec_command_output_delta":
      return "command output streaming";
    case "mcp_tool_call_begin":
      return "mcp tool call started";
    case "mcp_tool_call_end":
      return "mcp tool call completed";
    case "token_count": {
      const usage = extractFirstPath(payload, tokenUsagePaths());
      const usageText = formatUsageCounts(usage);
      return usageText === null ? "token count update" : `token count update (${usageText})`;
    }
    default: {
      const msgType = mapPath(payload, ["params", "msg", "type"]);
      return typeof msgType === "string" ? `${event} (${msgType})` : event;
    }
  }
}

function humanizeExecCommandBegin(payload: unknown): string {
  const command =
    mapPath(payload, ["params", "msg", "command"]) ??
    mapPath(payload, ["params", "msg", "parsed_cmd"]);
  const normalized = normalizeCommand(command);
  return typeof normalized === "string" ? normalized : "command started";
}

function humanizeExecCommandEnd(payload: unknown): string {
  const exitCode =
    mapPath(payload, ["params", "msg", "exit_code"]) ??
    mapPath(payload, ["params", "msg", "exitCode"]);
  return typeof exitCode === "number" && Number.isInteger(exitCode)
    ? `command completed (exit ${exitCode})`
    : "command completed";
}

function humanizeStreamingEvent(label: string, payload: unknown): string {
  const preview = extractDeltaPreview(payload);
  return preview === null ? label : `${label}: ${preview}`;
}

function humanizeReasoningUpdate(payload: unknown): string {
  const focus = extractReasoningFocus(payload);
  return focus === null ? "reasoning update" : `reasoning update: ${focus}`;
}

function extractReasoningFocus(payload: unknown): string | null {
  const value = extractFirstPath(payload, reasoningFocusPaths());
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed === "" ? null : inlineText(trimmed);
  }
  return null;
}

function extractDeltaPreview(payload: unknown): string | null {
  const delta = extractFirstPath(payload, deltaPaths());
  if (typeof delta === "string") {
    const trimmed = delta.trim();
    return trimmed === "" ? null : inlineText(trimmed);
  }
  return null;
}

function extractCommand(payload: unknown): string | null {
  const parsed = mapPath(payload, ["params", "parsedCmd"]);
  const command =
    parsed ??
    mapPath(payload, ["params", "command"]) ??
    mapPath(payload, ["params", "cmd"]) ??
    mapPath(payload, ["params", "argv"]) ??
    mapPath(payload, ["params", "args"]);
  return normalizeCommand(command);
}

function normalizeCommand(command: unknown): string | null {
  if (isObject(command)) {
    const binaryCommand = mapValue(command, ["parsedCmd", "command", "cmd"]);
    const args = mapValue(command, ["args", "argv"]);
    if (typeof binaryCommand === "string" && Array.isArray(args)) {
      return normalizeCommand([binaryCommand, ...args]);
    }
    return normalizeCommand(binaryCommand ?? args);
  }
  if (typeof command === "string") {
    return inlineText(command);
  }
  if (Array.isArray(command)) {
    return command.every((c) => typeof c === "string") ? inlineText(command.join(" ")) : null;
  }
  return null;
}

function humanizeItemType(type: unknown): string {
  if (type === null || type === undefined) {
    return "item";
  }
  if (typeof type === "string") {
    return type
      .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
      .replace(/_/g, " ")
      .replace(/\//g, " ")
      .toLowerCase()
      .trim();
  }
  return String(type);
}

function humanizeStatus(status: unknown): string | null {
  if (typeof status === "string") {
    return status.replace(/_/g, " ").replace(/-/g, " ").toLowerCase().trim();
  }
  return null;
}

function shortId(id: unknown): string | null {
  if (typeof id === "string") {
    return byteLength(id) > 12 ? id.slice(0, 12) : id;
  }
  return null;
}

function appendIfPresent(list: string[], value: string | null): void {
  if (typeof value === "string" && value !== "") {
    list.push(value);
  }
}

function wrapperPayloadType(payload: unknown): unknown {
  return mapPath(payload, ["params", "msg", "payload", "type"]);
}

// ---- usage / reasons -------------------------------------------------------

function formatUsageCounts(usage: unknown): string | null {
  if (!isObject(usage)) {
    return null;
  }
  const input = parseInteger(
    mapValue(usage, ["input_tokens", "prompt_tokens", "inputTokens", "promptTokens"]),
  );
  const output = parseInteger(
    mapValue(usage, ["output_tokens", "completion_tokens", "outputTokens", "completionTokens"]),
  );
  const total = parseInteger(mapValue(usage, ["total_tokens", "total", "totalTokens"]));

  const parts: string[] = [];
  appendUsagePart(parts, "in", input);
  appendUsagePart(parts, "out", output);
  appendUsagePart(parts, "total", total);
  return parts.length === 0 ? null : parts.join(", ");
}

function appendUsagePart(parts: string[], label: string, value: number | null): void {
  if (typeof value === "number" && Number.isInteger(value)) {
    parts.push(`${label} ${formatCount(value)}`);
  }
}

function formatRateLimitsSummary(rateLimits: unknown): string {
  if (!isObject(rateLimits)) {
    return "n/a";
  }
  const primary = formatRateLimitBucketSummary(mapValue(rateLimits, ["primary"]));
  const secondary = formatRateLimitBucketSummary(mapValue(rateLimits, ["secondary"]));
  if (primary !== null && secondary !== null) {
    return `primary ${primary}; secondary ${secondary}`;
  }
  if (primary !== null) {
    return `primary ${primary}`;
  }
  if (secondary !== null) {
    return `secondary ${secondary}`;
  }
  return "n/a";
}

function formatRateLimitBucketSummary(bucket: unknown): string | null {
  if (!isObject(bucket)) {
    return null;
  }
  const usedPercent = mapValue(bucket, ["usedPercent"]);
  const windowMins = mapValue(bucket, ["windowDurationMins"]);
  if (
    typeof usedPercent === "number" &&
    typeof windowMins === "number" &&
    Number.isInteger(windowMins)
  ) {
    return `${usedPercent}% / ${windowMins}m`;
  }
  if (typeof usedPercent === "number") {
    return `${usedPercent}% used`;
  }
  return null;
}

function formatErrorValue(error: unknown): string {
  if (isObject(error) && typeof error.message === "string") {
    return error.message;
  }
  return inspect(error);
}

function formatReason(message: unknown): string {
  if (isObject(message)) {
    const reason = mapValue(message, ["reason"]);
    if (reason === null || reason === undefined) {
      return inlineText(inspect(message));
    }
    return formatErrorValue(reason);
  }
  return formatErrorValue(message);
}

// ---- map access ------------------------------------------------------------

function mapValue(map: unknown, keys: string[]): unknown {
  if (!isObject(map)) {
    return null;
  }
  for (const key of keys) {
    const value = map[key];
    if (value !== undefined && value !== null) {
      return value;
    }
  }
  return null;
}

function mapPath(data: unknown, keys: string[]): unknown {
  let current: unknown = data;
  for (const key of keys) {
    if (!isObject(current) || !(key in current)) {
      return null;
    }
    current = current[key];
  }
  return current;
}

function extractFirstPath(payload: unknown, paths: string[][]): unknown {
  for (const path of paths) {
    const value = mapPath(payload, path);
    if (value !== null && value !== undefined) {
      return value;
    }
  }
  return null;
}

function tokenUsagePaths(): string[][] {
  return [
    ["params", "msg", "payload", "info", "total_token_usage"],
    ["params", "msg", "info", "total_token_usage"],
    ["params", "tokenUsage", "total"],
  ];
}

function deltaPaths(): string[][] {
  return [
    ["params", "delta"],
    ["params", "msg", "delta"],
    ["params", "textDelta"],
    ["params", "msg", "textDelta"],
    ["params", "outputDelta"],
    ["params", "msg", "outputDelta"],
    ["params", "text"],
    ["params", "msg", "text"],
    ["params", "summaryText"],
    ["params", "msg", "summaryText"],
    ["params", "msg", "content"],
    ["params", "msg", "payload", "delta"],
    ["params", "msg", "payload", "textDelta"],
    ["params", "msg", "payload", "outputDelta"],
    ["params", "msg", "payload", "text"],
    ["params", "msg", "payload", "summaryText"],
    ["params", "msg", "payload", "content"],
  ];
}

function reasoningFocusPaths(): string[][] {
  return [
    ["params", "reason"],
    ["params", "summaryText"],
    ["params", "summary"],
    ["params", "text"],
    ["params", "msg", "reason"],
    ["params", "msg", "summaryText"],
    ["params", "msg", "summary"],
    ["params", "msg", "text"],
    ["params", "msg", "payload", "reason"],
    ["params", "msg", "payload", "summaryText"],
    ["params", "msg", "payload", "summary"],
    ["params", "msg", "payload", "text"],
  ];
}

// ---- small helpers ---------------------------------------------------------

function colorize(value: string, code: string): string {
  return `${code}${value}${ANSI_RESET}`;
}

function closingBorder(): string {
  return "╰─";
}

function inlineText(text: unknown): string {
  return truncate(String(text).replace(/\n/g, " ").replace(/\s+/g, " ").trim(), 80);
}

function parseInteger(value: unknown): number | null {
  if (typeof value === "number" && Number.isInteger(value)) {
    return value;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    return /^-?\d+$/.test(trimmed) ? Number.parseInt(trimmed, 10) : null;
  }
  return null;
}

function truncate(value: string, max: number): string {
  return byteLength(value) > max ? `${value.slice(0, max)}...` : value;
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === "number" ? value : fallback;
}

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function inspect(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}
