// Literal port of `mix/tasks/pr_body.check.ex`.
//
// Validates a PR description markdown file against the repository PR template:
// required headings, ordering, no leftover placeholder comments, non-empty
// sections, and template-implied bullet/checkbox requirements. `Mix.shell()` →
// an injected Shell; `Mix.raise` → a thrown Error.

import fs from "node:fs";

const TEMPLATE_PATHS = [".github/pull_request_template.md", "../.github/pull_request_template.md"];

const HELP_TEXT = `Validates a PR description markdown file against the structure and expectations
implied by the repository pull request template.

Usage:

    mix pr_body.check --file /path/to/pr_body.md
`;

export type Shell = {
  info(message: string): void;
  error(message: string): void;
};

const defaultShell: Shell = {
  info: (message) => process.stdout.write(`${message}\n`),
  error: (message) => process.stderr.write(`${message}\n`),
};

// Port of `run/1`. Throws (≈ `Mix.raise`) on any validation failure.
export function run(args: string[], shell: Shell = defaultShell): void {
  const parsed = parseArgs(args);
  if (parsed.help) {
    shell.info(HELP_TEXT);
    return;
  }
  if (parsed.invalid.length > 0) {
    throw new Error(`Invalid option(s): ${JSON.stringify(parsed.invalid)}`);
  }
  const filePath = requiredOpt(parsed.file, "file");

  const template = readTemplate();
  const body = readFile(filePath);
  const headings = extractTemplateHeadings(template.content, template.path);

  const errors = lint(template.content, body, headings);
  if (errors.length === 0) {
    shell.info("PR body format OK");
    return;
  }
  for (const err of errors) {
    shell.error(`ERROR: ${err}`);
  }
  throw new Error(`PR body format invalid. Read \`${template.path}\` and follow it precisely.`);
}

function requiredOpt(value: string | null, key: string): string {
  if (value === null) {
    throw new Error(`Missing required option --${key}`);
  }
  return value;
}

function readTemplate(): { path: string; content: string } {
  for (const path of TEMPLATE_PATHS) {
    const content = tryReadFile(path);
    if (content !== null) {
      return { path, content };
    }
  }
  throw new Error(`Unable to read PR template from any of: ${TEMPLATE_PATHS.join(", ")}`);
}

function readFile(path: string): string {
  const content = tryReadFile(path);
  if (content === null) {
    throw new Error(`Unable to read ${path}: enoent`);
  }
  return content;
}

function tryReadFile(path: string): string | null {
  try {
    return fs.readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

function extractTemplateHeadings(template: string, templatePath: string): string[] {
  const headings = template.match(/^#{4,6}\s+.+$/gm) ?? [];
  if (headings.length === 0) {
    throw new Error(`No markdown headings found in ${templatePath}`);
  }
  return headings;
}

// ---- linting ---------------------------------------------------------------

function lint(template: string, body: string, headings: string[]): string[] {
  const errors: string[] = [];
  checkRequiredHeadings(errors, body, headings);
  checkOrder(errors, body, headings);
  checkNoPlaceholders(errors, body);
  checkSectionsFromTemplate(errors, template, body, headings);
  return errors;
}

function checkRequiredHeadings(errors: string[], body: string, headings: string[]): void {
  for (const heading of headings) {
    if (headingPosition(body, heading) === null) {
      errors.push(`Missing required heading: ${heading}`);
    }
  }
}

function checkOrder(errors: string[], body: string, headings: string[]): void {
  const positions = headings
    .map((heading) => headingPosition(body, heading))
    .filter((pos): pos is number => pos !== null);
  const sorted = [...positions].sort((a, b) => a - b);
  if (!positions.every((pos, i) => pos === sorted[i])) {
    errors.push("Required headings are out of order.");
  }
}

function checkNoPlaceholders(errors: string[], body: string): void {
  if (body.includes("<!--")) {
    errors.push("PR description still contains template placeholder comments (<!-- ... -->).");
  }
}

function checkSectionsFromTemplate(
  errors: string[],
  template: string,
  body: string,
  headings: string[],
): void {
  for (const heading of headings) {
    const templateSection = captureHeadingSection(template, heading, headings);
    const bodySection = captureHeadingSection(body, heading, headings);

    if (bodySection === null) {
      continue;
    }
    if (bodySection.trim() === "") {
      errors.push(`Section cannot be empty: ${heading}`);
      continue;
    }
    maybeRequireBullets(errors, heading, templateSection, bodySection);
    maybeRequireCheckboxes(errors, heading, templateSection, bodySection);
  }
}

function maybeRequireBullets(
  errors: string[],
  heading: string,
  templateSection: string | null,
  bodySection: string,
): void {
  const requiresBullets = /^- /m.test(templateSection ?? "");
  if (requiresBullets && !/^- /m.test(bodySection)) {
    errors.push(`Section must include at least one bullet item: ${heading}`);
  }
}

function maybeRequireCheckboxes(
  errors: string[],
  heading: string,
  templateSection: string | null,
  bodySection: string,
): void {
  const requiresCheckboxes = /^- \[ \] /m.test(templateSection ?? "");
  if (requiresCheckboxes && !/^- \[[ xX]\] /m.test(bodySection)) {
    errors.push(`Section must include at least one checkbox item: ${heading}`);
  }
}

// ---- section extraction ----------------------------------------------------

function headingPosition(body: string, heading: string): number | null {
  const idx = body.indexOf(heading);
  return idx === -1 ? null : idx;
}

function captureHeadingSection(doc: string, heading: string, headings: string[]): string | null {
  const headingIdx = doc.indexOf(heading);
  if (headingIdx === -1) {
    return null;
  }
  const sectionStart = headingIdx + heading.length;
  if (sectionStart + 2 > doc.length) {
    return "";
  }
  if (doc.slice(sectionStart, sectionStart + 2) !== "\n\n") {
    return null;
  }
  return extractSectionContent(doc, sectionStart + 2, heading, headings);
}

function extractSectionContent(
  doc: string,
  contentStart: number,
  heading: string,
  headings: string[],
): string {
  const content = doc.slice(contentStart);
  const offset = nextHeadingOffset(content, heading, headings);
  return offset === null ? content : content.slice(0, offset);
}

function nextHeadingOffset(content: string, heading: string, headings: string[]): number | null {
  const indexes = headingsAfter(heading, headings)
    .map((marker) => content.indexOf(marker))
    .filter((idx) => idx !== -1);
  return indexes.length === 0 ? null : Math.min(...indexes);
}

function headingsAfter(currentHeading: string, headings: string[]): string[] {
  return headings.filter((heading) => heading !== currentHeading).map((heading) => `\n${heading}`);
}

// ---- option parsing --------------------------------------------------------

type ParsedArgs = { file: string | null; help: boolean; invalid: string[] };

function parseArgs(args: string[]): ParsedArgs {
  const parsed: ParsedArgs = { file: null, help: false, invalid: [] };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string;
    if (arg === "--help" || arg === "-h") {
      parsed.help = true;
      continue;
    }
    if (!arg.startsWith("--")) {
      // Positional argument (e.g. "lint"); OptionParser leaves it in argv.
      continue;
    }
    const eq = arg.indexOf("=");
    const name = eq === -1 ? arg.slice(2) : arg.slice(2, eq);
    const inlineValue = eq === -1 ? null : arg.slice(eq + 1);
    if (name === "file") {
      parsed.file = inlineValue ?? args[++i] ?? "";
    } else {
      parsed.invalid.push(arg);
    }
  }
  return parsed;
}
