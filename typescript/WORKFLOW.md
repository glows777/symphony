---
# Symphony 运行配置(Linear tracker + Codex 后端)
#
# 这份文件是仓库自己的运行配置:Symphony 从 Linear 项目取工作项,为每个 issue
# 建独立工作区,在里面跑 codex app-server,直到 issue 离开活跃状态。
#
# 只需要一个环境变量,就是那把密钥:
#
#   export LINEAR_API_KEY=lin_api_...
#
# 也可以写进 `typescript/.env`(已被 .gitignore 忽略),Bun 会自动加载它 ——
# 但 Bun 是按**当前工作目录**找 .env 的,所以必须先 cd 进 typescript 再启动,
# 从仓库根目录跑 `bun run typescript/src/cli.ts` 读不到,而且不报错、只是安静地
# 变成 missing_linear_api_token。
#
# 启动:
#
#   cd typescript
#   bun run start \
#     --i-understand-that-this-will-be-running-without-the-usual-guardrails \
#     --port 4000 ./WORKFLOW.md
#
# 仓库地址和工作区路径都写成字面值了(见 workspace.root / after_create):它们不是
# 密钥,写在文件里反而能一眼看出这份配置服务于哪个仓库;工作区路径更是必须写死
# —— 见 codex.turn_sandbox_policy 上的说明。
#
# 不带凭证的本地冒烟(memory tracker,原来这个文件的内容)搬到了
# `examples/local.workflow.md`,验收流程见 ../docs/CLAUDE_CODE_LOCAL_ACCEPTANCE.md。
# `examples/smoke.workflow.md` 是 `bun run verify` 用的 fixture,不要拿来跑真活。
#
# 本文件会被提交进仓库,所以密钥一律走环境变量,不要写字面值。

tracker:
  kind: linear

  # 取值顺序:字面值 -> "$VAR" 展开 -> $LINEAR_API_KEY 兜底。
  # 保持 "$VAR" 形式,提交进仓库的文件里就不会有密钥。
  api_key: $LINEAR_API_KEY

  # ⚠️ 只接受字面值,**不做** "$VAR" 展开(和 api_key 不同)。
  # 从项目 URL 对应的 Linear project.slugId 里取。
  # 当前项目 URL:https://linear.app/glows777/project/symphony-self-f61a905eedf7/overview
  project_slug: f61a905eedf7

  # "me" = 用这把 key 自己的用户(内部走 `viewer { id }` 查),这是给 Symphony
  # 配专用 bot 账号时的标准写法;也可以填字面的 Linear user id。
  # 不写则回退 $LINEAR_ASSIGNEE;两者都解析不出来时**指派过滤直接关闭**,
  # 项目里每一张处于活跃状态的卡都会被派发 —— 先开着。
  assignee: me

  # 指派过滤之上再加一道:issue 必须带齐这里的每个标签才会被派发(比较时转小写)。
  # 这是最省事的急停开关 —— 摘掉标签就能把一张卡收回来。
  required_labels:
    - symphony

  # 会被派发 agent 的状态。保持精简:列在这里的每个状态都可能凭空起一个 agent。
  active_states:
    - Todo
    - In Progress

  # "Symphony 到此为止" 的状态:停掉 agent,跑 before_remove,删掉工作区。
  #
  # 注意这里**故意没有** "In Review"。既不在活跃列表也不在终止列表的状态是
  # **停车位**:Symphony 不再派发,但工作区和分支都留着 —— 这正是人类 review
  # PR 期间需要的状态。只有当你能接受"agent 一开 PR 工作区就被删",才把
  # In Review 挪到下面来。
  terminal_states:
    - Done
    - Cancelled
    - Canceled
    - Duplicate
    - Closed

review:
  # Review runs are explicitly opted into; ordinary symphony issues never call GitHub.
  trigger_label: symphony-review
  # owner/name of the repository whose PR is reviewed.
  repository: glows777/symphony
  # Defaults to symphony/<issue.identifier>; keep this aligned with the PR branch.
  head_branch: symphony/{{ issue.identifier }}
  github_api_url: https://api.github.com
  # Keep the token out of git; Bun resolves this through the environment.
  github_token: $GITHUB_TOKEN
  # Fail-closed review runs remain active here for manual follow-up.
  manual_state: In Progress
  handoff_path: .symphony/review-handoff.json
  # System-owned evidence: run against a clean commit and bind the receipt to PR HEAD.
  verification_command: cd typescript && bun run check

polling:
  # Linear API 有限流,issue 也不会每秒变。30s 是默认值,共享项目下别再往下调。
  interval_ms: 30000

workspace:
  # 每个 issue 一个目录,名字是 sanitize 过的 issue identifier(如 ENG-123)。
  # 本地部署约定:工作区集中放在当前 Symphony 仓库的 runtime/ 下。
  # 必须可写,且这里的值要和 Codex 的 writableRoots 逐字一致。
  #
  # ⚠️ 这个值必须和下面 codex.turn_sandbox_policy.writableRoots 里的路径**逐字一致**。
  # 这里支持 "$VAR" 展开而那边不支持,所以两处都写字面值是唯一不会写岔的方案。
  # 写岔了的症状是 codex 在沙箱里报权限错,很难往配置上想。
  root: /Users/glows777/codes/xinze/symphony/runtime

agent:
  # 这份配置跑 Codex(也是默认值)。被选中的后端读同名的顶层配置段 —— 即下面的
  # `codex:` —— 所以那一段的设置是跟着这一行生效的。
  backend: codex

  # 并发 agent 上限。每个 agent = 一份完整 checkout + 一个 codex 进程,
  # 卡住这个数的是磁盘和内存,不是 Linear。
  max_concurrent_agents: 3

  # 按状态的细分上限,叠加在全局上限之上。让 todo 低于全局值,可以给人类已经
  # 拖到 In Progress 的卡留出余量。
  max_concurrent_agents_by_state:
    todo: 2
    in progress: 3

  # 一次 agent run 内的轮数。某一轮正常结束、但 issue 还停在活跃状态时,
  # Symphony 会喂一段续跑提示让它接着干(而不是从头重来),最多 max_turns 轮。
  # 这是"agent 干到一半就收工"最主要的调节旋钮。
  max_turns: 20

  # 后端无关的停滞预算:这么久没有后端事件就重启该 issue。
  # 省略则回退到 codex.stall_timeout_ms。
  stall_timeout_ms: 600000

  # 崩溃重试之间指数退避的封顶值。
  max_retry_backoff_ms: 300000

codex:
  # 二进制不在 PATH 时改这里。
  command: codex app-server

  # 无人值守下的两难:
  #   never       —— 全自动放行,agent 不会因为审批卡住(examples/local.workflow.md
  #                 用的就是这个,因为那是本地冒烟)。
  #   on-request  —— 需要审批时由 Symphony 捕捉并把 issue 标成 blocked。
  # 真实项目选 on-request:宁可停下来等人,也不要一个无人看管的 agent 自己放行。
  approval_policy: on-request

  thread_sandbox: workspace-write

  # ⚠️ 两个坑:
  #
  # 1. 这个 map 原样透传给 Codex,所以键是 camelCase(不是本文件其他地方的
  #    snake_case),而且这里的 "$VAR" **不展开** —— writableRoots 只能写字面
  #    绝对路径,且必须与上面的 workspace.root 逐字一致。
  # 2. Symphony 的内置默认值就是这个形状但 `networkAccess: false`,那样既装不了
  #    依赖也推不了分支。要 agent 开 PR 就必须显式覆盖。在沙箱里放开网络是一个
  #    真实的信任决策,所以 Symphony 让你手写出来,而不是默默继承。
  turn_sandbox_policy:
    type: workspaceWrite
    writableRoots:
      - /Users/glows777/codes/xinze/symphony/runtime
    readOnlyAccess:
      type: fullAccess
    networkAccess: true
    excludeTmpdirEnvVar: false
    excludeSlashTmp: false

  # 真实工单上单轮跑很久是正常的。
  turn_timeout_ms: 3600000

  # 单条 app-server 消息的读超时(线级)。
  read_timeout_ms: 5000

  # 后端级停滞预算;上面 agent.stall_timeout_ms 已设,这里是它的兜底值。
  stall_timeout_ms: 300000

hooks:
  # 对下面所有 hook 生效。after_create 要做一次完整 clone,给足时间。
  timeout_ms: 600000

  # Symphony 只负责创建工作区**目录**,克隆是这个 hook 的活。
  # 它通过 `sh -lc` 执行,工作目录就是该 issue 的工作区,且只在首次创建时跑一次
  # (重新派发会复用已有的 clone)。
  #
  # hook 环境里**不会注入任何 issue 变量**。但工作区目录名就是 sanitize 后的
  # issue identifier,所以 `basename "$PWD"` 是取回它的唯一办法。
  after_create: |
    set -eu
    git clone --filter=blob:none git@github.com:glows777/symphony.git .
    git switch -c "symphony/$(basename "$PWD")"

  # 每次尝试前都跑(含重试和重新派发),所以必须幂等且快。非零退出会让本次尝试
  # 失败 —— 这正是要的:工具链坏了就别浪费 agent 轮数。
  # 换成你项目的安装/引导命令。
  before_run: |
    set -eu
    git fetch --prune origin
    cd typescript
    bun install --frozen-lockfile

  # 每次尝试后都跑。这里的失败只记日志、不影响流程,所以只适合放观测,不适合做闸门。
  after_run: |
    set -eu
    git --no-pager status --short
    git --no-pager log --oneline origin/HEAD..HEAD || true

  # 工作区被删除前(issue 进入终止状态)的最后一步。把该分支上还开着的 PR 关掉,
  # 免得一张被取消的卡留下孤儿 PR。失败会被忽略。
  #
  # 和上面 "In Review 停车" 的设计是配套的:issue 走到 Done 时 PR 通常已经合并,
  # `--state open` 什么都匹配不到。
  before_remove: |
    set -eu
    branch="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || true)"
    [ -n "$branch" ] || exit 0
    gh pr list --head "$branch" --state open --json number --jq '.[].number' |
      while IFS= read -r number; do
        [ -n "$number" ] && gh pr close "$number"
      done

observability:
  dashboard_enabled: true
  refresh_ms: 1000
  render_interval_ms: 16
  # summary (default), off, or raw. raw keeps bounded payload/raw protocol data in JSONL.
  # agent_output: raw

server:
  # HTTP API + web dashboard,绑在回环地址上。要外部访问自己套隧道或反代。
  # CLI 的 --port 会覆盖这里。
  port: 4000
  host: 127.0.0.1
  # 只有明确接受未认证 API 暴露风险时才打开。
  # unsafe_allow_remote: true
---

你是一名自主工程师,独立负责一张 Linear issue,在一个专属于它的 git 检出里工作。

## 工单

- 编号:{{ issue.identifier }}
- 标题:{{ issue.title }}
- 链接:{{ issue.url }}
- 当前状态:{{ issue.state }}
- 优先级:{{ issue.priority }}
- 标签:{{ issue.labels | join: ", " }}
- Linear issue id(GraphQL 用):{{ issue.id }}
{% if issue.branch_name %}- Linear 建议的分支名:{{ issue.branch_name }}
{% endif %}
## 描述

{% if issue.description %}{{ issue.description }}{% else %}**这张卡没有写描述。** 不要猜范围。按下面「卡住了怎么办」执行:在 issue 上评论,
问清楚缺的是哪一条信息,然后停下。{% endif %}

{% if issue.blocked_by.size > 0 %}## 前置依赖

这张卡被标记为受阻于:
{% for blocker in issue.blocked_by %}
- {{ blocker.identifier }}(状态:{{ blocker.state }})
{% endfor %}

Symphony 不会派发前置未完成的 Todo 卡,所以你能读到这段说明前置**被认为**已经完
成。如果你自己检查下来并非如此,停下并上报,不要绕过它们硬做。

{% endif %}## 你的运行环境

- 当前工作目录是这个 issue 专属的仓库检出。它是你的,没有别人往里提交。
- 分支 `symphony/{{ issue.identifier }}` 已经切好了。
- 依赖已由 `before_run` hook 在本轮开始前装好。
- 你有网络,可以 fetch、push、用 `gh`。
- 你有一个 `linear_graphql` 工具,用 Symphony 的凭证对 Linear 执行任意 GraphQL。
  它是你回到 tracker 的**唯一**通道。

## 完成的定义

以下全部满足,按顺序:

1. 改动实现完毕,且仓库自己的质量闸门在本地跑通。别在没跑过测试的情况下宣布完成。
2. 工作在 `symphony/{{ issue.identifier }}` 上以清晰的提交落盘,并推到 `origin`。
3. PR 已创建,描述说清楚改了什么、为什么,并链回 {{ issue.url }}。
4. 在 Linear issue 上评论,记录 PR 链接,以及 reviewer 需要知道的事(做过的取舍、
   有意没做的部分、后续待办)。
5. 把 Linear issue 移到 **In Review**。

第 5 步才是结束运行的动作。开工前先读下一节。

## 这一轮怎么才算结束(控制循环,别跳过)

Symphony 看的是 issue 的状态,不是你的输出:

- 只要 issue 还停在活跃状态({{ issue.state }} 就是其中之一),结束一轮**不等于**
  结束运行。Symphony 会给你一段续跑提示,你在同一个工作区里接着干。活没干完就收
  工,只是白白烧掉一轮,什么都不会改变。
- 把 issue 移到 **In Review** 是停车:Symphony 不再派发,但工作区和分支都留着,
  以便接住 review 反馈。
- 移到终止状态(Done、Cancelled……)等于告诉 Symphony 活干完了,工作区会被删除。

所以:完成的定义没满足之前,不要把 issue 移出活跃状态;满足了,就一定要移。

移动状态:先查目标状态的 id,再更新 issue。

```graphql
query FindState {
  workflowStates(filter: { name: { eq: "In Review" } }) {
    nodes { id name team { key } }
  }
}
```

```graphql
mutation MoveIssue($id: String!, $stateId: String!) {
  issueUpdate(id: $id, input: { stateId: $stateId }) { success }
}
```

变量填 `{"id": "{{ issue.id }}", "stateId": "<上面查到的 id>"}`。
如果匹配到多个状态,取 `team.key` 与本 issue 编号前缀一致的那个。

评论:

```graphql
mutation Comment($issueId: String!, $body: String!) {
  commentCreate(input: { issueId: $issueId, body: $body }) { success }
}
```

## 卡住了怎么办

卡住指:工单有歧义且不同理解会导致不同实现、需要一个不该由你拍板的决策、撞上凭证
或权限墙。**任务难不叫卡住。**

卡住时:

1. 在 issue 上评论,写出**具体**问题和你看到的几个选项 —— 不要只写"请澄清"。
2. 把 issue 移到 **Needs Info**。
3. 停下。不要为了交差而实现一个猜测。

## 硬性约束

- 待在这个工作区里,不要改动它以外的任何东西。
- 不要推默认分支,不要自己合自己的 PR。
- 不要动无关文件、不要重排没碰过的代码、不要升级工单没提到的依赖。可 review 的
  diff 本身就是交付物的一部分。
- 不要为了让 CI 变绿而弱化或跳过测试。一个揭示真实问题的失败测试是要上报的发现,
  不是要清除的障碍。
- 绝不把密钥写进仓库、PR 或 Linear 评论。
- 守住工单声明的范围。发现了相邻问题,先把本卡做完,再在 Linear 评论里列出来。
{% if attempt %}
## 重试上下文

这是第 {{ attempt }} 次尝试 —— 之前有一次运行没跑完就退出了,工作区里还留着那次
的状态。

写任何代码之前:先看清楚现在是什么局面(`git status`、`git log`、测试)。在它基础
上继续,而不是重来;如果上次失败的原因会重复出现,在 Linear 评论里说明并上报,不
要空转。
{% endif %}
