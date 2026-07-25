// claude_code message humanization for the dashboard/JSON-API "last message"
// line (ui.humanizeMessage). Receives the stored last-message value, which the
// orchestrator sets to the raw CLI payload (update.payload ?? update.raw), i.e.
// a parsed stream-json object like { type: "assistant" | "result" | ... }.
// Returns null to fall back to the generic summarizer. The CLI's message shapes
// are far simpler than codex's, so this stays a few branches.

const MAX = 140;

export function humanizeClaudeMessage(message: unknown): string | null {
  if (!isObject(message)) {
    return null;
  }
  switch (message.type) {
    case "assistant":
      return humanizeAssistant(message);
    case "user":
      return "tool result";
    case "result":
      return humanizeResult(message);
    case "system":
      return message.subtype === "init"
        ? "session started"
        : typeof message.subtype === "string"
          ? `system: ${message.subtype}`
          : null;
    default:
      return null;
  }
}

function humanizeAssistant(message: Record<string, unknown>): string | null {
  const content = isObject(message.message) ? message.message.content : undefined;
  if (!Array.isArray(content)) {
    return null;
  }
  for (const block of content) {
    if (!isObject(block)) {
      continue;
    }
    if (block.type === "text" && typeof block.text === "string" && block.text.trim() !== "") {
      return truncate(block.text.trim());
    }
    if (block.type === "tool_use" && typeof block.name === "string") {
      return `using tool: ${block.name}`;
    }
    if (block.type === "thinking") {
      return "thinking";
    }
  }
  return null;
}

function humanizeResult(message: Record<string, unknown>): string {
  if (message.subtype !== "success" || message.is_error === true) {
    const subtype = typeof message.subtype === "string" ? message.subtype : "error";
    return `turn failed (${subtype})`;
  }
  const turns = typeof message.num_turns === "number" ? message.num_turns : null;
  const cost = typeof message.total_cost_usd === "number" ? message.total_cost_usd : null;
  const bits = [
    turns === null ? null : `${turns} turns`,
    cost === null ? null : `$${cost.toFixed(4)}`,
  ]
    .filter((bit): bit is string => bit !== null)
    .join(", ");
  return bits === "" ? "turn completed" : `turn completed (${bits})`;
}

function truncate(value: string): string {
  const flat = value.replace(/\s+/g, " ").trim();
  return flat.length > MAX ? `${flat.slice(0, MAX)}...` : flat;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
