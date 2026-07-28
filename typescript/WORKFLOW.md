---
# Symphony 本地运行配置(memory tracker + Claude Code 后端)
#
# 零凭证:工作项直接来自下面的 `seed_issues`,不连 Linear/Lark,不发网络请求。
# 只需要一个已登录的 Claude Code CLI。启动:
#
#   cd typescript
#   bun run start \
#     --i-understand-that-this-will-be-running-without-the-usual-guardrails \
#     --port 4000 ./WORKFLOW.md
#
# 验收清单见 ../docs/CLAUDE_CODE_LOCAL_ACCEPTANCE.md。
# 想换回 codex 后端:把 agent.backend 改成 codex(或整行删掉,codex 是默认),
# 并把下面的 claude_code 段换成 codex 段。

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
  backend: claude_code
  max_concurrent_agents: 1
  # 2 便于观察多轮续跑(同一 CLI 进程续聊);想最快跑完就设 1。
  max_turns: 2

claude_code:
  # bypass:工具全自动放行,适合无人值守。改成 default 时,headless 下被拒的
  # 权限会让 issue 进入 blocked(见验收文档 B2)。
  permission_mode: bypass
  # 默认 5000 是照搬 codex 的,对真实 CLI 冷启动偏紧,这里放宽。
  read_timeout_ms: 30000
  # command: claude          # 默认 "claude";CLI 不在 PATH 时改这里
  # model: claude-sonnet-5   # 省略则用 CLI 默认模型

hooks:
  # 真实项目这里换成 `git clone <repo> .`;memory 冒烟只需要一个 git 仓库骨架。
  before_run: "git init . >/dev/null 2>&1 || true"

observability:
  dashboard_enabled: true
---
你在 {{ issue.identifier }} 的独立工作区中工作,当前工作目录就是这个 issue 的工作区。

任务:{{ issue.title }}

{{ issue.description }}
{% if attempt %}
这是第 {{ attempt }} 次尝试,之前的尝试没有完成任务。
{% endif %}
完成后停止,不要做任务之外的改动。
