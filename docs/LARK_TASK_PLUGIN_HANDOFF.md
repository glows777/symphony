# Lark 任务中心(Task v2)Tracker 插件 — Handoff

> 目标读者:实现 `kind: "lark-task"` 插件的下一个 Claude session。开工前先按顺序
> 通读:本文 → [`PLUGIN_CONTRACT.md`](./PLUGIN_CONTRACT.md)(插件契约,规范性,逐条满足)
> → 现有 [`LARK_PLUGIN_HANDOFF.md`](./LARK_PLUGIN_HANDOFF.md)(Bitable 版的调研背景)
> → 现有实现 `typescript/src/symphony/plugins/lark/`(大量可复用代码,见 §5)。

## 0. 一句话任务

Symphony 已有一个基于**多维表格(Bitable)**的 Lark tracker 插件(`kind: "lark"`)。
本任务是**新增一个平行插件 `kind: "lark-task"`**,改用飞书**任务中心(Task v2)**
作为工作源。**不改动、不替换现有 `lark` 插件**——插件契约就是为并存设计的,两者
通过 `tracker.kind` 各自被解析。

## 1. 为什么做这个 / 取舍已经想清楚了

先读结论,别重复调研:Bitable 版 handoff §1 当初否掉 Task v2 的理由是「状态是
完成/未完成二值 + 列表无服务端自定义字段过滤」。经复核,这个判断**一半可绕、
一半是真代价**:

- **二值状态可绕**:不要用 `completed` 布尔当 `state`。把 state 映射到**清单分组
  (section)** 或**单选自定义字段**,词汇表 = section 名 / 选项名。契约 §3.1 明确
  允许「Tools without a native state machine project one」。这样就是完整多档状态机,
  和 Bitable 用单选字段承载词汇表是同一套路。
- **Task v2 反而在两处比 Bitable 版更全**:
  - `comments` ✅ — Task v2 有**原生评论 API**;Bitable 版这个 capability 是缺的
    (记录级评论无公开接口)。
  - `blockedBy` — Task v2 有**任务依赖**能力;Bitable v1 直接置空放弃了。
- **真正的代价(效率/健壮性,不是功能缺失)**:
  1. **无服务端状态过滤** → `fetchCandidateIssues` / `fetchIssuesByStates` 只能拉回
     清单再客户端筛。
  2. **可能无 batch_get** → `fetchIssueStatesByIds`(对账循环骨架、调用最频繁)可能
     退化成逐个 get task,请求数放大,频控风险高。
  3. **状态写回更绕** → 若用 section 建模,「改状态」= 移动任务到另一 section,
     是另一套 API 形状。

**决策指引**:若目标是「任务中心里的多阶段看板 + 想要原生评论/依赖」,值得做;
若是「高频轮询、海量任务、追求低请求数」,Bitable 版更合适。两者并存,让 workflow
作者按 `kind` 选。

## 2. ⚠️ 开工第一步:先坐实 API 事实(文档站挡爬虫,必须现场核实)

飞书开放平台文档站对爬虫返回 403,**下面这些点我无法在 handoff 阶段替你确认,
你必须用浏览器 / 真实 API 调用逐条坐实,并把结论固化进测试**。这是本任务成败的关键——
状态建模方式(section vs custom field)完全取决于第 3、4 条的答案。

Task v2 概览:https://open.feishu.cn/document/task-v2/task/overview

| # | 必须确认的问题 | 影响 |
|---|---|---|
| 1 | **list tasks 端点**的确切路径、查询参数、分页模型(`page_size`/`page_token`)。支持按 tasklist / section / 完成态 / 时间范围 / 负责人过滤到什么粒度? | 决定三个读操作怎么实现 |
| 2 | list tasks **是否支持服务端按自定义字段值过滤**?(Bitable 版 handoff 说「无」,请复核) | 若支持,读操作可大幅简化;若不支持,确认客户端筛 |
| 3 | **section(清单分组)**:能否列出一个 tasklist 的 sections、能否列出「某 section 下的任务」、能否「移动任务到指定 section」? | 决定能否用 section 当状态机 |
| 4 | **自定义字段(custom fields)**:tasklist 是否支持单选类型自定义字段?能否读取任务上的字段值、能否更新? | section 的替代方案 |
| 5 | **是否有 batch-get**(一次按多个 task guid 取任务)?单次上限多少? | 决定 `fetchIssueStatesByIds` 是批量还是 N 次 get |
| 6 | **get task** 单个端点路径;返回体里有没有 section 归属、custom field 值、`members`、`completed_at`、`created_at`/`updated_at`、依赖关系? | 决定 `normalizeTask` 能映射哪些 WorkItem 字段 |
| 7 | **comments**:创建评论端点(`resource_type`/`resource_id` 怎么指向一个 task) | `comments` capability |
| 8 | **依赖(dependencies)**:读取任务的前置依赖端点 | `blockedBy` 能否映射 |
| 9 | **鉴权**:确认 Task v2 也用 `tenant_access_token`(应几乎肯定是),以及应用需要
     开通的权限范围(task 读写 scope 名) | 复用现有 token 层;文档里写清 scope |
| 10 | **频控 QPS**:list / get 的频率上限 | 决定轮询下的请求预算,429 → `provider_status` 跳过本 tick |

> 把每条结论写成注释或测试常量,别让下一个人再猜。

## 3. 状态机建模:两个方案,先定这个再动手

这是整个插件的第一个分叉,**动手前必须定**:

### 方案 A:section(清单分组)= 状态列
- `state` ← 任务所属 section 的名字;词汇表 = tasklist 的 section 名集合。
- `fetchCandidateIssues` ← 列 active section 下的任务(若支持按 section 列)。
- `stateUpdates` ← 移动任务到目标 section。
- 优点:语义最像看板列;缺点:依赖 §2.3 的三个 section 能力全部为真。

### 方案 B:单选自定义字段 = 状态
- `state` ← 任务上某个单选自定义字段值(默认字段名如 `"Status"`,可配置)。
- `stateUpdates` ← 更新该自定义字段。
- 优点:和 Bitable 版建模几乎同构,`normalize`/filter 逻辑可类比迁移;缺点:依赖
  §2.4 自定义字段读写为真,且列表大概率无服务端过滤 → 客户端筛。

> 建议:先按 §2 核实结果选一个作为 v1,另一个记为 v2 开放项。**不要两个都做。**
> 配置里留一个 `state_source: "section" | "custom_field"` 之类的开关是过度设计,v1 只做一种。

## 4. WorkItem 字段映射(默认字段名全部可在 WORKFLOW.md 覆盖)

参照契约 §3 与 Bitable 版映射表。缺省优雅降级(契约允许):

| WorkItem | Task v2 来源 | 说明 |
|---|---|---|
| `id` | 任务 `guid` | 必选;orchestrator 的 map key |
| `identifier` | 配置的编号字段,缺省回退 `guid` | 必选;须经 workspace `safeIdentifier` 消毒后唯一 |
| `title` | 任务 `summary` | 必选 |
| `state` | **section 名** 或 **单选自定义字段值**(见 §3) | 必选;词汇表见 §3 |
| `description` | 任务 `description` | 可选 |
| `labels` | 多选自定义字段(若建模) | 可选;trim + 小写归一化(契约要求) |
| `assigneeId` / `assignedToWorker` | 任务 `members`(role=assignee 的 open_id);`tracker.assignee` 配 open_id 时过滤 | 可选;v1 不支持 `"me"`(应用无 viewer),照抄 Bitable 版语义 |
| `priority` | 数字/单选自定义字段(默认无) | 可选,非整数置 null |
| `createdAt` / `updatedAt` | 任务 `created_at` / `updated_at`(核实字段名与单位) | 可选 |
| `url` | 任务在飞书里的详情链接(核实 URL 拼法) | 可选 |
| `blockedBy` | 任务依赖(前置任务的 guid/state) | v1 可先置空 `[]` 降级(契约允许),依赖 API 确认后再补 |
| `metadata` | `{ tasklist_guid, task_guid, section_guid? }` | 供模板 `issue.metadata.*` |

**硬规则**(契约 §3):每个返回项**必须经 `newWorkItem(...)` 盖章**,否则被
`isWorkItem` 过滤掉静默丢弃。labels trim+小写,state 原样保留大小写。

## 5. 最大化复用现有 lark 插件的通用层(重要,别复制粘贴)

现有 `plugins/lark/client.ts` 里有一部分是**与 Bitable 无关的 Lark 通用层**,
`lark-task` 应当复用而非重写:

- **`tenant_access_token` 生命周期**(`client.ts:181-223`):模块级缓存 `{token, expiresAt}`、
  5 分钟刷新余量、401/失效码清缓存重试一次。Task v2 同样用 tenant token,**逻辑完全一样**。
- **`request()` 认证请求层**(`client.ts:123-177`):拼 endpoint+path、注入 Bearer、
  判定 HTTP 2xx 且 Lark 业务 `code === 0`、`decodeLarkBody`。**与资源无关,可直接复用。**
- **`lark_api` 动态工具**(`api-tool.ts` 全文):路径只校验 `/open-apis/` 前缀,
  host 恒为配置 endpoint。**它对 Task v2 路径同样适用**,一字不用改。

**建议做法**:开工时先做一次**小重构**,把上述通用层从 `plugins/lark/client.ts`
抽到共享位置(如 `plugins/lark/shared.ts` 或新目录 `plugins/lark-common/`),
让 `lark` 与 `lark-task` 两个插件共享 token 缓存 + `request()` + `lark_api` 工具。
`lark-task/client.ts` 只写 **Task v2 专属**部分:list/get/更新 的路径与 body、
`normalizeTask`。

> 注意:token 缓存是**模块级 let 变量**。若两插件共享同一份缓存,`test-support.ts`
> 的 `teardownWorkflow` 里已有的重置(契约 §8 提到会重置 lark token 缓存)要覆盖到
> 共享模块;若各自独立缓存,则两处都要在 teardown 里清。**开工前想清缓存的归属。**

如果重构风险评估下来太大(动了现有插件的测试),退而求其次:`lark-task` 自建一份
薄薄的 token+request 层,但**必须在 PR 描述里显式登记这处重复**,方便后续收敛。

## 6. 配置(WORKFLOW.md `tracker` 段,扁平键,由 `lark-task` 插件的 configSchema 认领)

核心 `tracker` 段只拥有四个键(契约 §7):`kind` / `required_labels` /
`active_states` / `terminal_states`。其余键归本插件。示例(字段名以 §3 选定的
建模方案为准):

```yaml
tracker:
  kind: "lark-task"
  endpoint: "https://open.feishu.cn"       # 默认;Lark 国际版 https://open.larksuite.com
  app_id: "cli_xxx"                        # 必填
  app_secret: "$LARK_APP_SECRET"           # 必填,$VAR 引用;canonical env 复用 LARK_APP_SECRET
  tasklist_guid: "xxx"                     # 必填,一个 tasklist = 一个看板
  assignee: null                           # 可选,open_id(不支持 "me")
  # —— 方案 A(section 建模)不需要额外字段名;state 直接读 section 名
  # —— 方案 B(自定义字段建模)才需要下面这些:
  field_state: "Status"                    # 单选自定义字段名
  field_priority: null
  field_labels: null
  field_identifier: null                   # null → 回退 guid
  active_states: ["Todo", "In Progress"]   # 核心键,与 section 名 / 选项名匹配
  terminal_states: ["Done", "Cancelled"]
```

- **canonical env 复用 `LARK_APP_SECRET`**:`finalize` 走
  `resolveSecretSetting(value, envOrNull("LARK_APP_SECRET"))`,必须用
  `plugins/config-helpers.ts` 的共享 helper(与 Bitable 版一致,`$VAR` 语义统一)。
  这样跑 lark-task **唯一必须的环境变量仍是 `LARK_APP_SECRET`**,其余都在 WORKFLOW.md。
- `validate` 语义门(错误须带 `code` + `message`,遵守 TrackerError 契约):
  缺 `app_id`/`app_secret` → tag `missing_lark_task_credentials`(code `missing_credentials`);
  缺 `tasklist_guid` → tag `missing_lark_task_tasklist`(code `missing_config`)。
- `cast` 必须**同步且纯**(settings 每次读都 re-parse),错误用
  `"tracker.<key> <message>"` 约定合并进 `invalid_workflow_config`。

## 7. capability 取舍(诚实选,别用 no-op 假装)

| capability | 取舍 | 依据 |
|---|---|---|
| 三个读操作 | 必做 | 契约 REQUIRED;§2 核实后按 §3 方案实现 |
| `stateUpdates` | ✅ | 移动 section(方案 A)/ 更新自定义字段(方案 B) |
| `comments` | ✅(**这是相对 Bitable 版的增量**) | Task v2 原生评论 API;核实 §2.7 |
| `agentTools` | ✅ 复用 `lark_api`(§5) | 与资源无关,直接挂上 |
| `ui` | ✅ | `projectUrl` → tasklist 链接;`workItemNoun: "Lark task"`;无插件 prompt 模板即回退通用 |
| `blockedBy` 映射 | v1 可空,v2 补 | 契约允许空 `blockedBy` 禁用阻塞门控 |

**禁止用 no-op 假装成功**:缺的 capability 直接不实现,门面会返回结构化的
`tracker_capability_unsupported` / `unsupported_operation`(契约 §5),这是设计好的降级。

## 8. 错误 tag 约定(全走 TrackerError 形状,契约 §6)

复用 Bitable 版的分类,tag 前缀换成 `lark_task_*` 以便区分(core 只 switch `code`,
不 switch tag,所以 tag 可自定义):

- `lark_task_api_status`(code `provider_status`,带 `status`)
- `lark_task_api_error`(code `provider_error`,带 Lark 业务 `code`/`msg`)
- `lark_task_api_request`(code `transport_failed`)
- `lark_task_unknown_payload`(code `invalid_payload`)
- `missing_lark_task_credentials` / `missing_lark_task_tasklist`(见 §6)

外来错误(注入 seam)一律 `toTrackerError` 归一化(契约 §6)。

## 9. 文件布局与实施步骤(每步 `cd typescript && bun run check` 绿)

```
typescript/src/symphony/plugins/
  lark/                         # 现有 Bitable 插件;§5 抽通用层时可能新增 shared.ts
  lark-task/
    plugin.ts                   # LarkTaskPlugin 聚合(configSchema + 3 reads + stateUpdates + comments + agentTools + ui)
    settings.ts                 # LarkTaskSettings 窄化(照 lark/settings.ts)
    client.ts                   # Task v2 专属:list/get/更新、normalizeTask(token+request 复用 §5 共享层)
    # api-tool.ts               # 若 §5 抽出共享 lark_api,则无需新建;否则薄封装复用
typescript/test/symphony/plugins/lark-task/
    client.test.ts              # normalizeTask、分页、状态过滤(客户端/服务端按 §2 结果)、token 复用(注入 fake requestFun)
    plugin.test.ts              # configSchema cast/finalize/validate、capability 面、经 Tracker 门面端到端(fake client)
```

步骤:

1. **先做 §2 的 API 核实**,定 §3 方案。结论写进代码常量/注释。
2. (可选但推荐)§5 通用层重构:抽 token+request+lark_api 到共享模块,保证现有
   `lark` 插件测试仍绿。
3. `settings.ts` + `configSchema`(cast/finalize/validate)+ 注册进
   `plugins/index.ts`(`registerTrackerPlugin(LarkTaskPlugin)`)+ config 测试
   (kind `"lark-task"` 不再 unsupported)。加 app-env 注入 seam `lark_task_client_module`
   (照 `lark_client_module`),并在 `test/support/test-support.ts` teardown 里清理。
4. `client.ts`:三个读操作 + `normalizeTask`(**全部经 `newWorkItem` 盖章**,labels
   trim+小写,state 原样)。按 §2.5 结果决定 `fetchIssueStatesByIds` 是批量还是循环 get。
5. `stateUpdates` + `comments` + `ui`。
6. `agentTools` 挂 `lark_api`(dynamic-tool 分发器零改动,验证 kind=lark-task 时广播工具)。
7. 文档:`docs/PLUGIN_CONTRACT.md` §9 增加 `lark-task` 小节;`typescript/MIGRATION.md`
   "Post-cutover divergence" 登记新插件;README 一句话提及。

## 10. 测试要求(全部注入 fake,不打真实网络)

- 契约三读语义;`fetchIssueStatesByIds` 必须返回**新鲜的 `state`**(对账循环骨架)。
- capability 缺失时门面返回 `tracker_capability_unsupported`(对没实现的 capability)。
- token 过期刷新 + 401 清缓存重试一次(若复用共享层,验证共享缓存的 teardown 生效)。
- 分页(>1 页)、按状态过滤的构造(方案 A/B 各自路径)、`fetchIssueStatesByIds` 的
  批量/循环上限。
- configSchema 三钩子(cast 非法值报 `tracker.<key> ...`、finalize 解析 `$LARK_APP_SECRET`、
  validate 缺 tasklist 报错)。
- `lark_api` 工具成功/业务错误/参数错误路径(若复用现有工具,补一条 kind=lark-task
  下工具被广播的断言即可)。
- **不改 SPEC.md;不改任何 wire name(Liquid `issue.*` 等);核心 `Settings` 不得出现
  lark-task 专属字段。**

## 11. 验收门

- `cd typescript && bun run check`(typecheck + biome + 全量测试)绿;
  `bun run verify` 过(跑 memory 插件,验证没破坏核心)。
- 交付:开发在指定分支,PR 描述按 `.github/pull_request_template.md`。
- **不得改动现有 `lark` 插件的对外行为**(§5 若重构通用层,现有测试必须仍绿)。

## 12. 已知风险 / 开放项

1. **§2 未核实项是最大不确定源**——尤其「有无服务端过滤」「有无 batch_get」直接决定
   读操作的请求数与频控风险。先核实再动手。
2. **频控**:Task v2 若无 batch_get,`fetchIssueStatesByIds` 逐个 get 会放大请求数;
   429 映射为 `lark_task_api_status` 让 orchestrator 按既有行为跳过本 tick。
3. **section vs 自定义字段**:v1 只做一种(§3),另一种记为 v2。别做成可配开关。
4. **token 缓存归属**:§5 共享 vs 独立,teardown 清理位置要对应,否则测试间串味。
5. **`blockedBy`**:依赖 API 确认后再补;v1 空数组降级(契约允许)。
6. **`assignee: "me"`**:应用身份无 viewer,v1 不支持,配置文档写明只收 open_id。
</content>
</invoke>

---

## 附录:§2 核实结论(实现时填写,2026-07-13)

文档站(open.feishu.cn / open.larksuite.com)对本环境的抓取仍返回 403;改用
**官方 SDK `@larksuiteoapi/node-sdk` 1.70.0 的生成代码**作为可核查事实源
(每个端点的路径、HTTP 方法、参数与响应类型都由官方从 API 定义生成)。逐条对应 §2:

| # | 结论 |
|---|---|
| 1 | `GET /open-apis/task/v2/tasklists/{guid}/tasks`,参数 `page_size`/`page_token`/`completed`/`created_from`/`created_to`/`user_id_type`。**响应是任务摘要**(`guid`/`summary`/`completed_at`/`start`/`due`/`members`/`subtask_count`),无 description/url/时间戳/自定义字段/section 归属 |
| 2 | **无服务端自定义字段过滤**(仅 `completed` 与创建时间范围),复核成立 |
| 3 | section 三能力**全部存在**:`GET /sections?resource_type=tasklist&resource_id=`(列分组,含 `is_default`)、`GET /sections/{guid}/tasks`(列分组任务)、`POST /tasks/{guid}/add_tasklist` 带 `section_guid`(移动分组) |
| 4 | 自定义字段存在(`GET /custom_fields` 给出定义与单选 options 的 guid/name;任务详情带值;`PATCH /tasks/{guid}` 可写)。但**列表接口不返回字段值**,用它建状态机会退化为全表逐个 detail get |
| 5 | **无 batch-get**。`fetchIssueStatesByIds` = 每 id 一次 `GET /tasks/{guid}` |
| 6 | `GET /tasks/{guid}` 返回完整任务:`description`、`members`(role=assignee/follower)、`completed_at`、`tasklists: [{tasklist_guid, section_guid}]`(section 归属)、`created_at`/`updated_at`(毫秒字符串)、`status`、`url`、`custom_fields`、`dependencies` |
| 7 | `POST /open-apis/task/v2/comments`,body `{content, resource_type: "task", resource_id}` ✅ |
| 8 | 依赖读写存在(任务详情 `dependencies` + `add/remove_dependencies`);v1 仍按计划置空 `blockedBy`,记 v2 开放项 |
| 9 | Task v2 与 Bitable 同用 `tenant_access_token`(SDK 单一 token 管理器)。**具体 scope 名未能离线核实**——部署时按开发者后台/API Explorer 为应用开通任务读写权限 |
| 10 | **QPS 上限未能离线核实**;HTTP 429 由共享请求层映射为 `provider_status`(orchestrator 跳过本 tick),行为已固化在共享层 |

**§3 定案:方案 A(section = 状态列)。** 依据:#3 三能力齐备;#1/#4 表明方案 B
的列表无字段值,候选拉取会放大成全表 detail get,请求数不可接受。方案 B 记为
不采用(非 v2 开放项)。

**实现偏差(相对本文 §4/§7 的预估,均由核实结果驱动):**

- 摘要项的 `description`/`url`/时间戳为 null(列表接口不返回);orchestrator
  派发前会经 `fetchIssueStatesByIds` 重取详情,prompt 拿到的是完整字段。
- `labels`/`priority`/`field_identifier` 在方案 A 下无载体,v1 不映射
  (identifier = task guid);因此 `tracker.required_labels` 非空时 validate
  直接报错(`lark_task_required_labels_unsupported`),否则会静默路由不到任何任务。
- 状态写回(add_tasklist 移动分组)会校验响应回显的 `tasklists` 归属:若回显仍在
  旧分组则返回 `lark_task_state_update_unconfirmed` 而非假成功——"对已在清单中的
  任务再次 add_tasklist 会移动分组"这一语义离线未能直接核实,靠该校验兜底。
- 已删除任务的判定假设 `GET /tasks/{guid}` 返回 HTTP 404(`isNotFound`);若某些
  租户/版本改为 HTTP 200 + 业务错误码,需把该 not-found 业务码补进 `isNotFound`
  ——首次真实运行时删一个任务核实一次。
- `projectUrl` 用清单 applink(`https://applink.{domain}/client/todo/task_list?guid=`,
  与 tasklist API 返回的 `url` 字段格式一致);此拼法来自官方文档示例,
  离线未能直接核实——首次真实运行时确认,错了只影响 dashboard 链接。
- 共享层落位 `plugins/lark-common/`(http.ts + api-tool.ts),token 缓存按
  `endpoint|app_id` 键控(两插件共享,teardown 一处清理);`lark` 插件对外行为不变。
