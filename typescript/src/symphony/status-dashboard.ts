// Literal port of `symphony_elixir/status_dashboard.ex` (rendering pipeline).
//
// Renders the orchestrator/worker status snapshot as an ANSI terminal UI. This
// port covers the pure rendering + Codex-message humanization exercised by the
// golden snapshot fixtures and unit seams; the GenServer render loop is a thin
// wrapper added when the orchestrator is wired. Snapshot data uses Elixir's
// snake_case field names so the orchestrator snapshot maps over unchanged.

import { serverPort, settings, settingsBang } from "./config.ts";
import { agentBackendOrNull } from "./plugins/agents/registry.ts";
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

// Frozen export name (web/presenter.ts depends on it). Now forwards to the
// active backend's humanize path rather than a hardcoded codex renderer.
export function humanizeCodexMessageExport(message: unknown): string {
  return summarizeMessage(message);
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

// ---- agent message summarization -------------------------------------------
//
// The per-backend "last message" copy comes from the active agent backend's
// `ui.humanizeMessage` capability (the codex backend ships the former
// humanizeCodex* logic verbatim in plugins/agents/codex/humanize.ts). Backends
// without the hook fall back to a generic one-liner.

function summarizeMessage(message: unknown): string {
  return activeBackendHumanize(message) ?? genericSummarize(message);
}

function activeBackendHumanize(message: unknown): string | null {
  const config = settings();
  if (!config.ok) {
    return null;
  }
  return agentBackendOrNull(config.value.agent.backend)?.ui?.humanizeMessage?.(message) ?? null;
}

function genericSummarize(message: unknown): string {
  if (message === null || message === undefined) {
    return "no agent message yet";
  }
  if (isObject(message) && "event" in message) {
    const event = message.event;
    return typeof event === "string" ? event : "agent message";
  }
  return truncate(inspect(message).replace(/\n/g, " ").trim(), 140);
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

// ---- small helpers ---------------------------------------------------------

function colorize(value: string, code: string): string {
  return `${code}${value}${ANSI_RESET}`;
}

function closingBorder(): string {
  return "╰─";
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
