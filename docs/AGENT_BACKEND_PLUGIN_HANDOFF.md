# Agent Backend 插件化(Codex app-server 抽象)— Handoff

> 目标读者:实现 agent backend 插件契约的下一个 Claude session。开工前先按顺序
> 通读:本文 → [`PLUGIN_CONTRACT.md`](./PLUGIN_CONTRACT.md)(tracker 插件契约,
> 本任务的设计范本)→ `typescript/src/symphony/codex/app-server.ts`(被抽象的
> 协议客户端,全文)→ `typescript/src/symphony/agent-runner.ts`(唯一生产消费者,
> 全文)。文中行号基于写作时的 HEAD,若有漂移以 grep 为准。

## 0. 一句话任务

Symphony 当前硬编码 Codex app-server 作为唯一的 coding agent 后端。本任务把它
抽象为 **`AgentBackendPlugin` 插件契约**(仿照现有 tracker 插件的
「核心必需 + 其余皆 capability」模式),使不同 agent(Codex app-server、
Claude Code、……)可以通过实现插件接入。本次交付 **P1–P4 四个阶段**:契约 +
注册表 + codex 适配器插件 + agent-runner 切换 + orchestrator/dashboard 消费
规范化信封 + 契约文档。**不包含** claude-code 插件的实现(见 §10 后续工作)。

## 1. 已拍板的决策(不要重新讨论)

以下决策已经过需求分析、方案设计与评审,直接执行:

1. **配置键**:`agent.backend`(string,默认 `"codex"`),挂在已有的 `agent`
   配置节下。不新建顶层 `backend:` 节。现有用户的 WORKFLOW.md **零迁移**
   (不写 `backend` 就是 codex,行为与今天完全一致)。
2. **事件词汇表冻结**:规范化事件层 = 今天 `app-server.ts` 已经发出的包装事件名
   **原样冻结为闭合联合类型**(`session_started` / `turn_input_required` /
   `approval_required` / …,共 16 个,见 §5)。**不改名**(例如不把
   `turn_input_required` 改成 `needs_input`)——这些名字已持久化进 orchestrator
   entry、dashboard 快照 fixture 与 SPEC §10.4,改名是纯 churn。
3. **Claude Code 走 CLI stream-json**:未来的 claude-code 插件通过
   `claude -p --input-format stream-json --output-format stream-json` 长驻进程
   驱动,**不使用 Agent SDK**。本次不实现该插件,但契约设计必须容纳这个形态
   (行帧 JSON 子进程,与 codex 同构;见 §9 的映射验证)。
4. **范围到 P4 为止**:P5(claude-code 骨架、`ProcessTransport` 抽共享、
   workspace 校验去重)是后续独立任务。

## 2. 现状:耦合在哪里(开工前必须理解的事实)

**调用入口耦合极浅**:全仓库只有 `agent-runner.ts:6` 直接
`import * as AppServer from "./codex/app-server.ts"`(另有测试与
`harness/assert-parity.ts`)。生产调用面就三个:`AppServer.startSession` /
`runTurn` / `stopSession`(agent-runner.ts:134/166/150)。

**但数据形状耦合很深**,codex 报文通过 `onMessage` 回调扩散到四处:

1. **orchestrator token 提取**硬编码 codex payload 路径
   (`["params","msg","payload","info","total_token_usage"]`、
   `["params","tokenUsage","total"]` 等,orchestrator.ts ≈1165–1245);
2. **rate limits** 从 payload 嗅探 codex 形状(`limit_id` +
   `primary/secondary/credits` 桶,≈1247–1289)——注意 `extractRateLimits`
   **已经优先读顶层 `update.rate_limits` 字段**(≈1247),这是现成的规范化插槽;
3. **`mcpServer/elicitation/request`** method 字符串兜底判定(≈945)——但
   app-server 自身已把 elicitation 转成 `turn_input_required` 事件
   (app-server.ts `needsInput`),此 method 检查只是二道保险,**保留不动**;
4. **status-dashboard ≈600 行 `humanizeCodex*`**(status-dashboard.ts
   ≈571–1173)建立在 codex 原始 method 名(`turn/*`、`item/*`、
   `codex/event/*`)上,且被 golden snapshot 固定。

**关键的减负事实**:事件层已经「半规范化」。orchestrator 的 blocker 判定几乎
只依赖 app-server **包装后的事件名**(`turn_input_required` /
`approval_required`,orchestrator.ts ≈890–891、924–928),而非 codex 原始
method。所以「规范化事件层」的成本主要是**声明与冻结**,不是重写。

**工具桥已分层正确**:tracker 插件的 `agentTools` capability 输出语义结果
`AgentToolOutcome {success, payload}`(plugins/types.ts:103),codex wire 编码
(`contentItems:[{type:"inputText"}]`)集中在 `codex/dynamic-tool.ts`。缺的
只是把「解析激活 tracker 插件 + 分发」抽成中立模块(§6)。

## 3. 硬约束(违反任何一条即返工)

- **Wire 名冻结**(PLUGIN_CONTRACT.md §3、MIGRATION.md):
  `codex_app_server_pid`、`codex_totals`、`codex_rate_limits`、
  `last_codex_event/message/timestamp`、`codex_*_tokens`、
  `codex_worker_update` tag、JSON-API 的 `last_event`/`last_message`/
  `tokens.*` ——全部**不可改名**。SPEC.md §7 的快照字段是对外契约。
- **`typescript/test/symphony/status-dashboard-snapshot.test.ts` 必须逐字节
  通过**。P3 搬迁 humanize 代码的纪律是「只搬不改」,任何重构推迟到搬迁提交
  之后。
- **差分 oracle 保持可用**:`AppServer.replayTranscript` 导出、
  `harness/assert-parity.ts`、`test/fixtures/oracle/codex/`、
  `test/harness/fake-codex.ts` 不得破坏。`codex/app-server.ts` **原地不动**
  (不移动文件、不改既有导出签名),由适配器包装。
- **行为语义零变化**(P1–P3 全程):审批自动决策表(`acceptForSession` /
  `approved_for_session`)、非交互式 `item/tool/requestUserInput` 自动应答
  (含 "Approve this Session" 选项择取与 `NON_INTERACTIVE_TOOL_INPUT_ANSWER`
  兜底)、workspace cwd 校验、`readTimeoutMs`/`turnTimeoutMs` 超时、
  unsupported tool 返回失败而非挂起(SPEC §10.5)——这些都在 app-server.ts
  内部,包装即可,勿动。
- **质量门**:每个阶段结束 `bun run check`(typecheck + biome + bun test)
  全绿;最终 `bun run verify` 通过(credential-free e2e,走 fake codex)。
- **仓库惯例**:`Result<T, unknown>` + tagged plain object 错误
  (`{tag:"..."}`);插件本体是 plain object literal(参照 `LinearPlugin`);
  插件模块**求值期零副作用**(防 config ↔ plugins ESM 环,与 tracker 环同型);
  文件头写用途注释(参照现有文件的 literal-port 注释风格)。

## 4. 契约设计(`plugins/agents/types.ts`)

```ts
// Agent backend plugin contract. Mirrors the tracker plugin design
// (plugins/types.ts): the session API is required, everything else is a
// capability. See docs/AGENT_PLUGIN_CONTRACT.md.

import type { JsonMap } from "../../config/schema.ts";
import type { Result } from "../../result.ts";
import type { AgentToolSpec, AgentToolOutcome, PluginConfigSchema } from "../types.ts";

// ---- normalized event envelope ----------------------------------------------
// Layer (a): closed vocabulary every backend must emit. Exactly the strings
// app-server.ts emits today (SPEC §10.4); renaming breaks persisted entries
// and dashboard fixtures. FROZEN — see handoff §1 decision 2.
export type AgentEventName =
  | "session_started"
  | "startup_failed"
  | "turn_completed"
  | "turn_failed"
  | "turn_cancelled"
  | "turn_ended_with_error"
  | "turn_input_required"   // "needs input" — orchestrator blocks the issue
  | "approval_required"     // orchestrator blocks the issue
  | "approval_auto_approved"
  | "tool_input_auto_answered"
  | "tool_call_completed"
  | "tool_call_failed"
  | "unsupported_tool_call"
  | "notification"          // raw backend traffic, payload passthrough
  | "other_message"
  | "malformed";

// Layer (b): raw payload preserved for presentation. Structural superset of
// today's AppServerMessage, so existing consumers keep working.
export type AgentMessage = {
  event: AgentEventName;
  timestamp: Date;
  sessionId?: string;
  // Neutral name; the codex adapter ALSO sets the frozen legacy alias
  // `codexAppServerPid` so orchestrator/snapshot wire names stay stable.
  backendPid?: string;
  workerHost?: string;
  // Cumulative absolute token totals for the session. MUST be cumulative —
  // orchestrator's computeTokenDelta diffs against the last reported totals.
  usage?: JsonMap;
  // Dashboard-shaped rate limits: { limit_id, primary?, secondary?, credits? }.
  rate_limits?: JsonMap;
  payload?: unknown;        // raw backend payload, passed through untouched
  raw?: string;             // raw wire line when applicable
  [key: string]: unknown;   // backend extras (decision, answer, threadId, ...)
};

export type OnAgentMessage = (message: AgentMessage) => void;

// ---- tool bridging -----------------------------------------------------------
// Semantic tool surface handed to the backend. Specs come from the active
// tracker plugin's agentTools capability; wire mechanics (dynamicTools +
// item/tool/call for codex; in-process MCP for a future claude-code plugin)
// and outcome encoding belong to the plugin.
export type ToolProvider = {
  listSpecs(): AgentToolSpec[];
  execute(tool: string | null, args: unknown): Promise<AgentToolOutcome>;
};

// ---- session API ---------------------------------------------------------------

export type IssueLike = { id?: string | null; identifier?: string | null; title?: string | null };

export type StartSessionOpts = {
  workerHost?: string | null;   // SSH host; null = local
  onMessage?: OnAgentMessage;   // session-scoped event stream
  toolProvider?: ToolProvider;  // advertised at session start where the protocol requires it
};

export type TurnContext = {
  issue: IssueLike;             // titles + log context
  turnNumber: number;
  maxTurns: number;
};

// Opaque session handle. `handle` is plugin-private (the codex adapter stores
// its AppServer.Session there); core code only reads the neutral fields.
export type AgentSession = {
  backendId: string;
  workspace: string;
  workerHost: string | null;
  backendPid?: string;
  handle: unknown;
};

// ok-value of runTurn. sessionId is required (orchestrator logging + snapshot);
// extras are backend-specific and passed through.
export type TurnResult = { sessionId: string; [key: string]: unknown };

export type AgentSessionApi = {
  startSession(workspace: string, opts?: StartSessionOpts): Promise<Result<AgentSession, unknown>>;
  runTurn(session: AgentSession, prompt: string, context: TurnContext): Promise<Result<TurnResult, unknown>>;
  stopSession(session: AgentSession): void;
};

// ---- optional capabilities ------------------------------------------------------

export type AgentUiCapability = {
  // Presentation hook (like tracker ui): one line of operator copy for a
  // stored last-message value; null falls back to the generic summarizer.
  // The codex plugin ships today's humanize* logic verbatim (P3).
  humanizeMessage?(message: unknown): string | null;
};

export type AgentBackendCapabilities = {
  // Same-session continuation turns. false/absent => the runner starts a
  // fresh session per turn and rebuilds the full prompt each time.
  multiTurnSessions?: boolean;
  // Remote execution over worker.ssh_hosts. false/absent => startSession with
  // a non-null workerHost fails with { tag: "remote_workers_unsupported" }.
  remoteWorkers?: boolean;
  // Backend reports rate limits in the envelope.
  rateLimitTelemetry?: boolean;
};

// Differential-oracle seam (harness/assert-parity.ts); codex-only today.
export type ReplayCapability = {
  replayTranscript(serverMessages: unknown[]): Promise<unknown[]>;
};

// ---- plugin ---------------------------------------------------------------------

export type AgentBackendPlugin = {
  id: string;          // matches `agent.backend` in WORKFLOW.md ("codex", "claude_code")
  displayName: string;
  // Casts the plugin's private top-level WORKFLOW.md section (named after the
  // plugin id). The codex plugin OMITS this: its `codex` section stays typed
  // in core schema.ts, frozen for zero-migration.
  configSchema?: PluginConfigSchema;

  sessions: AgentSessionApi;    // REQUIRED core

  capabilities?: AgentBackendCapabilities;
  ui?: AgentUiCapability;
  replay?: ReplayCapability;
};
```

**契约 MUST 条款**(写进 P4 的 AGENT_PLUGIN_CONTRACT.md):

- `runTurn` 期间 MUST 经 `onMessage` 发出 `session_started`,并以
  `turn_completed`(ok)或 `turn_failed` / `turn_cancelled` /
  `turn_input_required` / `approval_required`(err,err 值携带同名 tag)终结;
- 审批/用户输入 MUST NOT 无限期挂起:要么按策略自动解决(发
  `approval_auto_approved` / `tool_input_auto_answered`),要么发
  `approval_required` / `turn_input_required` 并使 turn 失败;
- `usage` MUST 是会话内累计绝对值(实现只拿到逐 turn 增量就必须自行累加;
  发增量会导致 orchestrator 统计翻倍——fake-backend 测试显式覆盖此语义);
- 不认识的后端流量 MUST 以 `notification` / `other_message` + `payload`
  透传,不得丢弃(dashboard 依赖)。

**注册表**(`plugins/agents/registry.ts`,逐行镜像 `plugins/registry.ts`):
`registerAgentBackend` / `agentBackend(kind)`(err tags:
`missing_agent_backend` / `unsupported_agent_backend`)/
`agentBackendOrNull`(读 app-env `agent_backend_overrides` 作测试缝,同
`tracker_plugin_overrides`)/ `registeredAgentBackendKinds`。
`plugins/agents/index.ts` 注册内建插件;`config.ts` 与 `agent-runner.ts`
副作用 import 它(同 tracker 的注册保证)。`test/support/test-support.ts`
的 teardown 需清理 `agent_backend_overrides`。

**解析时机(与 tracker 的有意分歧,P4 文档必须明示)**:tracker 插件每次
facade 调用重解析 kind;agent backend 在 **run 开始时解析一次并 pin 住整个
run**——session 有状态,中途换后端会撕裂会话。登记进 MIGRATION.md
「Post-cutover divergence」。

## 5. 事件映射(codex 适配器)

codex 适配器的 `normalizeCodexMessage` 在 P2 是**恒等函数**
(`AppServerMessage` 已结构兼容 `AgentMessage`,且已带 `codexAppServerPid` /
`usage`);P3 追加两个纯增量动作:

| 项 | P3 动作 |
|---|---|
| pid | 同时写中立别名 `backendPid`(冻结名 `codexAppServerPid` 保留) |
| rate limits | 从 `codex/event/token_count` payload 提升到信封 `rate_limits` 字段(orchestrator 嗅探逻辑**保留为 fallback,不删**) |

事件名本身零映射——app-server 发出的 16 个事件名就是规范层(§1 决策 2)。
orchestrator 端 P3 的全部改动(全部向后兼容、codex 路径保留为 fallback):

- `codexAppServerPidForUpdate` 改读 `update.backendPid ?? update.codexAppServerPid`;
- `extractTokenUsage` 首查平铺的 `update.usage`(累计 map),codex 深路径嗅探
  原样保留在其后;
- blocker 判定**不动**(事件名就是规范层);`mcpServer/elicitation/request`
  method 兜底检查**保留**。

## 6. 工具桥接

新中立模块 `plugins/agents/tool-provider.ts`:把 `codex/dynamic-tool.ts` 里
「解析激活 tracker 插件 + 分发 + 不支持工具的失败语义」上移为
`trackerToolProvider(): ToolProvider`(每次调用从 WORKFLOW.md 重解析 tracker
插件,无 agentTools 则 `listSpecs()` 返回 `[]`,未知工具返回
`{success:false, payload:{error:{message, supportedTools}}}`)。

`codex/dynamic-tool.ts` **保留原位与原导出**(`execute` / `toolSpecs` /
`DynamicToolResponse`),内部改为委托 `trackerToolProvider()` 再做 codex 编码
(`contentItems:[{type:"inputText"}]`、Elixir `:atom` inspect 语义)——
`dynamic-tool.test.ts` 与 `app-server.test.ts` 不动即绿。codex 适配器把
`ToolProvider` 包装成 `AppServer.ToolExecutor` 注入 `runTurn`。

## 7. 配置演进(零迁移)

目标形态:

```yaml
agent:
  backend: codex        # 新增,默认 codex —— 现有用户文件一字不改
  max_turns: 20
codex:                  # 原样冻结,仍由核心 castCodex 类型化
  command: codex app-server
```

`config/schema.ts`:

- `AgentSettings` 新增 `backend: string`(castString,默认 `"codex"`)与
  `backendConfig: JsonMap`(激活 backend 的**同名顶层节**原始内容,交给
  `agentBackendOrNull(backend)?.configSchema.cast`;无插件或无 schema 时
  **原样透传**——镜像 tracker 对未注册 kind 的行为:parse 成功、validate 报错);
- `finalizeSettings` 追加 backend 的 `configSchema.finalize(backendConfig)`;
- `config.validateSemantics` 追加:`agentBackend(settings.agent.backend)`
  必须解析成功(err tag `unsupported_agent_backend`),有 configSchema 则跑其
  `validate`;
- **`CodexSettings` 与 `castCodex` 一行不动**;codex 插件继续经
  `codexRuntimeSettings()` 读类型化配置;
- `codex.stall_timeout_ms` 被 orchestrator 直接读(后端无关的停滞判定),
  **本期不动**;`agent.stall_timeout_ms`(优先)+ codex 值 fallback 登记为
  后续 additive 项,写进 P4 文档的 future-work 清单。

## 8. 分阶段实施(每阶段独立提交,测试全绿)

### P1 — 契约 + 注册表 + codex 适配器(纯新增,零触碰既有文件*)

新增:`plugins/agents/{types,registry,index,tool-provider}.ts`、
`plugins/agents/codex/plugin.ts`。
(*唯一例外:`test/support/test-support.ts` teardown 加一行清理 override。)

codex 适配器要点:`startSession` 包装 `AppServer.startSession`,把
`AppServer.Session` 连同 `onMessage` / `toolProvider` 存进 `handle`;
`runTurn` 转发到 `AppServer.runTurn`(onMessage 经 normalize、toolProvider
编码为 ToolExecutor);`stopSession` 转发;
`capabilities: { multiTurnSessions: true, remoteWorkers: true, rateLimitTelemetry: true }`;
`replay: { replayTranscript: AppServer.replayTranscript }`。

测试(新增 `test/symphony/plugins/agents/`):
- `registry.test.ts`:解析 / override 缝 / 未注册 kind 的 err tag;
- `codex-plugin.test.ts`:复用 `app-server.test.ts` 的 fake-codex 脚本模式,
  走插件 API 全链路(start → turn → stop、approval 自动通过、tool call 经
  ToolProvider 往返);
- `tool-provider.test.ts`:有/无 agentTools 能力、unsupported tool payload。

### P2 — agent-runner 切换到插件面(行为不变)

改动:`agent-runner.ts` 删除 `import * as AppServer`;run 开始
`agentBackend(settingsBang().agent.backend)` 解析一次 pin 住;
`runCodexTurns` → `runAgentTurns`;注入 `trackerToolProvider()` 与 session 级
`onMessage`;实现 `multiTurnSessions` 缺失时的 fresh-session fallback
(每 turn `startSession`,turn>1 不用 continuation guidance 而是重新
`buildPrompt` 全量提示);`WorkerUpdate.message` 类型改为 `AgentMessage`
(**tag 字符串 `codex_worker_update` 冻结不动**)。
`config/schema.ts` 的 `agent.backend` + `backendConfig` 也在本阶段落地
(P1 的 registry 先行,校验才有对象)。

测试:`agent-runner.test.ts` **原样通过**(唯一生产路径仍是 codex,同行为);
新增 `fake-backend.test.ts`:经 override 缝注入合成后端(含/不含
`multiTurnSessions`),断言 continuation 语义、fresh-session fallback、
`remote_workers_unsupported` 路径、**usage 累计语义**——这是接口能装下第二
后端的直接证明。`config.test.ts` / `config/schema.test.ts` 补 `agent.backend`
默认值与未注册 backend 的 validate 报错用例。

### P3 — orchestrator / dashboard 消费规范化信封(codex fallback 保留)

改动:
- `orchestrator.ts`:§5 所列三处(backendPid 别名读取、平铺 usage 首查、
  类型别名 `AgentUpdate = CodexUpdate`;**`codex_*` state/快照键全部冻结**);
- `plugins/agents/codex/plugin.ts`:normalize 写 `backendPid`、提升
  `rate_limits`;
- `status-dashboard.ts`:`humanizeCodex*` 及其纯 helper **原样迁入**
  `plugins/agents/codex/humanize.ts`(只搬不改);`summarizeMessage` 改为
  `agentBackendOrNull(kind)?.ui?.humanizeMessage(msg) ?? genericSummarize(msg)`;
  `humanizeCodexMessageExport` 保留签名(web/presenter.ts 依赖)转发到新路径;
  `codex/event/token_count` 等**着色分支保持字面量**(fixture 冻结)。

测试:`status-dashboard-snapshot.test.ts` **逐字节通过**是本阶段的验收线;
`orchestrator-status.test.ts` 不动;新增:fake 后端 humanize 钩子生效、
`backendPid` 与平铺 `usage` 被采纳、缺信封 `rate_limits` 时嗅探 fallback 仍
工作。

### P4 — 文档

- 新增 `docs/AGENT_PLUGIN_CONTRACT.md`,结构镜像 PLUGIN_CONTRACT.md:
  Overview / Resolution & registration(含 run 级 pin 的分歧说明)/ 事件信封
  与词汇表(§4/§5)/ Required session API / Optional capabilities / 错误模型
  (tagged object + SPEC §10.6 推荐 tag)/ 配置契约 / 测试缝表(override、
  fake-backend、fake-codex 脚本、replay)/ 内建插件参考(codex)/ 新插件
  checklist(含 claude-code CLI stream-json 的落点提示,见 §9);
- `PLUGIN_CONTRACT.md` 加一节交叉引用;
- `typescript/MIGRATION.md` 「Post-cutover divergence」登记:backend 按 run
  pin、`codex_*` wire 名语义扩展为「历史名,语义为 agent backend」;
- SPEC.md **不改**(§10 本就宣称协议中立;至多加一行指向新契约文档)。

## 9. Claude Code(CLI stream-json)映射验证 — 契约的设计依据,本次不实现

契约的每个面都必须在这个第二后端上有自然落点(P4 文档的 checklist 据此写):

- **进程**:`claude -p --input-format stream-json --output-format stream-json
  --verbose` 长驻子进程,行帧 JSON,与 codex 的 `ProcessTransport` 同构
  (P5 再抽共享 Transport,本次不动);SSH 远程路径因此免费获得;
- **会话**:`system/init` 事件的 `session_id` → 信封 `sessionId` 与
  `TurnResult.sessionId`;`runTurn` = 写入一条
  `{type:"user", message:{role:"user", content: prompt}}` 读流至 `result`;
  `multiTurnSessions: true`(同进程续写即续聊;进程死亡可 `--resume <session_id>`
  重建);
- **事件**:`system/init` → `session_started`;`result subtype=success` →
  `turn_completed` + `usage`(result.usage 是会话累计,契合信封语义);
  `subtype=error_*` → `turn_failed`;`assistant`/`user` 流事件 →
  `notification` + payload 透传(`ui.humanizeMessage` 各自渲染);
- **权限**:permission 询问/拒绝 → 按策略自动放行发 `approval_auto_approved`,
  或发 `approval_required` 并 err 结束 turn(与 codex 语义一一对应;
  `--permission-mode bypassPermissions` ≈ codex `approval_policy: never`);
- **工具**:`ToolProvider` 经 `--mcp-config` 子进程桥编码为 MCP tools
  (`content:[{type:"text",text}]`,`isError` = `!success`);
- **遥测**:无 rate_limits / pid 语义对应物 → 字段可选,dashboard 已能渲染
  n/a(现状对缺失值即如此)。

## 10. 后续工作(明确不在本次范围)

- P5:claude-code 插件实现(fake-claude 脚本测试,stream-json 台词版
  fake-codex);`ProcessTransport` 从 app-server.ts 抽到共享模块并 re-export;
  `validateWorkspaceCwd`(app-server.ts)与 `validateWorkspacePath`
  (workspace.ts)两份近似重复的安全校验归一;
- `agent.stall_timeout_ms` additive 项;
- 差分 oracle 的多后端 fixture 命名空间(`TranscriptSide` 泛化)。

## 11. 风险与纪律

1. **P3 humanize 搬迁是最大风险**(≈450 行纯函数):只搬不改,golden snapshot
   逐字节兜底;搬迁与任何重构分属不同提交;
2. **ESM 环**(config ↔ plugins/agents ↔ codex/app-server ↔ config):与现有
   tracker 环同型,守则是插件模块求值期只构建对象字面量;
3. **usage 语义**:契约规定累计绝对值,fake-backend 测试显式断言;
4. 每阶段一个(或一组)独立提交,提交信息说明阶段编号;全程
   `bun run check` 全绿,收尾 `bun run verify` 通过。

## 12. 关键文件索引

| 文件 | 角色 |
|---|---|
| `typescript/src/symphony/codex/app-server.ts` | 被包装的协议客户端(Transport / 生命周期 / 审批 / replay)——原地不动 |
| `typescript/src/symphony/codex/dynamic-tool.ts` | codex 工具 wire 编码;P1 改为委托 tool-provider |
| `typescript/src/symphony/agent-runner.ts` | 唯一生产消费者;P2 切换点 |
| `typescript/src/symphony/orchestrator.ts` | 信封消费端;P3 三处兼容性改动 |
| `typescript/src/symphony/status-dashboard.ts` | humanize 源;P3 搬迁出处 |
| `typescript/src/symphony/web/presenter.ts` | JSON-API 投影(字段名冻结);依赖 `humanizeCodexMessageExport` |
| `typescript/src/symphony/config.ts` / `config/schema.ts` | `agent.backend` + `backendConfig` 落点;`codex` 节冻结 |
| `typescript/src/symphony/plugins/{types,registry,index}.ts` | 契约范本(PluginConfigSchema / AgentToolSpec / override 缝直接复用) |
| `typescript/test/symphony/codex/app-server.test.ts` | fake-codex 脚本模式的出处(P1 测试复用) |
| `typescript/test/symphony/status-dashboard-snapshot.test.ts` | P3 验收线(逐字节) |
| `docs/PLUGIN_CONTRACT.md` | 文档范本;P4 镜像其结构 |
| `SPEC.md` §10 / §16.5 | codex 集成语义与 agent 伪码(行为基线,不改) |
