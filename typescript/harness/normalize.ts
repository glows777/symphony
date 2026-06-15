// Normalization neutralizes volatile values so a recorded Elixir fixture can be
// compared against fresh TypeScript output. Without this, every comparison would
// fail on timestamps, session ids, ephemeral ports, and absolute paths.
//
// Normalization is intentionally shared between the recorder and the asserter so
// both sides apply byte-identical rules.

/** Default object keys whose values are replaced with a stable placeholder. */
export const DEFAULT_REDACTED_KEYS: Readonly<Record<string, string>> = {
  // Presenter timestamps (Presenter.iso8601 / due_at_iso8601)
  generated_at: "<TIMESTAMP>",
  started_at: "<TIMESTAMP>",
  last_event_at: "<TIMESTAMP>",
  blocked_at: "<TIMESTAMP>",
  due_at: "<TIMESTAMP>",
  requested_at: "<TIMESTAMP>",
  at: "<TIMESTAMP>",
  // Codex session identifiers
  session_id: "<SESSION>",
  thread_id: "<THREAD>",
  threadId: "<THREAD>",
  // Durations vary run to run
  seconds_running: "<DURATION>",
};

/** Regex redactions applied to every string value. */
const STRING_REDACTIONS: ReadonlyArray<readonly [RegExp, string]> = [
  // ISO-8601 timestamps (with optional fractional seconds / Z offset)
  [/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})?/g, "<TIMESTAMP>"],
  // UUIDs (Codex thread/session ids embedded in strings)
  [/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "<UUID>"],
];

export interface NormalizeOptions {
  /** Extra key→placeholder redactions merged over the defaults. */
  readonly redactKeys?: Readonly<Record<string, string>>;
  /**
   * Path prefixes (e.g. the workspace root, a temp dir) replaced with a stable
   * placeholder so absolute paths do not break comparisons.
   */
  readonly pathPrefixes?: Readonly<Record<string, string>>;
}

function redactString(value: string, pathPrefixes: Record<string, string>): string {
  let result = value;
  for (const [prefix, placeholder] of Object.entries(pathPrefixes)) {
    if (prefix.length > 0) {
      result = result.split(prefix).join(placeholder);
    }
  }
  for (const [pattern, placeholder] of STRING_REDACTIONS) {
    result = result.replace(pattern, placeholder);
  }
  return result;
}

/**
 * Return a deep clone of `value` with volatile fields replaced by placeholders.
 * Pure and non-mutating.
 */
export function normalize(value: unknown, options: NormalizeOptions = {}): unknown {
  const redactKeys = { ...DEFAULT_REDACTED_KEYS, ...(options.redactKeys ?? {}) };
  const pathPrefixes = options.pathPrefixes ?? {};

  const walk = (node: unknown): unknown => {
    if (typeof node === "string") {
      return redactString(node, pathPrefixes);
    }
    if (Array.isArray(node)) {
      return node.map(walk);
    }
    if (node !== null && typeof node === "object") {
      const out: Record<string, unknown> = {};
      for (const [key, child] of Object.entries(node)) {
        out[key] = key in redactKeys ? redactKeys[key] : walk(child);
      }
      return out;
    }
    return node;
  };

  return walk(value);
}
