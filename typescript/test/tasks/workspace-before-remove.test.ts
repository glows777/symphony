import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { type Shell, run } from "../../src/tasks/workspace-before-remove.ts";

// Translated from workspace_before_remove_test.exs. The fake gh/git binaries on
// PATH + GH_LOG carry over directly; Mix.shell() IO capture becomes a recording
// Shell.

const GH_SCRIPT = `#!/bin/sh
printf '%s\\n' "$*" >> "$GH_LOG"

if [ "$1" = "auth" ] && [ "$2" = "status" ]; then
  exit 0
fi

if [ "$1" = "pr" ] && [ "$2" = "list" ]; then
  printf '101\\n102\\n'
  exit 0
fi

if [ "$1" = "pr" ] && [ "$2" = "close" ] && [ "$3" = "101" ]; then
  exit 0
fi

if [ "$1" = "pr" ] && [ "$2" = "close" ] && [ "$3" = "102" ]; then
  printf 'boom\\n' >&2
  exit 17
fi

exit 99
`;

function recordingShell(): Shell & { out: string[]; err: string[] } {
  const shell = {
    out: [] as string[],
    err: [] as string[],
    info(message: string) {
      shell.out.push(message);
    },
    error(message: string) {
      shell.err.push(message);
    },
  };
  return shell;
}

describe("workspace.before_remove", () => {
  let root: string;
  let savedPath: string | undefined;
  let savedGhLog: string | undefined;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "wbr-task-"));
    savedPath = process.env.PATH;
    savedGhLog = process.env.GH_LOG;
  });

  afterEach(() => {
    if (savedPath === undefined) {
      Reflect.deleteProperty(process.env, "PATH");
    } else {
      process.env.PATH = savedPath;
    }
    if (savedGhLog === undefined) {
      Reflect.deleteProperty(process.env, "GH_LOG");
    } else {
      process.env.GH_LOG = savedGhLog;
    }
    fs.rmSync(root, { recursive: true, force: true });
  });

  function withFakeBinaries(scripts: Record<string, string>): string {
    const binDir = path.join(root, "bin");
    fs.mkdirSync(binDir, { recursive: true });
    const logPath = path.join(root, "gh.log");
    fs.writeFileSync(logPath, "");
    for (const [name, script] of Object.entries(scripts)) {
      const file = path.join(binDir, name);
      fs.writeFileSync(file, script);
      fs.chmodSync(file, 0o755);
    }
    process.env.PATH = `${binDir}:${savedPath ?? ""}`;
    process.env.GH_LOG = logPath;
    return logPath;
  }

  test("prints help", () => {
    const shell = recordingShell();
    run(["--help"], shell);
    expect(shell.out.join("\n")).toContain("mix workspace.before_remove");
  });

  test("fails on invalid options", () => {
    expect(() => run(["--wat"], recordingShell())).toThrow(/Invalid option/);
  });

  test("no-ops when gh is unavailable", () => {
    process.env.PATH = "";
    const shell = recordingShell();
    run(["--branch", "feature/no-gh"], shell);
    expect(shell.out).toEqual([]);
    expect(shell.err).toEqual([]);
  });

  test("closes open pull requests and tolerates close failures", () => {
    const logPath = withFakeBinaries({ gh: GH_SCRIPT });
    const shell = recordingShell();
    run(["--branch", "feature/workpad"], shell);

    expect(shell.out.join("\n")).toContain("Closed PR #101 for branch feature/workpad");
    expect(shell.err.join("\n")).toContain("Failed to close PR #102 for branch feature/workpad");

    const log = fs.readFileSync(logPath, "utf8");
    expect(log).toContain("auth status");
    expect(log).toContain(
      "pr list --repo openai/symphony --head feature/workpad --state open --json number --jq .[].number",
    );
    expect(log).toContain("pr close 101 --repo openai/symphony");
    expect(log).toContain("pr close 102 --repo openai/symphony");
  });

  test("uses current branch for lookup when branch option is omitted", () => {
    const logPath = withFakeBinaries({
      gh: GH_SCRIPT,
      git: "#!/bin/sh\nprintf 'feature/workpad\\n'\nexit 0\n",
    });
    const shell = recordingShell();
    run([], shell);

    expect(shell.out.join("\n")).toContain("Closed PR #101 for branch feature/workpad");
    expect(shell.err.join("\n")).toContain("Failed to close PR #102 for branch feature/workpad");
    expect(fs.readFileSync(logPath, "utf8")).toContain(
      "pr list --repo openai/symphony --head feature/workpad",
    );
  });

  test("formats close failures without command stderr output", () => {
    const logPath = withFakeBinaries({
      gh: `#!/bin/sh
printf '%s\\n' "$*" >> "$GH_LOG"
if [ "$1" = "auth" ] && [ "$2" = "status" ]; then exit 0; fi
if [ "$1" = "pr" ] && [ "$2" = "list" ]; then printf '102\\n'; exit 0; fi
if [ "$1" = "pr" ] && [ "$2" = "close" ] && [ "$3" = "102" ]; then exit 17; fi
exit 99
`,
    });
    const shell = recordingShell();
    run(["--branch", "feature/no-output"], shell);

    const errText = shell.err.join("\n");
    expect(errText).toContain("Failed to close PR #102 for branch feature/no-output: exit 17");
    expect(errText).not.toContain("output=");
    expect(fs.readFileSync(logPath, "utf8")).toContain("pr close 102 --repo openai/symphony");
  });

  test("no-ops when PR list fails", () => {
    const logPath = withFakeBinaries({
      gh: `#!/bin/sh
printf '%s\\n' "$*" >> "$GH_LOG"
if [ "$1" = "auth" ] && [ "$2" = "status" ]; then exit 0; fi
if [ "$1" = "pr" ] && [ "$2" = "list" ]; then exit 1; fi
exit 99
`,
    });
    const shell = recordingShell();
    run(["--branch", "feature/list-fails"], shell);

    expect(shell.out).toEqual([]);
    expect(shell.err).toEqual([]);
    const log = fs.readFileSync(logPath, "utf8");
    expect(log).toContain("auth status");
    expect(log).not.toContain("pr close");
  });

  test("no-ops when git current branch is blank", () => {
    const logPath = withFakeBinaries({
      gh: '#!/bin/sh\nprintf \'%s\\n\' "$*" >> "$GH_LOG"\nexit 99\n',
      git: "#!/bin/sh\nprintf '\\n'\nexit 0\n",
    });
    const shell = recordingShell();
    run([], shell);

    expect(shell.out).toEqual([]);
    expect(fs.readFileSync(logPath, "utf8")).toBe("");
  });

  test("no-ops when gh auth is unavailable", () => {
    const logPath = withFakeBinaries({
      gh: `#!/bin/sh
printf '%s\\n' "$*" >> "$GH_LOG"
if [ "$1" = "auth" ] && [ "$2" = "status" ]; then exit 1; fi
exit 99
`,
    });
    run(["--branch", "feature/no-auth"], recordingShell());

    const log = fs.readFileSync(logPath, "utf8");
    expect(log).toContain("auth status");
    expect(log).not.toContain("pr list");
  });
});
