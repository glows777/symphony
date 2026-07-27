// Shared workspace-path safety guard. The canonicalize + root-prefix +
// symlink-escape + remote-character checks used to be duplicated in
// codex/app-server.ts (validateWorkspaceCwd) and workspace.ts
// (validateWorkspacePath) with different error tags. This is the single
// semantic core: it returns ok(canonical) or a tagged violation category, and
// each call site maps the violation to its own historical error shape (both the
// `invalid_workspace_cwd` family and the `workspace_*` family have tests and log
// consumers, so neither may be renamed or merged).
//
// Pure and config-free (the caller passes `root`, keeping this a leaf module
// outside the config <-> plugins ESM cycle); the claude-code backend's
// startSession guards its workspace through the same core (SPEC §17).

import nodePath from "node:path";
import { canonicalize } from "./path-safety.ts";
import { type Result, err, ok } from "./result.ts";

// Semantic violation categories. Field names carry exactly the material each
// call site needs to rebuild its own error object.
export type WorkspaceGuardViolation =
  | { kind: "path_unreadable"; path: string; reason: string }
  | { kind: "equals_root"; canonicalWorkspace: string; canonicalRoot: string }
  | { kind: "symlink_escape"; expandedWorkspace: string; canonicalRoot: string }
  | { kind: "outside_root"; canonicalWorkspace: string; canonicalRoot: string }
  | { kind: "empty_remote"; workspace: string }
  | { kind: "invalid_remote_characters"; workspace: string };

// ok-value: the canonical local path, or (remote) the workspace string verbatim.
export function guardWorkspacePath(
  workspace: string,
  root: string,
  workerHost: string | null,
): Result<string, WorkspaceGuardViolation> {
  if (workerHost === null) {
    // `Path.expand/1`: absolute + normalized relative to cwd.
    const expandedWorkspace = nodePath.resolve(workspace);
    const expandedRoot = nodePath.resolve(root);
    const expandedRootPrefix = `${expandedRoot}/`;

    const canonicalWorkspace = canonicalize(expandedWorkspace);
    const canonicalRoot = canonicalize(expandedRoot);
    if (!canonicalWorkspace.ok) {
      const e = canonicalWorkspace.error;
      return err({ kind: "path_unreadable", path: e.expandedPath, reason: e.reason });
    }
    if (!canonicalRoot.ok) {
      const e = canonicalRoot.error;
      return err({ kind: "path_unreadable", path: e.expandedPath, reason: e.reason });
    }
    const canonicalRootPrefix = `${canonicalRoot.value}/`;

    if (canonicalWorkspace.value === canonicalRoot.value) {
      return err({
        kind: "equals_root",
        canonicalWorkspace: canonicalWorkspace.value,
        canonicalRoot: canonicalRoot.value,
      });
    }
    if (`${canonicalWorkspace.value}/`.startsWith(canonicalRootPrefix)) {
      return ok(canonicalWorkspace.value);
    }
    if (`${expandedWorkspace}/`.startsWith(expandedRootPrefix)) {
      return err({ kind: "symlink_escape", expandedWorkspace, canonicalRoot: canonicalRoot.value });
    }
    return err({
      kind: "outside_root",
      canonicalWorkspace: canonicalWorkspace.value,
      canonicalRoot: canonicalRoot.value,
    });
  }

  if (workspace.trim() === "") {
    return err({ kind: "empty_remote", workspace });
  }
  if (/[\n\r\0]/.test(workspace)) {
    return err({ kind: "invalid_remote_characters", workspace });
  }
  return ok(workspace);
}
