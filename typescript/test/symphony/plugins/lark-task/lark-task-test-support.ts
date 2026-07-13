// lark-task-kind WORKFLOW.md fixture, mirroring the Bitable plugin's
// lark-test-support (values are emitted as JSON, which is valid YAML flow
// syntax).

import fs from "node:fs";
import { getRunningStore } from "../../../../src/symphony/workflow-store.ts";

export type LarkTaskOverrides = Record<string, unknown>;

function defaults(): LarkTaskOverrides {
  return {
    endpoint: "https://open.feishu.cn",
    app_id: "cli_test_app",
    app_secret: "test-secret",
    tasklist_guid: "tlg-TEST",
    assignee: null,
    required_labels: [],
    active_states: ["Todo", "In Progress"],
    terminal_states: ["Done", "Cancelled"],
  };
}

// Writes a lark-task-kind WORKFLOW.md. Override values win; `undefined`
// drops the key entirely (so tests can exercise missing-config validation).
export function writeLarkTaskWorkflowFile(
  filePath: string,
  overrides: LarkTaskOverrides = {},
): void {
  const config = { ...defaults(), ...overrides };
  const lines = ["---", "tracker:", '  kind: "lark-task"'];
  for (const [key, value] of Object.entries(config)) {
    if (value === undefined) {
      continue;
    }
    lines.push(`  ${key}: ${JSON.stringify(value)}`);
  }
  lines.push("---", "You are an agent for this repository.", "");
  fs.writeFileSync(filePath, lines.join("\n"));
  getRunningStore()?.forceReload();
}
