// The Bitable plugin's binding of the shared `lark_api` dynamic tool
// (../lark-common/api-tool.ts): the default client is this plugin's
// authenticated request layer, so agent calls carry the `lark` settings'
// endpoint and credentials. Tests inject a fake via `opts.larkClient`.

import { executeLarkApiWith } from "../lark-common/api-tool.ts";
import type { AgentToolExecuteOpts, AgentToolOutcome } from "../types.ts";
import { request as clientRequest } from "./client.ts";

export { LARK_API_TOOL, larkApiToolSpec } from "../lark-common/api-tool.ts";
export type { LarkApiClientFn } from "../lark-common/api-tool.ts";

export function executeLarkApi(
  args: unknown,
  opts: AgentToolExecuteOpts = {},
): Promise<AgentToolOutcome> {
  return executeLarkApiWith((method, path, body) => clientRequest(method, path, body), args, opts);
}
