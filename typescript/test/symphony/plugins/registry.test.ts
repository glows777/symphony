import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { putEnv } from "../../../src/symphony/app-env.ts";
// Side-effect import mirrors production entry points: built-ins registered.
import "../../../src/symphony/plugins/index.ts";
import { LinearPlugin } from "../../../src/symphony/plugins/linear/plugin.ts";
import { MemoryPlugin } from "../../../src/symphony/plugins/memory/plugin.ts";
import {
  registeredTrackerKinds,
  trackerPlugin,
  trackerPluginOrNull,
} from "../../../src/symphony/plugins/registry.ts";
import type { TrackerPlugin } from "../../../src/symphony/plugins/types.ts";
import { ok } from "../../../src/symphony/result.ts";
import * as Tracker from "../../../src/symphony/tracker/tracker.ts";
import { setupWorkflow, teardownWorkflow } from "../../support/test-support.ts";

describe("Plugins.Registry", () => {
  test("resolves built-in plugins by kind", () => {
    expect(trackerPlugin("linear")).toEqual(ok(LinearPlugin));
    expect(trackerPlugin("memory")).toEqual(ok(MemoryPlugin));
    expect(registeredTrackerKinds()).toEqual(["linear", "memory"]);
  });

  test("reports missing and unsupported kinds with stable tags", () => {
    const missing = trackerPlugin(null);
    expect(missing.ok).toBe(false);
    if (!missing.ok) {
      expect(missing.error.tag).toBe("missing_tracker_kind");
      expect(missing.error.code).toBe("missing_config");
      expect(missing.error.message).toBe("Tracker kind missing in WORKFLOW.md");
    }

    const unsupported = trackerPlugin("jira");
    expect(unsupported.ok).toBe(false);
    if (!unsupported.ok) {
      expect(unsupported.error.tag).toBe("unsupported_tracker_kind");
      expect(unsupported.error.code).toBe("missing_config");
      expect(unsupported.error.message).toContain('"jira"');
      expect(unsupported.error.message).toContain("linear, memory");
      expect(unsupported.error.detail).toEqual({ value: "jira" });
    }

    expect(trackerPluginOrNull("jira")).toBeNull();
    expect(trackerPluginOrNull(null)).toBeNull();
  });

  describe("overrides and capability fallbacks", () => {
    let root: string;

    beforeEach(() => {
      ({ root } = setupWorkflow());
    });

    afterEach(() => {
      teardownWorkflow(root);
    });

    test("tracker_plugin_overrides shadows a registered kind", async () => {
      // A read-only plugin without write capabilities, standing in for a
      // tracker like a chat thread source that has no state machine.
      const readOnly: TrackerPlugin = {
        id: "linear",
        displayName: "Read-only fake",
        fetchCandidateIssues: () => Promise.resolve(ok([])),
        fetchIssuesByStates: () => Promise.resolve(ok([])),
        fetchIssueStatesByIds: () => Promise.resolve(ok([])),
      };
      putEnv("tracker_plugin_overrides", { linear: readOnly });

      expect(Tracker.adapter()).toBe(readOnly);
      expect(await Tracker.fetchCandidateIssues()).toEqual(ok([]));

      const comment = await Tracker.createComment("issue-1", "hello");
      expect(comment.ok).toBe(false);
      if (!comment.ok) {
        expect(comment.error).toEqual({
          tag: "tracker_capability_unsupported",
          code: "unsupported_operation",
          message: "tracker 'linear' does not support comments",
        });
      }

      const update = await Tracker.updateIssueState("issue-1", "Done");
      expect(update.ok).toBe(false);
      if (!update.ok) {
        expect(update.error).toEqual({
          tag: "tracker_capability_unsupported",
          code: "unsupported_operation",
          message: "tracker 'linear' does not support state updates",
        });
      }
    });
  });
});
