# Claude Code 后端本地运行与验收 — Handoff

> 目标读者:在**本地机器**上把 `agent.backend: claude_code` 跑起来并逐项验收的
> 操作者。前置背景(可不读,遇到概念再查):
> [`AGENT_PLUGIN_CONTRACT.md`](./AGENT_PLUGIN_CONTRACT.md)(插件契约)、
> [`CLAUDE_CODE_PLUGIN_HANDOFF.md`](./CLAUDE_CODE_PLUGIN_HANDOFF.md)(实现决策)。
> 本文对应 main 上 PR #11 合并后的状态。

## 0. 一句话目标

用零凭证的 memory tracker + 真实 Claude Code CLI,在本地端到端跑通一次
issue 派发,并按 §5 的清单逐项验收核心行为(会话、多轮、token 计量、状态
流转、阻塞路径、干净退出)。全程不需要 Linear/Lark 账号。

## 1. 前置条件

| 项 | 要求 | 自检命令 |
|---|---|---|
| Bun | ≥ 1.3 | `bun --version` |
| Claude Code CLI | 已安装且**已登录**;实现的实证基线是 `2.1.218`,大版本差异见 §7 | `claude --version`;`claude -p "say hi"` 能出结果即为已登录 |
| 磁盘 | 一个一次性 workspace 父目录(**无需预先创建**,Symphony 会连父目录一起建) | `df -h /tmp` |

> CLI 进程经 `bash -lc` 启动,登录 shell 的 PATH / 环境变量(含
> `ANTHROPIC_API_KEY`,如果你用 key 而非登录态)都会被继承。

## 2. 环境自检(无凭证,~1 分钟)

```bash
git checkout main && git pull
cd typescript
bun install
bun run check     # 期望:0 fail
bun run verify    # 期望:PASS(fake codex 走的 e2e,与 claude 无关,但证明底座完好)
```

## 3. 冒烟 WORKFLOW.md

仓库里已经带了一份可直接用的:**`typescript/WORKFLOW.md`**(memory tracker +
claude_code 后端,零凭证)。直接用它跳到 §4 即可。下面是要点摘录,便于快速看
结构(**完整内容以文件为准**,文件里每个键都有注释说明为什么这么设):

```yaml
---
tracker:
  kind: memory
  seed_issues:
    - id: local-1
      identifier: LOCAL-1
      title: Claude Code backend smoke
      description: Create a file named hello.md containing a one-line greeting.
      state: In Progress          # 验收时手改这里(见 §6)
      url: https://example.test/LOCAL-1
polling:
  interval_ms: 2000
workspace:
  root: /tmp/symphony-workspaces
agent:
  backend: claude_code
  max_concurrent_agents: 1
  max_turns: 2                   # 2 便于验收多轮续跑;想最快跑通就设 1
claude_code:
  permission_mode: bypass
  read_timeout_ms: 30000         # 默认 5s 对真实 CLI 冷启动偏紧,放宽到 30s
  # model: claude-sonnet-5       # 可选;省略用 CLI 默认
hooks:
  before_run: "git init . >/dev/null 2>&1 || true"
observability:
  dashboard_enabled: true
---
你在 {{ issue.identifier }} 的独立工作区中工作。任务:{{ issue.description }}
完成后停止,不要做额外的事。
```

## 4. 启动

```bash
cd typescript
bun run start \
  --i-understand-that-this-will-be-running-without-the-usual-guardrails \
  --port 4000 ./WORKFLOW.md
```

三个观察面:终端状态面板(dashboard_enabled)、`http://localhost:4000`
(web dashboard)、`curl -s localhost:4000/api/v1/state | jq`(JSON 快照)。

## 5. 验收清单

### A 组 — 核心路径(必须全过)

按时间顺序观察,勾完 A 组即可认为后端可用:

- [ ] **A1 派发**:日志出现 `Starting agent run for issue_id=local-1 ... worker_host=local`;
- [ ] **A2 工作区**:`/tmp/symphony-workspaces/LOCAL-1/` 被创建,且 before_run
      的 `git init` 已生效(目录里有 `.git`);
- [ ] **A3 进程**:`ps aux | grep "claude -p"` 能看到长驻 CLI 进程,参数含
      `--input-format stream-json`、`--permission-mode bypassPermissions`、
      `--mcp-config`(memory tracker 无 agent 工具,MCP 桥为空列表,但参数照常);
- [ ] **A4 会话**:面板 Running 行出现;PID 列为 claude 进程 pid;
      `last_event` 走到 `session_started`,session id 形如 `<uuid>-1`
      (**`-1` 后缀是验收点**:每 turn 派生唯一 id);
- [ ] **A5 流事件**:`last_event` 随后在 `notification` 间变化(assistant 流);
- [ ] **A6 turn 完成**:`last_event` 到 `turn_completed`;日志
      `Completed agent run ... session_id=<uuid>-1 ... turn=1/2`;
- [ ] **A7 token 计量**:面板 tokens 列 > 0;`/api/v1/state` 里该 issue 的
      `tokens.input_tokens/output_tokens/total_tokens` 一致且**只增不减**;
- [ ] **A8 产物**:`/tmp/symphony-workspaces/LOCAL-1/hello.md` 存在且内容合理;
- [ ] **A9 多轮续跑**(max_turns: 2 时):issue 仍是 In Progress,日志出现
      `Continuing agent run ... turn=1/2`,随后 session id 变为 `<uuid>-2`
      **但 claude 进程 PID 不变**(同进程续聊 = multiTurnSessions 生效),
      tokens 继续累计;
- [ ] **A10 正常收束**:一次 run 自然结束(turn 跑完 / issue 转 terminal)后,
      `ps aux | grep "claude -p"` **无残留**——`stopSession` 在 runner 的
      `finally` 里关闭了 CLI 进程与 MCP 桥。这是本项要验的点。

> ⚠️ **中途 Ctrl-C 是另一回事,不要拿它当验收失败**:`main()` 收到
> SIGINT/SIGTERM 后直接 `process.exit`,入口点**不做** teardown
> (`src/cli.ts` 的 `wait_for_shutdown` 注释明确写了这一点),所以在 run
> 进行中强杀 Symphony,`claude` 子进程可能残留。这是既有行为,codex 后端
> 同样如此,与本次插件化无关。中途强杀后手动确认并清理:
> `pkill -f "claude -p"`。

### B 组 — 状态流转与阻塞路径(建议验)

- [ ] **B1 完成流转**:run 进行中(或两轮打满、orchestrator 重派发前)编辑
      WORKFLOW.md,把 seed 的 `state: In Progress` 改为 `state: Done`。
      memory tracker **每次读取都重新解析文件**,下一次状态刷新即生效:
      运行中的 run 在当前 turn 结束后正常收束(不再续跑),面板 Running 清空,
      issue 不再被派发;
- [ ] **B2 阻塞路径**:把 `permission_mode` 改为 `default`、prompt 改为
      "运行 `ls -la` 并汇报输出"、seed state 改回 `In Progress` 重启。
      headless 下 Bash 权限被拒 → `result.permission_denials` 非空 →
      面板/`/api/v1/state` 中 issue 进入 **blocked**,blocker 文案为
      approval 类;**且 tokens 仍被计入**(失败 turn 的 usage 不丢,这是
      PR #11 评审修复的验收点);
- [ ] **B3 兜底语义**:B2 状态下 rate-limit 区显示 n/a / unavailable
      (claude 无此遥测,属预期,不是 bug)。

### C 组 — 真实 tracker + 工具桥(接生产前验)

把 `tracker` 换成 `linear`(带 `LINEAR_API_KEY`)或 `lark`/`lark_task`,
其余不动:

- [ ] **C1 工具桥**:prompt 里要求 agent 用 `linear_graphql`(或 `lark_api`)
      查询/回写 tracker;观察 `last_event` 出现 `tool_call_completed`,
      tracker 侧真实生效——这验证 ToolProvider → MCP-over-HTTP 桥端到端;
- [ ] **C2 状态回写**:agent 按 prompt 把 issue 移到 Done,orchestrator
      对账后 run 收束。

## 6. 状态流转的原理(为什么改文件就生效)

memory tracker 的 `seed_issues` 不是启动时快照:Symphony 每次 tracker 操作
都重新解析 WORKFLOW.md(插件契约的 per-call resolution),所以编辑文件里的
`state` 字段等价于在真实 tracker 里拖卡片。默认状态词汇:active =
`Todo` / `In Progress`,terminal 含 `Done` / `Closed` / `Cancelled`。

## 7. 排障

| 现象 | 原因与处置 |
|---|---|
| turn 立即以 `turn_timeout` 失败,无任何 claude 输出 | CLI 冷启动超过 init 等待。确认 `claude_code.read_timeout_ms: 30000` 生效;手跑 `time claude -p "hi"` 看真实启动耗时 |
| `port_exit` + 无 init | CLI 未登录/无 key:工作区目录里手跑 `bash -lc 'claude -p "hi"'` 复现认证报错 |
| 启动即配置错误 `unsupported agent backend` | `agent.backend` 拼写(注意是 `claude_code` 下划线);或跑在了没合并的旧分支上 |
| `invalid_workspace_cwd` | 工作区路径逃逸出 `workspace.root`,或 root 指到了不可读的位置(root 本身不必预先存在——会被自动创建) |
| CLI flags 报 unknown option | CLI 版本与 2.1.218 差异。参数拼装集中在 `plugins/agents/claude-code/client.ts` 的 `buildCommand`,对照 `claude --help` 调整该函数即可 |
| tokens 一直为 0 | 确认事件已到 `turn_completed`(usage 随终态事件上报);若终态已过仍为 0,`curl /api/v1/state` 把该 issue 的原始条目发去排查 |
| rate-limit 区 n/a | 预期行为(claude 无 rate-limit 遥测),非故障 |

## 8. 清理

```bash
pkill -f "claude -p" || true      # 只有中途强杀过 Symphony 才需要(见 A10)
rm -rf /tmp/symphony-workspaces
```

`bypass` 模式给了 agent 工作区内的全部行动力——验收永远用一次性目录,
不要把 `workspace.root` 指向真实项目的父目录。
