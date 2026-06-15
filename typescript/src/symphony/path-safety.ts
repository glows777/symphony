// Literal port of `symphony_elixir/path_safety.ex`.
//
// Canonicalizes a filesystem path by resolving every symlink in the *existing*
// prefix of the path one segment at a time. Once a component does not exist the
// remaining segments are appended verbatim (mirroring Elixir's `:enoent`
// branch). Other stat errors (e.g. `:enametoolong`, `:enotdir`) surface as a
// `path_canonicalize_failed` error carrying the expanded path and POSIX reason.

import fs from "node:fs";
import path from "node:path";
import { type Result, err, ok } from "./result.ts";

export type PathCanonicalizeFailed = {
  tag: "path_canonicalize_failed";
  expandedPath: string;
  reason: string;
};

export function canonicalize(p: string): Result<string, PathCanonicalizeFailed> {
  // `Path.expand/1`: make absolute relative to cwd and normalize `.`/`..`.
  const expandedPath = path.resolve(p);
  const { root, segments } = splitAbsolutePath(expandedPath);

  const result = resolveSegments(root, [], segments);
  if (result.ok) {
    return ok(result.value);
  }
  return err({ tag: "path_canonicalize_failed", expandedPath, reason: result.error });
}

function splitAbsolutePath(p: string): { root: string; segments: string[] } {
  // `Path.split/1` on POSIX returns `["/", ...segments]`.
  const segments = p.split(path.sep).filter((segment) => segment.length > 0);
  return { root: path.sep, segments };
}

function joinPath(root: string, segments: string[]): string {
  return segments.reduce((acc, segment) => path.join(acc, segment), root);
}

function resolveSegments(
  root: string,
  resolved: string[],
  remaining: string[],
): Result<string, string> {
  const [segment, ...rest] = remaining;
  if (segment === undefined) {
    return ok(joinPath(root, resolved));
  }

  const candidate = joinPath(root, [...resolved, segment]);

  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(candidate);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      // Component does not exist: append the remainder untouched.
      return ok(joinPath(root, [...resolved, segment, ...rest]));
    }
    return err(posixReason(code));
  }

  if (stat.isSymbolicLink()) {
    let target: string;
    try {
      target = fs.readlinkSync(candidate);
    } catch (error) {
      return err(posixReason((error as NodeJS.ErrnoException).code));
    }
    // `Path.expand(target, parent_of_symlink)` — absolute targets ignore the base.
    const resolvedTarget = path.resolve(joinPath(root, resolved), target);
    const { root: targetRoot, segments: targetSegments } = splitAbsolutePath(resolvedTarget);
    return resolveSegments(targetRoot, [], [...targetSegments, ...rest]);
  }

  return resolveSegments(root, [...resolved, segment], rest);
}

function posixReason(code: string | undefined): string {
  // Elixir File errors are lowercased POSIX atoms (ENAMETOOLONG -> :enametoolong).
  return code ? code.toLowerCase() : "unknown";
}
