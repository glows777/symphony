#!/usr/bin/env bun

// Closes open Gitea pull requests for an issue branch before Symphony resets
// the workspace for Rework or removes a terminal workspace. The task is kept
// separate from the GitHub `gh` task so each workflow can choose its own host
// without weakening the existing GitHub behavior.

const DEFAULT_API_TOKEN_ENV = "GITEA_API_TOKEN";

export type Shell = {
  info(message: string): void;
  error(message: string): void;
};

export type GiteaPullRequestCleanupOptions = {
  endpoint: string;
  owner: string;
  repo: string;
  branch: string;
  token?: string;
};

export type HttpRequest = (input: string, init?: RequestInit) => Promise<Response>;

type NormalizedOptions = Omit<GiteaPullRequestCleanupOptions, "token"> & { token: string };

type CleanupDeps = {
  request?: HttpRequest;
  shell?: Shell;
};

const defaultShell: Shell = {
  info: (message) => process.stdout.write(`${message}\n`),
  error: (message) => process.stderr.write(`${message}\n`),
};

export async function closeOpenPullRequests(
  options: GiteaPullRequestCleanupOptions,
  deps: CleanupDeps = {},
): Promise<void> {
  const shell = deps.shell ?? defaultShell;
  const request = deps.request ?? fetch;
  const config = normalizeOptions(options);
  const base = apiBase(config.endpoint);
  const repositoryPath = `/repos/${encodeURIComponent(config.owner)}/${encodeURIComponent(config.repo)}`;
  const query = new URLSearchParams({ state: "open", head: config.branch, limit: "50" });
  const headers = authHeaders(config.token);
  const listUrl = `${base}${repositoryPath}/pulls?${query.toString()}`;
  const listed = await request(listUrl, { method: "GET", headers, redirect: "error" });
  if (!listed.ok) {
    throw new Error(`Gitea pull-request list failed: ${await responseDetail(listed)}`);
  }
  const pullRequests = parsePullRequests(await listed.json());

  for (const pullRequest of pullRequests) {
    const closeUrl = `${base}${repositoryPath}/pulls/${pullRequest.number}`;
    const closed = await request(closeUrl, {
      method: "PATCH",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ state: "closed" }),
      redirect: "error",
    });
    if (!closed.ok) {
      throw new Error(
        `Gitea pull-request #${pullRequest.number} close failed: ${await responseDetail(closed)}`,
      );
    }
    shell.info(`Closed Gitea PR #${pullRequest.number} for branch ${config.branch}`);
  }
}

type ParsedArgs = {
  endpoint: string | null;
  owner: string | null;
  repo: string | null;
  branch: string | null;
  help: boolean;
  invalid: string[];
};

export async function main(
  args: string[] = Bun.argv.slice(2),
  shell: Shell = defaultShell,
  request: HttpRequest = fetch,
): Promise<number> {
  const parsed = parseArgs(args);
  if (parsed.help) {
    shell.info(
      "Usage: gitea-pr-cleanup --endpoint <url> --owner <owner> --repo <repo> [--branch <branch>]",
    );
    return 0;
  }
  if (parsed.invalid.length > 0) {
    shell.error(`Invalid option(s): ${JSON.stringify(parsed.invalid)}`);
    return 2;
  }

  const branch = parsed.branch ?? currentBranch();
  if (
    parsed.endpoint === null ||
    parsed.owner === null ||
    parsed.repo === null ||
    branch === null
  ) {
    shell.error("endpoint, owner, repo, and a current branch are required");
    return 2;
  }

  try {
    await closeOpenPullRequests(
      {
        endpoint: parsed.endpoint,
        owner: parsed.owner,
        repo: parsed.repo,
        branch,
      },
      { shell, request },
    );
    return 0;
  } catch (error) {
    shell.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

function normalizeOptions(options: GiteaPullRequestCleanupOptions): NormalizedOptions {
  const endpoint = options.endpoint.trim();
  const owner = options.owner.trim();
  const repo = options.repo.trim();
  const branch = options.branch.trim();
  const token = (options.token ?? process.env[DEFAULT_API_TOKEN_ENV] ?? "").trim();
  if (endpoint === "" || owner === "" || repo === "" || branch === "" || token === "") {
    throw new Error("Gitea endpoint, repository, branch, and API token are required");
  }
  const parsed = new URL(endpoint);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Gitea endpoint must use http or https");
  }
  return { endpoint, owner, repo, branch, token };
}

function apiBase(endpoint: string): string {
  const trimmed = endpoint.replace(/\/+$/, "");
  return trimmed.toLowerCase().endsWith("/api/v1") ? trimmed : `${trimmed}/api/v1`;
}

function authHeaders(token: string): Record<string, string> {
  return { Accept: "application/json", Authorization: `token ${token}` };
}

function parsePullRequests(value: unknown): { number: number }[] {
  if (!Array.isArray(value)) {
    throw new Error("Gitea pull-request list returned a non-array payload");
  }
  return value.map((pullRequest, index) => {
    if (
      typeof pullRequest !== "object" ||
      pullRequest === null ||
      typeof (pullRequest as { number?: unknown }).number !== "number" ||
      !Number.isInteger((pullRequest as { number: number }).number) ||
      (pullRequest as { number: number }).number < 1
    ) {
      throw new Error(`Gitea pull-request list item ${index} has no valid number`);
    }
    return { number: (pullRequest as { number: number }).number };
  });
}

async function responseDetail(response: Response): Promise<string> {
  const body = (await response.text()).trim();
  return body === "" ? `HTTP ${response.status}` : `HTTP ${response.status}: ${body}`;
}

function parseArgs(args: string[]): ParsedArgs {
  const parsed: ParsedArgs = {
    endpoint: null,
    owner: null,
    repo: null,
    branch: null,
    help: false,
    invalid: [],
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] as string;
    if (arg === "--help" || arg === "-h") {
      parsed.help = true;
      continue;
    }
    const equals = arg.indexOf("=");
    const name = arg.startsWith("--") ? (equals === -1 ? arg.slice(2) : arg.slice(2, equals)) : arg;
    const inlineValue = equals === -1 ? null : arg.slice(equals + 1);
    if (name === "endpoint" || name === "owner" || name === "repo" || name === "branch") {
      const value = inlineValue ?? args[++index] ?? "";
      parsed[name] = value;
    } else {
      parsed.invalid.push(arg);
    }
  }
  return parsed;
}

function currentBranch(): string | null {
  const processResult = Bun.spawnSync(["git", "branch", "--show-current"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (processResult.exitCode !== 0) {
    return null;
  }
  const branch = processResult.stdout.toString().trim();
  return branch === "" ? null : branch;
}

if (import.meta.main) {
  main().then((code) => process.exit(code));
}
