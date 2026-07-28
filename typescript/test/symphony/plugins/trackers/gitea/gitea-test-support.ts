import fs from "node:fs";
import { getRunningStore } from "../../../../../src/symphony/workflow-store.ts";

export type GiteaOverrides = Record<string, unknown>;

function defaults(): GiteaOverrides {
  return {
    endpoint: "https://gitea.test",
    token: "test-token",
    owner: "acme",
    repo: "symphony",
    assignee: null,
    required_labels: [],
    active_states: ["open"],
    terminal_states: ["closed"],
  };
}

export function writeGiteaWorkflowFile(filePath: string, overrides: GiteaOverrides = {}): void {
  const config = { ...defaults(), ...overrides };
  const lines = ["---", "tracker:", '  kind: "gitea"'];
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
