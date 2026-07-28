---
# Symphony 本地运行配置(memory tracker + Codex 后端)
#
# 零凭证:工作项直接来自下面的 `seed_issues`,不连 Linear/Lark,不发网络请求。
# 只需要一个可用的 `codex app-server`。启动:
#
#   cd typescript
#   bun run start \
#     --i-understand-that-this-will-be-running-without-the-usual-guardrails \
#     --port 4000 ./WORKFLOW.md
#
# 验收清单见 ../docs/CLAUDE_CODE_LOCAL_ACCEPTANCE.md(那份是按 claude_code 写的,
# 事件/会话语义两个后端一致,照着验即可)。
# 想换成 Claude Code 后端:把 agent.backend 改成 claude_code,并把下面的 codex 段
# 换成:
#
#   claude_code:
#     permission_mode: bypass     # 全自动放行;default 会让被拒的工具阻塞 issue
#     read_timeout_ms: 30000      # 真实 CLI 冷启动比 codex 慢

tracker:
  kind: memory
  # memory tracker 每次读取都重新解析本文件,所以改下面的 `state` 等价于在真实
  # tracker 里拖卡片:改成 Done 会让 issue 停止被派发(active 状态默认是
  # Todo / In Progress)。
  seed_issues:
    - id: local-1
      identifier: LOCAL-1
      title: Claude Code backend smoke
      description: |
        在当前工作区里创建 hello.md,写一句话说明这个工作区是什么。
        不要修改其他文件,完成后就停止。
      state: In Progress
      url: https://example.test/LOCAL-1

polling:
  interval_ms: 2000

workspace:
  # 每个 issue 的工作区是 <root>/<IDENTIFIER>,由 Symphony 自动创建(含父目录)。
  # 用一次性目录:bypass 模式下 agent 在工作区内有完整行动力。
  root: /tmp/symphony-workspaces

agent:
  # codex 是默认值,写出来是为了显式;删掉这一行行为不变。
  backend: codex
  max_concurrent_agents: 1
  # 2 便于观察多轮续跑(同一 app-server 线程续跑);想最快跑完就设 1。
  max_turns: 2
  # 后端无关的停滞预算:多久没有后端事件就重启该 issue。
  # 省略(或设 null)则回退到下面的 codex.stall_timeout_ms。
  # stall_timeout_ms: 900000

codex:
  # 默认就是 `codex app-server`;二进制不在 PATH 时改这里。
  command: codex app-server
  # never = 全自动放行,适合无人值守。默认策略会让每个需要审批的动作把 issue
  # 转入 blocked(见验收文档 B2 的等价场景)。
  approval_policy: never

hooks:
  # 真实项目这里换成 `git clone <repo> .`;memory 冒烟只需要一个 git 仓库骨架。
  before_run: "git init . >/dev/null 2>&1 || true"

observability:
  dashboard_enabled: true
  agent_output: raw
---
你在 {{ issue.identifier }} 的独立工作区中工作,当前工作目录就是这个 issue 的工作区。

任务:{{ issue.title }}

{{ issue.description }}
{% if attempt %}
这是第 {{ attempt }} 次尝试,之前的尝试没有完成任务。
{% endif %}
完成后停止,不要做任务之外的改动。
