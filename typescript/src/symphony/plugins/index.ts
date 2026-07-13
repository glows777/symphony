// Single registration point for built-in tracker plugins. Importing this
// module (for side effects) guarantees the registry is populated; the tracker
// facade and config both do so. Out-of-tree plugins would call
// `registerTrackerPlugin` from their own entry point.

import { LarkTaskPlugin } from "./lark-task/plugin.ts";
import { LarkPlugin } from "./lark/plugin.ts";
import { LinearPlugin } from "./linear/plugin.ts";
import { MemoryPlugin } from "./memory/plugin.ts";
import { registerTrackerPlugin } from "./registry.ts";

registerTrackerPlugin(LinearPlugin);
registerTrackerPlugin(MemoryPlugin);
registerTrackerPlugin(LarkPlugin);
registerTrackerPlugin(LarkTaskPlugin);
