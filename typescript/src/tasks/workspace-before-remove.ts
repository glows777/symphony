// Literal port of `mix/tasks/workspace.before_remove.ex`.
//
// Closes open GitHub PRs for the current Git branch before workspace removal.
// `System.cmd(..., stderr_to_stdout: true)` → `Bun.spawnSync` with merged
// stdout/stderr; `System.find_executable/1` → `Bun.which`. The Elixir
// `Mix.shell()` info/error sink is injected as a `Shell` so output is testable.

const DEFAULT_REPO = "openai/symphony";

const HELP_TEXT = `Closes open pull requests for the current Git branch.

This task is intended for use from the \`before_remove\` workspace hook.

Usage:

    mix workspace.before_remove
    mix workspace.before_remove --branch feature/my-branch
    mix workspace.before_remove --repo openai/symphony
`;

export type Shell = {
  info(message: string): void;
  error(message: string): void;
};

const defaultShell: Shell = {
  info: (message) => process.stdout.write(`${message}\n`),
  error: (message) => process.stderr.write(`${message}\n`),
};

type CommandResult =
  | { ok: true; output: string }
  | { ok: false; status: number | "enoent"; output: string };

// Port of `run/1`. Throws (≈ `Mix.raise`) on invalid options.
export function run(args: string[], shell: Shell = defaultShell): void {
  const parsed = parseArgs(args);
  if (parsed.help) {
    shell.info(HELP_TEXT);
    return;
  }
  if (parsed.invalid.length > 0) {
    throw new Error(`Invalid option(s): ${JSON.stringify(parsed.invalid)}`);
  }
  const repo = parsed.repo ?? DEFAULT_REPO;
  const branch = parsed.branch ?? currentBranch();
  maybeCloseOpenPullRequests(repo, branch, shell);
}

function maybeCloseOpenPullRequests(repo: string, branch: string | null, shell: Shell): void {
  if (branch === null) {
    return;
  }
  if (ghAvailable() && ghAuthenticated()) {
    for (const prNumber of listOpenPullRequestNumbers(repo, branch)) {
      closePullRequest(repo, branch, prNumber, shell);
    }
  }
}

function ghAvailable(): boolean {
  return findExecutable("gh") !== null;
}

function ghAuthenticated(): boolean {
  return runCommand("gh", ["auth", "status"]).ok;
}

function listOpenPullRequestNumbers(repo: string, branch: string): string[] {
  const result = runCommand("gh", [
    "pr",
    "list",
    "--repo",
    repo,
    "--head",
    branch,
    "--state",
    "open",
    "--json",
    "number",
    "--jq",
    ".[].number",
  ]);
  if (!result.ok) {
    return [];
  }
  return result.output.split("\n").filter((line) => line.trim() !== "");
}

function closePullRequest(repo: string, branch: string, prNumber: string, shell: Shell): void {
  const result = runCommand("gh", [
    "pr",
    "close",
    prNumber,
    "--repo",
    repo,
    "--comment",
    closingComment(branch),
  ]);
  if (result.ok) {
    shell.info(`Closed PR #${prNumber} for branch ${branch}`);
    return;
  }
  const trimmed = result.output.trim();
  shell.error(
    `Failed to close PR #${prNumber} for branch ${branch}: exit ${result.status}${formatOutput(trimmed)}`,
  );
}

function closingComment(branch: string): string {
  return `Closing because the Linear issue for branch ${branch} entered a terminal state without merge.`;
}

function formatOutput(output: string): string {
  return output === "" ? "" : ` output=${JSON.stringify(output)}`;
}

function currentBranch(): string | null {
  const result = runCommand("git", ["branch", "--show-current"]);
  if (!result.ok) {
    return null;
  }
  const branch = result.output.trim();
  return branch === "" ? null : branch;
}

// ---- subprocess helpers ----------------------------------------------------

function findExecutable(command: string): string | null {
  return Bun.which(command, { PATH: process.env.PATH ?? "" }) ?? null;
}

function runCommand(command: string, args: string[]): CommandResult {
  const path = findExecutable(command);
  if (path === null) {
    return { ok: false, status: "enoent", output: "" };
  }
  const proc = Bun.spawnSync([path, ...args], { env: process.env, stdout: "pipe", stderr: "pipe" });
  const decoder = new TextDecoder();
  // `stderr_to_stdout: true` — merge both streams into one output buffer.
  const output = decoder.decode(proc.stdout) + decoder.decode(proc.stderr);
  if (proc.exitCode === 0) {
    return { ok: true, output };
  }
  return { ok: false, status: proc.exitCode ?? 1, output };
}

// ---- option parsing --------------------------------------------------------

type ParsedArgs = { branch: string | null; repo: string | null; help: boolean; invalid: string[] };

function parseArgs(args: string[]): ParsedArgs {
  const parsed: ParsedArgs = { branch: null, repo: null, help: false, invalid: [] };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string;
    if (arg === "--help" || arg === "-h") {
      parsed.help = true;
      continue;
    }
    const eq = arg.indexOf("=");
    const name = arg.startsWith("--") ? (eq === -1 ? arg.slice(2) : arg.slice(2, eq)) : arg;
    const inlineValue = eq === -1 ? null : arg.slice(eq + 1);
    if (name === "branch") {
      parsed.branch = inlineValue ?? args[++i] ?? "";
    } else if (name === "repo") {
      parsed.repo = inlineValue ?? args[++i] ?? "";
    } else {
      parsed.invalid.push(arg);
    }
  }
  return parsed;
}
