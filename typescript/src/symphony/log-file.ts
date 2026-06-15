// Literal port of `symphony_elixir/log_file.ex`.
//
// In Elixir this configures OTP's rotating disk_log handler. Bun has no direct
// equivalent OTP logger, so `configure()` is a best-effort analog that resolves
// the log path and ensures its directory exists; the pure path helpers
// (`defaultLogFile`) carry the tested behavior. See MIGRATION.md.

import fs from "node:fs";
import path from "node:path";
import { getEnv } from "./app-env.ts";

const DEFAULT_LOG_RELATIVE_PATH = "log/symphony.log";
const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;
const DEFAULT_MAX_FILES = 5;

export function defaultLogFile(logsRoot: string = process.cwd()): string {
  return path.join(logsRoot, DEFAULT_LOG_RELATIVE_PATH);
}

export type LogFileConfig = {
  logFile: string;
  maxBytes: number;
  maxFiles: number;
};

// Resolves the configured log file and ensures its directory exists, mirroring
// the setup performed by the Elixir handler before installation.
export function configure(): LogFileConfig {
  const logFile = getEnv<string>("log_file", defaultLogFile());
  const maxBytes = getEnv<number>("log_file_max_bytes", DEFAULT_MAX_BYTES);
  const maxFiles = getEnv<number>("log_file_max_files", DEFAULT_MAX_FILES);

  const expandedPath = path.resolve(logFile);
  fs.mkdirSync(path.dirname(expandedPath), { recursive: true });

  return { logFile: expandedPath, maxBytes, maxFiles };
}
