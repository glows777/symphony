# Claude Code Agent Backend 插件(P5)— Handoff

> 目标读者:实现 `agent.backend: "claude_code"` 插件的下一个 Claude session。
> 开工前先按顺序通读:本文 →
> [`AGENT_PLUGIN_CONTRACT.md`](./AGENT_PLUGIN_CONTRACT.md)(agent backend 插件
> 契约,**规范性,逐条满足**)→
> [`AGENT_BACKEND_PLUGIN_HANDOFF.md`](./AGENT_BACKEND_PLUGIN_HANDOFF.md)
> (P1–P4 的背景与决策,尤其 §9)→ 参考实现
> `typescript/src/symphony/plugins/agents/codex/`(适配器范本)与
> `typescript/test/symphony/plugins/agents/codex-plugin.test.ts`、
> `typescript/test/symphony/agent-runner-fake-backend.test.ts`(测试范本)。
> 文中行号基于 PR #9 合并后的 HEAD,若有漂移以 grep 为准。

## 0. 一句话任务

P1–P4 已把 agent backend 抽象为 `AgentBackendPlugin` 契约(唯一内建后端是
codex)。本任务交付 **P5**:实现第二个内建后端 **`claude_code`**——通过
**Claude Code CLI 的 stream-json 长驻进程**驱动;顺带完成两项被推迟的重构:
**共享 `ProcessTransport` 抽取**与 **workspace 安全校验去重**。完成后,
WORKFLOW.md 写 `agent.backend: claude_code` 即可用 Claude Code 跑 issue。

## 1. 已拍板的决策(不要重新讨论)

1. **CLI stream-json,不用 SDK**:插件驱动
   `claude -p --input-format stream-json --output-format stream-json` 长驻
   子进程(行帧 JSON,与 codex transport 同构)。**不引入**
   `@anthropic-ai/claude-agent-sdk` 或任何新 npm 依赖。
2. **backend id 与配置节名 = `claude_code`**:registry id、`agent.backend`
   取值、WORKFLOW.md 顶层配置节三者同名(对齐 tracker 插件 `lark_task` 的
   下划线惯例)。
3. **v1 仅本地执行**:`capabilities.remoteWorkers` **不声明**。原因:工具桥走
   MCP-over-HTTP 回连 symphony 进程(见 §5),远程 SSH 主机回连编排机的网络
   可达性是独立课题。runner 已有 fail-fast 守卫(`remote_workers_unsupported`,
   agent-runner.ts),无需插件做任何事。此决策**修正**了 P1–P4 handoff §9
   「SSH 远程免费获得」的说法——那句话假设工具流量走 stdio,对 claude_code
   不成立。
4. **`multiTurnSessions: true`**:同一长驻进程上续写 stream-json 即续聊
   (对应契约的同 session 多 turn)。进程意外死亡后用
   `--resume <session_id>` 重建是 SHOULD(可作 follow-up,v1 允许直接把
   turn 判为 `port_exit` 失败走既有 retry)。
5. **`rateLimitTelemetry` 不声明、`replay` 不提供**:CLI 无 rate-limit 语义
   对应物(dashboard 已能渲染 n/a);差分 oracle 保持 codex-only。

## 2. 交付物与顺序

按 A → B → C(→ D 可选)推进,**每个任务独立提交**,每次提交
`bun run check` 全绿,收尾 `bun run verify` 通过:

- **A. 共享 Transport 抽取**(先做,C 依赖它);
- **B. workspace 校验统一**(C 的 startSession 要用统一守卫);
- **C. `claude_code` 插件本体 + 测试 + 文档**;
- **D.(可选,additive)`agent.stall_timeout_ms`**。

## 3. 任务 A:共享 `ProcessTransport` 抽取

现状:`Transport` 接口、`LineEvent`、`ProcessTransport`、`ReplayTransport`
都在 `codex/app-server.ts:60-184`。

- 把 **`Transport` 接口、`LineEvent` 类型、`ProcessTransport` 类**移到新模块
  `plugins/agents/transport.ts`(行帧 JSON 收发 + 队列/waiter + 超时 +
  exit 事件,原样搬迁);
- `app-server.ts` **re-export** 它们(既有 import 路径与导出签名一字不变——
  `harness/`、`app-server.test.ts` 零改动通过);
- `ReplayTransport` **留在** app-server.ts(codex 差分 oracle 专属);
- 硬约束:app-server.ts 的行为与全部既有测试零变化。这一步是纯移动 +
  re-export,不做任何顺手重构。

## 4. 任务 B:workspace 校验统一

同一套安全护栏(canonicalize、root 前缀、symlink escape、remote 路径字符
检查)现有**两份近似重复**:

- `codex/app-server.ts:347-416 validateWorkspaceCwd` — 返回
  `Result<canonicalPath, {tag:"invalid_workspace_cwd", reason:..., ...}>`;
- `workspace.ts:350-402 validateWorkspacePath` — 返回
  `Result<undefined, {tag:"workspace_equals_root"|"workspace_outside_root"|"workspace_symlink_escape"|"workspace_path_unreadable", ...}>`。

要求:

- 抽一个共享核心守卫(建议放 `workspace.ts` 导出,或 `path-safety.ts` 旁),
  输出**语义结果**(ok(canonical) / 违规类别 + 细节);
- 两个既有调用点改为委托核心守卫,**各自保留今天的错误 tag 与形状**
  (上述两套 tag 都有测试与日志消费,不可合并改名);
- `claude_code` 插件的 `startSession` MUST 在启动进程前执行同一守卫
  (SPEC §17;错误形状建议沿用 `invalid_workspace_cwd` 一族,与 codex 后端
  一致);
- 既有测试(app-server.test.ts 的 root/outside/symlink 用例、workspace
  相关用例)零改动通过。

## 5. 任务 C:`claude_code` 插件本体

### 5.1 文件布局

```
typescript/src/symphony/plugins/agents/claude-code/
  plugin.ts        # AgentBackendPlugin 对象 + sessions 实现
  client.ts        # stream-json 进程客户端(复用共享 ProcessTransport)
  settings.ts      # 类型化读取 settings.agent.backendConfig
  mcp-server.ts    # ToolProvider -> streamable HTTP MCP 桥
  humanize.ts      # ui.humanizeMessage(可选但建议)
typescript/test/symphony/plugins/agents/
  claude-code-plugin.test.ts
typescript/test/harness/fake-claude.ts   # 台词驱动的假 claude CLI
```

`plugins/agents/index.ts` 注册 `ClaudeCodePlugin`。插件模块**求值期零副作用**
(ESM 环守则,同 codex 插件)。

### 5.2 configSchema(认领顶层 `claude_code` 节)

实现契约的 `cast/finalize/validate` 钩子(参照 tracker 插件的
`PluginConfigSchema` 用法与 `plugins/config-helpers.ts` 的 `$VAR` 解析惯例):

| 键 | 类型/默认 | 说明 |
|---|---|---|
| `command` | string,默认 `"claude"` | 经 `bash -lc` 启动,cwd = workspace(镜像 codex `startPort`) |
| `permission_mode` | string 枚举,默认 `"bypass"` | `"bypass"` → 全自动放行(对应 codex `approval_policy: never` 的语义);`"default"` → 权限请求走 `approval_required` 阻塞路径(§5.5)。validate 拒绝未知值 |
| `model` | string?,可空 | 透传 `--model` |
| `allowed_tools` / `disallowed_tools` | string[]?,可空 | 透传 `--allowedTools` / `--disallowedTools` |
| `turn_timeout_ms` | int,默认 3_600_000 | turn 流总超时(镜像 codex) |
| `read_timeout_ms` | int,默认同 codex readTimeoutMs | 启动/init 应答超时 |

Symphony 是非交互编排器,默认 `"bypass"` 是有意选择(codex 的默认 reject
策略会让每个 issue 立即 blocked,对 claude_code 没有意义;文档里写明)。

### 5.3 进程与 CLI 参数

启动:`<command> -p --input-format stream-json --output-format stream-json
--verbose` 加上按配置追加的 `--model` / `--allowedTools` /
`--disallowedTools` / `--permission-mode` / `--mcp-config <json>`。

> ⚠️ **CLI 事实以实测为准**:flags 的确切拼写、`--verbose` 是否必需、
> `--mcp-config` 是否接受内联 JSON、stream-json 消息的具体字段,随 CLI 版本
> 变化。开工时先 `claude --help` + 手动跑一次 stream-json 往返确认,把确认
> 结果固化进 fake-claude 台词。**测试不依赖真 CLI**(§6),真 CLI 差异只
> 影响生产路径的参数拼装,集中在 client.ts 一处。

### 5.4 session / turn / 事件映射

- `startSession`:守卫 workspace(任务 B)→ 启动进程(共享
  ProcessTransport)→ 可惰性等到首 turn;`stopSession`:关闭 MCP server +
  kill 进程;
- `runTurn`:写入
  `{type:"user", message:{role:"user", content:[{type:"text", text: prompt}]}}`,
  读流直到 `result` 消息;
- **sessionId 派生(已核实,MUST)**:orchestrator 的 `turnCountForUpdate`
  只在 `session_started` 且 sessionId **与上次不同**时计数
  (orchestrator.ts:1131-1139)。CLI 的 `session_id` 跨 turn 不变,直接用会
  让 dashboard 的 turn 计数冻结在 1。派生每 turn 唯一 id,镜像 codex 的
  `${threadId}-${turnId}`:用 `${session_id}-${turnNumber}`;
- 事件映射(信封事件词汇表冻结,见契约 §4):

| CLI stream-json 消息 | 信封 event | 备注 |
|---|---|---|
| `{type:"system", subtype:"init", session_id}` | `session_started` | sessionId 按上述派生;首 turn 记录原始 session_id |
| `{type:"result", subtype:"success", ...}` | `turn_completed` | runTurn 返回 ok;`usage` 见 §5.6 |
| `{type:"result", subtype:"error_*", ...}` | `turn_failed` | runTurn 返回 err({tag:"turn_failed", ...}) |
| `{type:"assistant" \| "user", ...}` 及其他流消息 | `notification` | payload 原样透传(MUST NOT 丢弃) |
| 权限请求(§5.5,非 bypass 模式) | `approval_required` | turn err 同 tag |
| MCP 工具调用完成/失败/未知 | `tool_call_completed` / `tool_call_failed` / `unsupported_tool_call` | 在 mcp-server handler 内发 |
| 以 `{` 开头但 JSON 解码失败的行 | `malformed` | 参照 app-server `protocolMessageCandidate`;其他非 JSON 行仅打日志 |
| 进程退出(turn 中) | — | runTurn err({tag:"port_exit", status}) |
| 流超时 | — | runTurn err({tag:"turn_timeout"}) |

- 信封元数据:`backendPid`(ProcessTransport.osPid();**不要**写
  `codexAppServerPid`——那是 codex 后端的冻结别名)、`timestamp`、
  `workerHost`(恒 null)。

### 5.5 审批语义(契约 MUST:不得挂起)

- `permission_mode: "bypass"`:映射 CLI 的全自动模式
  (`--permission-mode bypassPermissions` 或等价 flag,以实测为准),工具全
  放行,无审批事件;
- `permission_mode: "default"`:任何到达插件的权限请求/拒绝,MUST 发
  `approval_required` 事件并以 `err({tag:"approval_required", payload})`
  终结 turn(kill/interrupt 进程收尾即可)。机制建议:
  `--permission-prompt-tool` 指向我们 MCP server 的一个 approval 工具,
  收到调用 = 发事件、回拒绝、终结 turn;若实测发现 headless 下 CLI 直接
  静默拒绝并继续,则退而在 result 里检测并按 `turn_failed` 处理——**锁语义
  不锁机制**,实测后选一条最简路径,写进插件文件头注释。

### 5.6 usage(契约 MUST:会话内累计绝对值)

`result.usage` 的 input/output token 字段名(camelCase)已被 orchestrator 的
`TOKEN_USAGE_FIELDS` 接受;但其**累计语义必须实证**:是整个会话累计还是
单 turn 独立,CLI 文档/版本间说法不一。若是单 turn,插件内自行累加后再放进
信封 `usage`(fake-backend 测试对该语义已有断言先例,照抄)。cache token
等额外字段直接丢弃或透传皆可,orchestrator 只认 input/output/total。

### 5.7 工具桥(mcp-server.ts)

- `Bun.serve` 在 `127.0.0.1` 随机端口起一个 **streamable HTTP MCP server**
  (只绑 localhost,安全要求):`tools/list` 返回
  `toolProvider.listSpecs()`(name/description/inputSchema 直通);
  `tools/call` → `toolProvider.execute(name, args)` →
  `content:[{type:"text", text: <encoded payload>}]`、
  `isError = !outcome.success`。payload 编码语义参照
  `codex/dynamic-tool.ts` 的 `encodePayload`(对象 JSON.stringify(_,null,2),
  字符串按 `:atom` inspect),但 MCP 形状,**不要**复用 codex 的
  `contentItems` 编码;
- `--mcp-config` 内联 JSON(或临时文件,以实测为准)把该 URL 注册为
  `symphony` server;
- **用注入的 `opts.toolProvider`,不要走全局**。注意:codex 适配器有一个
  已登记的契约洞(plugin.ts:41-46 的注释)——它的工具 spec 广告走全局
  `DynamicTool.toolSpecs()` 而非注入的 provider(因 app-server `startThread`
  签名冻结)。claude_code 没有这个约束,MCP server 直接持有注入的
  provider,**天然规避,不要复刻这个洞**。app-server 侧的洞本期不修
  (除非任务 A 顺手能零风险做,否则保持登记状态);
- MCP server 生命周期 = session 生命周期;`stopSession` 必须关闭。

### 5.8 humanize(建议实现)

`ui.humanizeMessage`:`assistant` 消息 → 文本摘要/工具名一行;`result` →
"turn completed (n turns, $cost)" 之类;返回 null 走 generic fallback。
参照 `plugins/agents/codex/humanize.ts` 的量级**不需要**——几十行即可,
CLI 消息形状远比 codex 简单。

## 6. 测试策略(不依赖真 claude CLI)

- **fake-claude**(`test/harness/fake-claude.ts`):台词驱动的 Bun 脚本,
  参照 `codex-plugin.test.ts` 内嵌 `codexScript` 的模式——读 stdin 行,
  按预设台词逐行吐 stream-json。工具桥用例:fake 从 env(如
  `SYMPHONY_TEST_MCP_URL`,由测试注入)读 MCP 地址,发
  `tools/list` + `tools/call` HTTP 请求,断言桥路端到端;
- **claude-code-plugin.test.ts** 覆盖:start→turn→stop 全链路(init→
  result success)、`turn_failed`(result error_*)、`turn_timeout`(不吐
  result)、`port_exit`(fake 提前退出)、malformed 行、多 turn 的
  sessionId 派生(断言 `-1`/`-2` 后缀且 turn 计数语义成立)、usage 累计、
  MCP 工具往返(completed/failed/unsupported 三态)、`permission_mode`
  两态、workspace 守卫拒绝(root/outside);
- **config 测试**:`claude_code` 节 cast/finalize/validate(默认值、未知
  permission_mode 报错、`$VAR` 解析);
- 既有测试**零改动**全绿;`bun run verify`(默认 codex 路径)不受影响。

## 7. 任务 D(可选,additive):`agent.stall_timeout_ms`

orchestrator 的停滞判定读 `settingsBang().codex.stallTimeoutMs`
(orchestrator.ts `reconcileStalledRunningIssues`)——概念是后端无关的。
若做:`agent.stall_timeout_ms` 新增(可空),orchestrator 优先读它、codex
值作 fallback,默认行为不变;补 schema + orchestrator + 测试。不做则不动
(P4 文档已登记为 future work)。

## 8. 文档更新(任务 C 的一部分)

- `docs/AGENT_PLUGIN_CONTRACT.md`:内建插件参考加 `claude_code` 节
  (capabilities 声明、配置键、事件映射要点、v1 local-only 及其原因);
- `typescript/MIGRATION.md`「Post-cutover divergence」:登记 claude_code
  后端(CLI stream-json、MCP-over-HTTP 工具桥、v1 无 remote)、Transport
  抽取(re-export 兼容)、workspace 守卫统一(错误形状不变);
- README / SPEC.md:检查是否有列举 backend 的位置需要补一行;SPEC 规范文本
  不改。

## 9. 硬约束(违反即返工)

- 事件词汇表与 wire 名**冻结**(契约 §4;`codex_*` 快照键、
  `codex_worker_update` tag 不改不扩);
- `codex/app-server.ts` 既有**导出签名不变**(任务 A 允许内部移动 +
  re-export);`web/presenter.ts` 不动;
- `status-dashboard-snapshot.test.ts` 逐字节通过;
- 不引入任何新 npm 依赖;
- 每任务独立提交,`bun run check` 全绿;收尾 `bun run verify` 通过;
- 仓库惯例:`Result<T, unknown>` + tagged plain object 错误、插件 plain
  object literal、求值期零副作用、文件头用途注释。

## 10. 风险

1. **CLI 版本行为差异**(flags、result.usage 语义、headless 权限行为):
   全部以实测为准,fake-claude 台词固化预期;生产参数拼装集中在 client.ts;
2. **usage 累计语义判断错误**会让 token 统计翻倍或丢失——实证 + 测试断言;
3. **MCP server 泄漏**:stopSession 必须关;测试断言端口释放;
4. **turn 超时后的进程处置**:kill 后 session 不可续,多 turn 场景下该 run
   直接失败走 retry(与 codex `turn_timeout` 后果一致,可接受)。

## 11. 关键文件索引

| 文件 | 角色 |
|---|---|
| `typescript/src/symphony/plugins/agents/types.ts` | 契约(事件词汇表、ToolProvider、capabilities) |
| `typescript/src/symphony/plugins/agents/codex/plugin.ts` | 适配器范本(含 5.7 所述契约洞注释) |
| `typescript/src/symphony/plugins/agents/tool-provider.ts` | ToolProvider 来源(`trackerToolProvider`) |
| `typescript/src/symphony/codex/app-server.ts:60-184` | 任务 A 的搬迁源(Transport/ProcessTransport) |
| `typescript/src/symphony/codex/app-server.ts:347-416` + `workspace.ts:350-402` | 任务 B 的两份重复守卫 |
| `typescript/src/symphony/orchestrator.ts:1131-1139` | turnCountForUpdate(sessionId 派生的依据) |
| `typescript/src/symphony/plugins/config-helpers.ts` | `$VAR` / env 解析惯例 |
| `typescript/test/symphony/plugins/agents/codex-plugin.test.ts` | fake 后端脚本测试范本 |
| `typescript/test/symphony/agent-runner-fake-backend.test.ts` | 契约语义断言范本(usage 累计等) |
| `docs/AGENT_PLUGIN_CONTRACT.md` | 规范契约(逐条满足) |
