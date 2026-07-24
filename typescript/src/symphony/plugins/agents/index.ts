// Single registration point for built-in agent backend plugins. Importing this
// module (for side effects) guarantees the registry is populated; `config.ts`
// and `agent-runner.ts` both do so, mirroring the tracker `plugins/index.ts`.
// Out-of-tree backends would call `registerAgentBackend` from their own entry
// point.

import { CodexPlugin } from "./codex/plugin.ts";
import { registerAgentBackend } from "./registry.ts";

registerAgentBackend(CodexPlugin);
