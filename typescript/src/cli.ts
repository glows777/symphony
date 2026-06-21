#!/usr/bin/env bun
// Literal port of `symphony_elixir/cli.ex`.
//
// The escript entrypoint becomes a Bun CLI: `evaluate(args, deps)` parses flags
// (`--i-understand-...`, `--logs-root`, `--port`) and an optional WORKFLOW.md
// path, enforces the guardrails acknowledgement, applies overrides, then starts
// the app. Dependency injection (the Elixir `deps` map) keeps `evaluate`
// testable; `main` wires the runtime deps and waits for shutdown.

import path from "node:path";
import { putEnv } from "./symphony/app-env.ts";
import { defaultLogFile } from "./symphony/log-file.ts";
import { type Result, err, ok } from "./symphony/result.ts";
import { setWorkflowFilePath } from "./symphony/workflow.ts";

const ACK_FLAG = "--i-understand-that-this-will-be-running-without-the-usual-guardrails";

const ACK_LINES = [
  "This Symphony implementation is a low key engineering preview.",
  "Codex will run without any guardrails.",
  "SymphonyElixir is not a supported product and is presented as-is.",
  "To proceed, start with `--i-understand-that-this-will-be-running-without-the-usual-guardrails` CLI argument",
];

export type Deps = {
  fileRegular(filePath: string): boolean;
  setWorkflowFilePath(filePath: string): void;
  setLogsRoot(filePath: string): void;
  setServerPortOverride(port: number): void;
  ensureAllStarted(): Result<unknown, unknown> | Promise<Result<unknown, unknown>>;
};

type ParsedArgs = {
  ack: boolean;
  logsRoot: string[];
  port: number[];
  positional: string[];
  invalid: boolean;
};

// Port of `evaluate/2`.
export async function evaluate(
  args: string[],
  deps: Deps = runtimeDeps(),
): Promise<Result<undefined, string>> {
  const parsed = parseArgs(args);
  if (parsed.invalid || parsed.positional.length > 1) {
    return err(usageMessage());
  }

  const ack = requireGuardrailsAcknowledgement(parsed);
  if (!ack.ok) {
    return ack;
  }
  const logs = maybeSetLogsRoot(parsed, deps);
  if (!logs.ok) {
    return logs;
  }
  const portResult = maybeSetServerPort(parsed, deps);
  if (!portResult.ok) {
    return portResult;
  }

  const workflowPath = parsed.positional[0] ?? "WORKFLOW.md";
  return run(workflowPath, deps);
}

// Port of `run/2`.
export async function run(workflowPath: string, deps: Deps): Promise<Result<undefined, string>> {
  const expanded = path.resolve(workflowPath);
  if (!deps.fileRegular(expanded)) {
    return err(`Workflow file not found: ${expanded}`);
  }
  deps.setWorkflowFilePath(expanded);
  const started = await deps.ensureAllStarted();
  if (started.ok) {
    return ok(undefined);
  }
  return err(`Failed to start Symphony with workflow ${expanded}: ${inspectReason(started.error)}`);
}

// ---- arg parsing (OptionParser strict) -------------------------------------

function parseArgs(args: string[]): ParsedArgs {
  const parsed: ParsedArgs = {
    ack: false,
    logsRoot: [],
    port: [],
    positional: [],
    invalid: false,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string;
    if (!arg.startsWith("--")) {
      parsed.positional.push(arg);
      continue;
    }
    const eq = arg.indexOf("=");
    const name = eq === -1 ? arg.slice(2) : arg.slice(2, eq);
    const inlineValue = eq === -1 ? null : arg.slice(eq + 1);

    if (name === "i-understand-that-this-will-be-running-without-the-usual-guardrails") {
      parsed.ack = true;
      continue;
    }
    if (name === "logs-root") {
      const value = inlineValue ?? args[++i];
      if (value === undefined) {
        parsed.invalid = true;
      } else {
        parsed.logsRoot.push(value);
      }
      continue;
    }
    if (name === "port") {
      const value = inlineValue ?? args[++i];
      const port = parsePort(value);
      if (port === null) {
        parsed.invalid = true;
      } else {
        parsed.port.push(port);
      }
      continue;
    }
    parsed.invalid = true;
  }

  return parsed;
}

function parsePort(value: string | undefined): number | null {
  if (value === undefined) {
    return null;
  }
  if (!/^[+-]?\d+$/.test(value.trim())) {
    return null;
  }
  return Number.parseInt(value.trim(), 10);
}

// ---- step handlers ---------------------------------------------------------

function requireGuardrailsAcknowledgement(parsed: ParsedArgs): Result<undefined, string> {
  return parsed.ack ? ok(undefined) : err(acknowledgementBanner());
}

function maybeSetLogsRoot(parsed: ParsedArgs, deps: Deps): Result<undefined, string> {
  if (parsed.logsRoot.length === 0) {
    return ok(undefined);
  }
  const logsRoot = (parsed.logsRoot[parsed.logsRoot.length - 1] as string).trim();
  if (logsRoot === "") {
    return err(usageMessage());
  }
  deps.setLogsRoot(path.resolve(logsRoot));
  return ok(undefined);
}

function maybeSetServerPort(parsed: ParsedArgs, deps: Deps): Result<undefined, string> {
  if (parsed.port.length === 0) {
    return ok(undefined);
  }
  const port = parsed.port[parsed.port.length - 1] as number;
  if (Number.isInteger(port) && port >= 0) {
    deps.setServerPortOverride(port);
    return ok(undefined);
  }
  return err(usageMessage());
}

function usageMessage(): string {
  return "Usage: symphony [--logs-root <path>] [--port <port>] [path-to-WORKFLOW.md]";
}

function acknowledgementBanner(): string {
  const width = Math.max(...ACK_LINES.map((line) => line.length));
  const border = "─".repeat(width + 2);
  const top = `╭${border}╮`;
  const bottom = `╰${border}╯`;
  const spacer = `│ ${" ".repeat(width)} │`;
  const content = [
    top,
    spacer,
    ...ACK_LINES.map((line) => `│ ${line.padEnd(width)} │`),
    spacer,
    bottom,
  ].join("\n");
  return `\x1b[31m\x1b[1m${content}\x1b[0m`;
}

function inspectReason(reason: unknown): string {
  if (typeof reason === "string") {
    return reason;
  }
  try {
    return JSON.stringify(reason);
  } catch {
    return String(reason);
  }
}

// ---- runtime wiring --------------------------------------------------------

function runtimeDeps(): Deps {
  return {
    fileRegular: (filePath) => {
      try {
        return require("node:fs").statSync(filePath).isFile();
      } catch {
        return false;
      }
    },
    setWorkflowFilePath: (filePath) => setWorkflowFilePath(filePath),
    setLogsRoot: (logsRoot) => {
      putEnv("log_file", defaultLogFile(logsRoot));
    },
    setServerPortOverride: (port) => {
      putEnv("server_port_override", port);
    },
    ensureAllStarted: async () => {
      const { startApp } = await import("./app.ts");
      return startApp();
    },
  };
}

export async function main(
  args: string[],
  deps: Deps = runtimeDeps(),
  wait: () => Promise<void> = waitForShutdown,
): Promise<number> {
  const result = await evaluate(args, deps);
  if (!result.ok) {
    process.stderr.write(`${result.error}\n`);
    return 1;
  }
  // Port of `wait_for_shutdown/0`: Elixir's `main/1` blocks forever monitoring
  // the supervisor. Here the started Bun.serve + orchestrator timers keep the
  // event loop alive; we block until a termination signal and then exit 0, so
  // the entry point does NOT tear the just-started app down.
  await wait();
  return 0;
}

function waitForShutdown(): Promise<void> {
  return new Promise<void>((resolve) => {
    const stop = (): void => resolve();
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
}

if (import.meta.main) {
  main(Bun.argv.slice(2)).then((code) => process.exit(code));
}

// Exported for parity with the Elixir `@ack_flag` used in tests.
export { ACK_FLAG };
