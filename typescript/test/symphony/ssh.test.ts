import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { remoteShellCommand, run, startPort } from "../../src/symphony/ssh.ts";

// Translated from ssh_test.exs.
describe("SSH", () => {
  let testRoot: string;
  let traceFile: string;
  let savedPath: string | undefined;
  let savedSshConfig: string | undefined;

  beforeEach(() => {
    testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "symphony-ssh-"));
    traceFile = path.join(testRoot, "ssh.trace");
    savedPath = process.env.PATH;
    savedSshConfig = process.env.SYMPHONY_SSH_CONFIG;
  });

  afterEach(() => {
    restoreEnv("PATH", savedPath);
    restoreEnv("SYMPHONY_SSH_CONFIG", savedSshConfig);
    fs.rmSync(testRoot, { recursive: true, force: true });
  });

  function installFakeSsh(script?: string): void {
    const binDir = path.join(testRoot, "bin");
    fs.mkdirSync(binDir, { recursive: true });
    const fakeSsh = path.join(binDir, "ssh");
    fs.writeFileSync(
      fakeSsh,
      script ?? `#!/bin/sh\nprintf 'ARGV:%s\\n' "$*" >> "${traceFile}"\nexit 0\n`,
    );
    fs.chmodSync(fakeSsh, 0o755);
    process.env.PATH = `${binDir}:${process.env.PATH ?? ""}`;
  }

  function waitForTrace(): void {
    for (let i = 0; i < 40; i++) {
      if (fs.existsSync(traceFile) && fs.readFileSync(traceFile, "utf8") !== "") {
        return;
      }
      Bun.sleepSync(25);
    }
    throw new Error("timed out waiting for fake ssh trace");
  }

  test("run keeps bracketed IPv6 host:port targets intact", () => {
    installFakeSsh();
    expect(run("root@[::1]:2200", "printf ok", { stderrToStdout: true })).toEqual(ok(["", 0]));

    const trace = fs.readFileSync(traceFile, "utf8");
    expect(trace).toContain("-T -p 2200 root@[::1] bash -lc");
    expect(trace).toContain("printf ok");
  });

  test("run leaves unbracketed IPv6-style targets unchanged", () => {
    installFakeSsh();
    expect(run("::1:2200", "printf ok", { stderrToStdout: true })).toEqual(ok(["", 0]));

    const trace = fs.readFileSync(traceFile, "utf8");
    expect(trace).toContain("-T ::1:2200 bash -lc");
    expect(trace).not.toContain("-p 2200");
  });

  test("run passes host:port targets through ssh -p with config", () => {
    installFakeSsh();
    process.env.SYMPHONY_SSH_CONFIG = "/tmp/symphony-test-ssh-config";

    expect(run("localhost:2222", "echo ready", { stderrToStdout: true })).toEqual(ok(["", 0]));

    const trace = fs.readFileSync(traceFile, "utf8");
    expect(trace).toContain("-F /tmp/symphony-test-ssh-config");
    expect(trace).toContain("-T -p 2222 localhost bash -lc");
    expect(trace).toContain("echo ready");
  });

  test("run keeps the user prefix when parsing user@host:port targets", () => {
    installFakeSsh();
    expect(run("root@127.0.0.1:2200", "printf ok", { stderrToStdout: true })).toEqual(ok(["", 0]));

    const trace = fs.readFileSync(traceFile, "utf8");
    expect(trace).toContain("-T -p 2200 root@127.0.0.1 bash -lc");
    expect(trace).toContain("printf ok");
  });

  test("run returns an error when ssh is unavailable", () => {
    fs.mkdirSync(testRoot, { recursive: true });
    process.env.PATH = testRoot;
    expect(run("localhost", "printf ok")).toEqual(err({ tag: "ssh_not_found" }));
  });

  test("start_port supports binary output without line mode", () => {
    installFakeSsh(
      `#!/bin/sh\nprintf 'ARGV:%s\\n' "$*" >> "${traceFile}"\nprintf 'ready\\n'\nexit 0\n`,
    );
    Reflect.deleteProperty(process.env, "SYMPHONY_SSH_CONFIG");

    const result = startPort("localhost", "printf ok");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(typeof result.value.pid).toBe("number");
    }
    waitForTrace();

    const trace = fs.readFileSync(traceFile, "utf8");
    expect(trace).toContain("-T localhost bash -lc");
    expect(trace).not.toContain(" -F ");
  });

  test("start_port supports line mode", () => {
    installFakeSsh(
      `#!/bin/sh\nprintf 'ARGV:%s\\n' "$*" >> "${traceFile}"\nprintf 'ready\\n'\nexit 0\n`,
    );

    const result = startPort("localhost:2222", "printf ok", { line: 256 });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(typeof result.value.pid).toBe("number");
    }
    waitForTrace();

    const trace = fs.readFileSync(traceFile, "utf8");
    expect(trace).toContain("-T -p 2222 localhost bash -lc");
  });

  test("remote_shell_command escapes embedded single quotes", () => {
    expect(remoteShellCommand("printf 'hello'")).toBe(`bash -lc 'printf '"'"'hello'"'"''`);
  });
});

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    Reflect.deleteProperty(process.env, key);
  } else {
    process.env[key] = value;
  }
}

function ok<T>(value: T): { ok: true; value: T } {
  return { ok: true, value };
}

function err<E>(error: E): { ok: false; error: E } {
  return { ok: false, error };
}
