// Literal port of `symphony_elixir/ssh.ex`.
//
// Builds ssh invocations for remote workers. Elixir's System.cmd/Port.open map
// to Bun.spawnSync/Bun.spawn; `find_executable` maps to Bun.which.

import { type Result, err, ok } from "./result.ts";

export type RunOpts = {
  stderrToStdout?: boolean;
  cwd?: string;
  env?: Record<string, string>;
};

export type StartPortOpts = {
  line?: number;
};

export function run(
  host: string,
  command: string,
  opts: RunOpts = {},
): Result<[string, number], unknown> {
  const executable = sshExecutable();
  if (!executable.ok) {
    return err(executable.error);
  }
  const proc = Bun.spawnSync([executable.value, ...sshArgs(host, command)], {
    ...(opts.cwd === undefined ? {} : { cwd: opts.cwd }),
    ...(opts.env === undefined ? {} : { env: opts.env }),
  });
  const stdout = proc.stdout ? proc.stdout.toString() : "";
  const stderr = proc.stderr ? proc.stderr.toString() : "";
  const output = opts.stderrToStdout ? stdout + stderr : stdout;
  return ok([output, proc.exitCode]);
}

export function startPort(
  host: string,
  command: string,
  _opts: StartPortOpts = {},
): Result<Bun.Subprocess, unknown> {
  const executable = sshExecutable();
  if (!executable.ok) {
    return err(executable.error);
  }
  // The Elixir `:line` port option frames stdout; in Bun line framing is handled
  // by the reader, so the process is spawned the same way regardless.
  const proc = Bun.spawn([executable.value, ...sshArgs(host, command)], {
    stdout: "pipe",
    stderr: "pipe",
  });
  return ok(proc);
}

export function remoteShellCommand(command: string): string {
  return `bash -lc ${shellEscape(command)}`;
}

function sshExecutable(): Result<string, unknown> {
  const executable = Bun.which("ssh", { PATH: process.env.PATH ?? "" });
  return executable === null ? err({ tag: "ssh_not_found" }) : ok(executable);
}

function sshArgs(host: string, command: string): string[] {
  const { destination, port } = parseTarget(host);

  let args: string[] = [];
  args = maybePutConfig(args);
  args = args.concat(["-T"]);
  if (port !== null) {
    args = args.concat(["-p", port]);
  }
  return args.concat([destination, remoteShellCommand(command)]);
}

function maybePutConfig(args: string[]): string[] {
  const configPath = process.env.SYMPHONY_SSH_CONFIG;
  if (typeof configPath === "string" && configPath !== "") {
    return args.concat(["-F", configPath]);
  }
  return args;
}

function parseTarget(target: string): { destination: string; port: string | null } {
  const trimmed = target.trim();

  // OpenSSH treats a bare "host:port" as one hostname; split the shorthand so
  // worker config can use "localhost:2222" without ssh:// URIs.
  const match = /^(.*):(\d+)$/.exec(trimmed);
  if (match) {
    const destination = match[1] as string;
    const port = match[2] as string;
    if (validPortDestination(destination)) {
      return { destination, port };
    }
  }
  return { destination: trimmed, port: null };
}

function validPortDestination(destination: string): boolean {
  return destination !== "" && (!destination.includes(":") || bracketedHost(destination));
}

function bracketedHost(destination: string): boolean {
  // IPv6 literals contain ":"; only accept ":port" parsing for bracketed hosts.
  return destination.includes("[") && destination.includes("]");
}

function shellEscape(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}
