import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { type Shell, run } from "../../src/tasks/pr-body-check.ts";

// Translated from pr_body_check_test.exs. The temp-repo chdir + fixtures carry
// over; Mix.shell() IO capture becomes a recording Shell.

const TEMPLATE = `#### Context

<!-- Why is this change needed? -->

#### TL;DR

*<!-- A short summary -->*

#### Summary

- <!-- Summary bullet -->

#### Alternatives

- <!-- Alternative bullet -->

#### Test Plan

- [ ] <!-- Test checkbox -->
`;

const VALID_BODY = `#### Context

Context text.

#### TL;DR

Short summary.

#### Summary

- First change.

#### Alternatives

- Alternative considered.

#### Test Plan

- [x] Ran targeted checks.
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

describe("pr_body.check", () => {
  let root: string;
  let originalCwd: string;

  beforeEach(() => {
    originalCwd = process.cwd();
    root = fs.mkdtempSync(path.join(os.tmpdir(), "pr-body-check-"));
    process.chdir(root);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    fs.rmSync(root, { recursive: true, force: true });
  });

  function writeTemplate(content: string): void {
    fs.mkdirSync(".github", { recursive: true });
    fs.writeFileSync(".github/pull_request_template.md", content);
  }

  test("prints help", () => {
    const shell = recordingShell();
    run(["--help"], shell);
    expect(shell.out.join("\n")).toContain("mix pr_body.check --file /path/to/pr_body.md");
  });

  test("fails on invalid options", () => {
    expect(() => run(["lint", "--wat"], recordingShell())).toThrow(/Invalid option/);
  });

  test("fails when file option is missing", () => {
    expect(() => run(["lint"], recordingShell())).toThrow(/Missing required option --file/);
  });

  test("fails when template is missing", () => {
    fs.writeFileSync("body.md", VALID_BODY);
    expect(() => run(["lint", "--file", "body.md"], recordingShell())).toThrow(
      /Unable to read PR template/,
    );
  });

  test("fails when template has no headings", () => {
    writeTemplate("no headings here");
    fs.writeFileSync("body.md", VALID_BODY);
    expect(() => run(["lint", "--file", "body.md"], recordingShell())).toThrow(
      /No markdown headings found/,
    );
  });

  test("fails when body file is missing", () => {
    writeTemplate(TEMPLATE);
    expect(() => run(["lint", "--file", "missing.md"], recordingShell())).toThrow(
      /Unable to read missing\.md/,
    );
  });

  function expectInvalid(body: string): Shell & { out: string[]; err: string[] } {
    writeTemplate(TEMPLATE);
    fs.writeFileSync("body.md", body);
    const shell = recordingShell();
    expect(() => run(["lint", "--file", "body.md"], shell)).toThrow(/PR body format invalid/);
    return shell;
  }

  test("fails when body still has placeholders", () => {
    const shell = expectInvalid(TEMPLATE);
    expect(shell.err.join("\n")).toContain(
      "PR description still contains template placeholder comments",
    );
  });

  test("fails when heading is missing", () => {
    const missing = VALID_BODY.replace("#### Alternatives\n\n- Alternative considered.\n\n", "");
    const shell = expectInvalid(missing);
    expect(shell.err.join("\n")).toContain("Missing required heading: #### Alternatives");
  });

  test("fails when headings are out of order", () => {
    const outOfOrder = `#### TL;DR

Short summary.

#### Context

Context text.

#### Summary

- First change.

#### Alternatives

- Alternative considered.

#### Test Plan

- [x] Ran targeted checks.
`;
    const shell = expectInvalid(outOfOrder);
    expect(shell.err.join("\n")).toContain("Required headings are out of order.");
  });

  test("fails on empty section", () => {
    const shell = expectInvalid(VALID_BODY.replace("Context text.", ""));
    expect(shell.err.join("\n")).toContain("Section cannot be empty: #### Context");
  });

  test("fails when a middle section is blank before the next heading", () => {
    const blank = `#### Context

Context text.

#### TL;DR

Short summary.

#### Summary

- First change.

#### Alternatives


#### Test Plan

- [x] Ran targeted checks.
`;
    const shell = expectInvalid(blank);
    expect(shell.err.join("\n")).toContain("Section cannot be empty: #### Alternatives");
  });

  test("fails when bullet and checkbox expectations are not met", () => {
    const invalid = `#### Context

Context text.

#### TL;DR

Short summary.

#### Summary

Not a bullet.

#### Alternatives

Also not a bullet.

#### Test Plan

No checkbox.
`;
    const shell = expectInvalid(invalid);
    const errText = shell.err.join("\n");
    expect(errText).toContain("Section must include at least one bullet item: #### Summary");
    expect(errText).toContain("Section must include at least one bullet item: #### Alternatives");
    expect(errText).toContain("Section must include at least one bullet item: #### Test Plan");
    expect(errText).toContain("Section must include at least one checkbox item: #### Test Plan");
  });

  test("fails when heading appears at end of file", () => {
    const shell = expectInvalid("#### Context");
    expect(shell.err.join("\n")).toContain("Section cannot be empty: #### Context");
  });

  test("passes for a valid body", () => {
    writeTemplate(TEMPLATE);
    fs.writeFileSync("body.md", VALID_BODY);
    const shell = recordingShell();
    run(["lint", "--file", "body.md"], shell);
    expect(shell.out.join("\n")).toContain("PR body format OK");
  });
});
