// Codex message humanization for the dashboard/JSON-API "last message" line.
//
// Moved verbatim from status-dashboard.ts (P3, "move only, don't change"): the
// codex backend owns rendering its own raw payloads, exposed through the plugin
// `ui.humanizeMessage` capability. The golden snapshot fixtures pin this output
// byte-for-byte, so the logic — including the codex method names (`turn/*`,
// `item/*`, `codex/event/*`) it keys on — is unchanged. The self-contained
// helpers at the bottom (mapValue/isObject/truncate/...) are copies of the
// dashboard primitives kept here so this module has no imports (and no cycle).

type Json = Record<string, unknown>;

export function humanizeCodexMessage(message: unknown): string {
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

// ---- shared primitives (copies of the status-dashboard.ts helpers) ---------

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

function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
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
