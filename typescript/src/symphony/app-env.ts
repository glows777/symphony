// TypeScript equivalent of Elixir's `Application` environment for the
// `:symphony_elixir` app: a process-global, mutable key/value store used for
// runtime configuration and test injection (e.g. `:log_file`,
// `:memory_tracker_issues`, `:memory_tracker_recipient`). See MIGRATION.md.

const env = new Map<string, unknown>();

// `Application.get_env(:symphony_elixir, key, default)`.
export function getEnv<T>(key: string, defaultValue: T): T {
  return env.has(key) ? (env.get(key) as T) : defaultValue;
}

// `Application.fetch_env(:symphony_elixir, key)` — undefined when unset.
export function fetchEnv<T>(key: string): T | undefined {
  return env.get(key) as T | undefined;
}

// `Application.put_env(:symphony_elixir, key, value)`.
export function putEnv(key: string, value: unknown): void {
  env.set(key, value);
}

// `Application.delete_env(:symphony_elixir, key)`.
export function deleteEnv(key: string): void {
  env.delete(key);
}
