// Lark-kind WORKFLOW.md fixture. test-support's writeWorkflowFile emits the
// linear-shaped tracker section, so lark tests render their own front matter
// (values are emitted as JSON, which is valid YAML flow syntax).

import fs from "node:fs";
import { getRunningStore } from "../../../../src/symphony/workflow-store.ts";

export type LarkOverrides = Record<string, unknown>;

function defaults(): LarkOverrides {
  return {
    endpoint: "https://open.feishu.cn",
    app_id: "cli_test_app",
    app_secret: "test-secret",
    app_token: "bascnTEST",
    table_id: "tblTEST",
    assignee: null,
    required_labels: [],
    active_states: ["Todo", "In Progress"],
    terminal_states: ["Done", "Cancelled"],
  };
}

// Writes a lark-kind WORKFLOW.md. Override values win; `undefined` drops the
// key entirely (so tests can exercise missing-config validation).
export function writeLarkWorkflowFile(filePath: string, overrides: LarkOverrides = {}): void {
  const config = { ...defaults(), ...overrides };
  const lines = ["---", "tracker:", '  kind: "lark"'];
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
