#!/usr/bin/env bun
// One-command, self-contained verification for the TypeScript Symphony.
//
// Runs `bun run check`, then boots the real app (src/cli.ts) as a child process
// against the self-contained smoke workflow (in-memory tracker + the repo's fake
// codex), and asserts the observability API, a real dispatch (workspace
// creation), and a clean SIGTERM shutdown. No Elixir, no Codex account, no
// Linear key, no network. Exits non-zero on any failure.

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ACK_FLAG = "--i-understand-that-this-will-be-running-without-the-usual-guardrails";
const REPO = path.resolve(import.meta.dir, "..");
const CLI = path.join(REPO, "src", "cli.ts");
const SMOKE_WORKFLOW = path.join(REPO, "examples", "smoke.workflow.md");
const FAKE_CODEX = path.join(REPO, "test", "harness", "fake-codex.ts");
const SEEDED_IDENTIFIER = "SMOKE-1";
const BOOT_TIMEOUT_MS = 30_000;
const DISPATCH_TIMEOUT_MS = 15_000;
const SHUTDOWN_TIMEOUT_MS = 10_000;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function log(message: string): void {
  process.stdout.write(`[verify] ${message}\n`);
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

// Step (a): run the quality gate.
async function runCheck(): Promise<void> {
  log("running `bun run check` ...");
  const code = await new Promise<number>((resolve) => {
    const child = spawn("bun", ["run", "check"], { cwd: REPO, stdio: "inherit" });
    child.on("exit", (exitCode) => resolve(exitCode ?? 1));
    child.on("error", () => resolve(1));
  });
  assert(code === 0, `\`bun run check\` failed with exit code ${code}`);
  log("check passed");
}

// Picks a free TCP port by binding an ephemeral listener and releasing it.
async function freePort(): Promise<number> {
  const probe = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("ok") });
  const port = probe.port;
  probe.stop(true);
  return port;
}

type Child = {
  proc: ReturnType<typeof spawn>;
  output: () => string;
  exited: Promise<number>;
};

// Step (b): boot the real app via the CLI as a child process.
function bootApp(port: number, workspaceRoot: string, logsRoot: string): Child {
  const proc = spawn(
    "bun",
    ["run", CLI, ACK_FLAG, "--port", String(port), "--logs-root", logsRoot, SMOKE_WORKFLOW],
    {
      cwd: REPO,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        SYMPHONY_SMOKE_WORKSPACE_ROOT: workspaceRoot,
        SYMPHONY_SMOKE_FAKE_CODEX: FAKE_CODEX,
      },
    },
  );

  let buffer = "";
  proc.stdout?.on("data", (chunk) => {
    buffer += chunk.toString();
  });
  proc.stderr?.on("data", (chunk) => {
    buffer += chunk.toString();
  });

  const exited = new Promise<number>((resolve) => {
    proc.on("exit", (code, signal) => resolve(code ?? (signal ? 0 : 1)));
  });

  return { proc, output: () => buffer, exited };
}

async function pollState(base: string): Promise<Record<string, unknown>> {
  const deadline = Date.now() + BOOT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${base}/api/v1/state`);
      if (res.status === 200) {
        return (await res.json()) as Record<string, unknown>;
      }
    } catch {
      // Server not up yet; keep polling.
    }
    await sleep(150);
  }
  throw new Error(
    `timed out waiting for GET /api/v1/state to return 200 within ${BOOT_TIMEOUT_MS}ms`,
  );
}

// Step (c): assert the observability API shape and status codes.
function assertStateShape(state: Record<string, unknown>): void {
  assert(typeof state.generated_at === "string", "state.generated_at must be a string");
  const counts = state.counts as Record<string, unknown> | undefined;
  assert(counts !== undefined && typeof counts === "object", "state.counts must be an object");
  for (const key of ["running", "retrying", "blocked"]) {
    assert(typeof counts[key] === "number", `state.counts.${key} must be a number`);
    assert(Array.isArray(state[key]), `state.${key} must be an array`);
  }
  assert("codex_totals" in state, "state.codex_totals must be present");
  assert("rate_limits" in state, "state.rate_limits must be present");
  log("GET /api/v1/state -> 200 with a well-formed snapshot");
}

async function assertRefresh(base: string): Promise<void> {
  const res = await fetch(`${base}/api/v1/refresh`, { method: "POST" });
  assert(res.status === 202, `POST /api/v1/refresh expected 202, got ${res.status}`);
  const body = (await res.json()) as Record<string, unknown>;
  assert(body.queued === true, "refresh response should have queued: true");
  log("POST /api/v1/refresh -> 202");
}

async function assertIssueNotFound(base: string): Promise<void> {
  const res = await fetch(`${base}/api/v1/DOES-NOT-EXIST`);
  assert(res.status === 404, `GET unknown issue expected 404, got ${res.status}`);
  log("GET /api/v1/DOES-NOT-EXIST -> 404");
}

// Step (d): confirm a workspace dir was created for the dispatched issue.
async function awaitWorkspace(workspaceRoot: string): Promise<void> {
  const expected = path.join(workspaceRoot, SEEDED_IDENTIFIER);
  const deadline = Date.now() + DISPATCH_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (fs.existsSync(expected)) {
      log(`workspace created for dispatched issue: ${expected}`);
      return;
    }
    await sleep(150);
  }
  throw new Error(
    `timed out waiting for workspace dir ${expected} within ${DISPATCH_TIMEOUT_MS}ms`,
  );
}

// Step (e): SIGTERM and assert a clean exit 0.
async function assertCleanShutdown(child: Child): Promise<void> {
  child.proc.kill("SIGTERM");
  const code = await Promise.race([
    child.exited,
    sleep(SHUTDOWN_TIMEOUT_MS).then(() => "timeout" as const),
  ]);
  assert(code !== "timeout", `app did not exit within ${SHUTDOWN_TIMEOUT_MS}ms of SIGTERM`);
  assert(code === 0, `app exited with code ${code} after SIGTERM (expected 0)`);
  log("SIGTERM -> exit 0 (clean shutdown)");
}

async function main(): Promise<number> {
  await runCheck();

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "symphony-verify-"));
  const workspaceRoot = path.join(tmp, "workspaces");
  const logsRoot = path.join(tmp, "logs");
  fs.mkdirSync(workspaceRoot, { recursive: true });
  fs.mkdirSync(logsRoot, { recursive: true });

  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  log(`booting app on ${base} (workspaces=${workspaceRoot})`);
  const child = bootApp(port, workspaceRoot, logsRoot);

  let shutdownDone = false;
  try {
    const state = await pollState(base);
    assertStateShape(state);
    await assertRefresh(base);
    await assertIssueNotFound(base);
    await awaitWorkspace(workspaceRoot);
    await assertCleanShutdown(child);
    shutdownDone = true;
  } catch (error) {
    process.stderr.write(`\n[verify] child process output:\n${child.output()}\n`);
    throw error;
  } finally {
    if (!shutdownDone && child.proc.exitCode === null) {
      child.proc.kill("SIGKILL");
    }
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  return 0;
}

main()
  .then(() => {
    process.stdout.write("\nPASS: Symphony verification succeeded.\n");
    process.exit(0);
  })
  .catch((error) => {
    process.stderr.write(`\nFAIL: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
