# Lark (飞书) Tracker Plugin — Handoff

> 目标读者:实现 lark 插件的下一个 Claude session。开工前先通读本文和
> [`PLUGIN_CONTRACT.md`](./PLUGIN_CONTRACT.md)(插件契约,规范性文档,必须逐条满足)。

## 0. 背景

Symphony 的 tracker 层已插件化(PR #2/#3):核心只依赖 `TrackerPlugin` 契约,
Linear 和 memory 是现有的两个插件。本任务是新增第三个插件 `kind: "lark"`,
让 Symphony 能从飞书/Lark 拉工作项、派发 Codex agent、并写回状态。

**必读材料(按顺序):**

1. `docs/PLUGIN_CONTRACT.md` — 插件契约(数据模型、必选读操作、可选 capability、
   错误模型、配置钩子、新插件 checklist §10)。
2. `typescript/src/symphony/plugins/linear/` — 全能力参考实现
   (plugin.ts / settings.ts / client.ts / adapter.ts / graphql-tool.ts)。
3. `typescript/src/symphony/plugins/memory/` — 最小实现 + capability 降级示例。
4. `typescript/test/symphony/plugins/` 与 `typescript/test/symphony/tracker.test.ts`
   — 测试注入模式(app-env seam)。
5. `SPEC.md` §11(tracker 契约)、§8(轮询/对账循环,理解三个读操作何时被调用)。

## 1. 调研结论:用 Bitable(多维表格)作为工作源

飞书有三类候选载体,结论是 **Bitable 多维表格**,一张表 = 一个看板:

| 候选 | 结论 | 原因 |
|---|---|---|
| **Bitable 多维表格** | ✅ 采用 | 字段完全自定义 → WorkItem 全字段可映射;读写 API 齐全(见 §2);单选字段天然承载完整状态词汇表 |
| Task v2(任务) | ❌ 备选不采用 | 状态本质是"完成/未完成"二值,状态机要靠 section/自定义字段模拟;列表接口按 tasklist 拉取、无服务端自定义字段过滤;有原生评论 API 是唯一优势 |
| IM 消息/群 | ❌ 不采用 | 无状态机、无结构化字段,语义太弱 |

### 能力核对表(Symphony 需求 ↔ Bitable API)

| Symphony 需求 | Bitable 方案 | 状态 |
|---|---|---|
| `fetchCandidateIssues`(按 active 状态拉候选) | `POST /open-apis/bitable/v1/apps/{app_token}/tables/{table_id}/records/search`,filter 按状态单选字段过滤,分页(单页上限 500,`page_token` 游标) | ✅ 已确认 |
| `fetchIssuesByStates`(按状态名列表查) | 同上,filter 换状态集合 | ✅ 已确认 |
| `fetchIssueStatesByIds`(按 id 批量刷新) | `POST .../records/batch_get`,`record_ids` 数组(单批上限 100,响应含 `absent_record_ids`/`forbidden_record_ids`) | ✅ 已确认 |
| `stateUpdates`(写状态) | `PUT .../records/{record_id}` 更新状态单选字段 | ✅ 标准接口 |
| `comments`(写评论) | **记录级评论无公开 open API**(drive comments 面向 doc/docx 等文档) | ⚠️ v1 省略该 capability(契约允许;orchestrator 本就不调用) |
| 稳定 id | `record_id`(表内唯一) | ✅ |
| 鉴权 | `app_id` + `app_secret` → `POST /open-apis/auth/v3/tenant_access_token/internal`,token ~2h 过期 | ✅(需缓存+过期刷新,见 §3.3) |
| agent 写回工具 | 通用 `lark_api` 动态工具(HTTP 代理,角色等价 `linear_graphql`) | ✅ 设计见 §3.4 |

### WorkItem 字段映射(默认字段名,全部可在 WORKFLOW.md 覆盖)

| WorkItem | Bitable 来源 | 说明 |
|---|---|---|
| `id` | `record_id` | 必选 |
| `identifier` | 配置的编号字段(如自动编号字段),缺省回退 `record_id` | 必选;须经 workspace 的 `safeIdentifier` 消毒后唯一 |
| `title` | 主字段/配置的文本字段(默认 `"Title"`) | 必选 |
| `state` | 配置的单选字段(默认 `"Status"`) | 必选;词汇表 = 单选选项,workflow 作者配置匹配的 `active_states`/`terminal_states` |
| `description` | 配置的多行文本字段(默认 `"Description"`) | 可选 |
| `labels` | 多选字段(默认 `"Labels"`) | 可选,trim+小写归一化(契约要求) |
| `assigneeId` / `assignedToWorker` | 人员字段(默认 `"Assignee"`);`tracker.assignee` 配置 open_id 时过滤 | 可选;v1 可不支持 `"me"` 语义(应用无 viewer 概念),配置了 assignee 就按 open_id 精确匹配 |
| `priority` | 数字或单选字段(默认无) | 可选,非整数置 null |
| `createdAt` / `updatedAt` | `created_time` / `last_modified_time`(record 元数据或自动字段,毫秒时间戳 → Date) | 可选 |
| `url` | 拼接:`https://{domain}/base/{app_token}?table={table_id}&record={record_id}` | 可选 |
| `blockedBy` | 双向关联字段(链接同表记录) | v1 可置空 `[]`(禁用阻塞门控,契约允许);v2 再做 |
| `metadata` | `{ app_token, table_id, record_id }` | 供模板 `issue.metadata.*` 使用 |

## 2. 已确认的 API 端点清单

Base URL 可配置(飞书 `https://open.feishu.cn` / Lark 国际版 `https://open.larksuite.com`):

- `POST /open-apis/auth/v3/tenant_access_token/internal` — body `{app_id, app_secret}` → `{tenant_access_token, expire}`
- `POST /open-apis/bitable/v1/apps/{app_token}/tables/{table_id}/records/search`
  — body 含 `filter`(`conjunction` + `conditions[]`,单选字段用 `is` 操作符;
  多状态匹配用 `conjunction: "or"` 的多条 `is`,实现时验证是否有 `isAnyOf` 可替代)、
  `field_names`(只取需要的字段)、`page_size`/`page_token`
- `POST /open-apis/bitable/v1/apps/{app_token}/tables/{table_id}/records/batch_get`
  — body `{record_ids: [...]}`;>100 个 id 时分批(参照 linear client 的 50/批分页模式)
- `PUT /open-apis/bitable/v1/apps/{app_token}/tables/{table_id}/records/{record_id}`
  — body `{fields: {"Status": "Done"}}`

实现时用浏览器/搜索核对最新文档(open.larksuite.com 的 bitable-v1 reference:
search / batch_get / update / record filter guide),文档站可能挡爬虫,
以实际 API 行为为准并在测试里固化。

## 3. 设计决策(已与仓库 owner 对齐,直接照做)

### 3.1 配置(WORKFLOW.md `tracker` 段,扁平键,由 lark 插件的 configSchema 认领)

```yaml
tracker:
  kind: "lark"
  endpoint: "https://open.feishu.cn"       # 默认值;Lark 国际版可覆盖
  app_id: "cli_xxx"
  app_secret: "$LARK_APP_SECRET"           # $VAR 引用;canonical env: LARK_APP_SECRET
  app_token: "bascnXXXX"                   # 多维表格 app token,REQUIRED
  table_id: "tblXXXX"                      # REQUIRED
  assignee: null                           # 可选,open_id
  field_state: "Status"                    # 以下均可选,有默认值
  field_title: "Title"
  field_description: "Description"
  field_labels: "Labels"
  field_assignee: "Assignee"
  field_identifier: null                   # null → 回退 record_id
  active_states: ["Todo", "In Progress"]   # 核心键,与单选选项匹配
  terminal_states: ["Done", "Cancelled"]
```

- `finalize`:`app_secret` 走 `resolveSecretSetting(value, envOrNull("LARK_APP_SECRET"))`
  (必须用 `plugins/config-helpers.ts` 的共享 helper,保证 `$VAR` 语义一致)。
- `validate` 错误 tag(带 code + message,遵守 TrackerError 契约):
  `missing_lark_app_credentials`(code `missing_credentials`)、
  `missing_lark_app_token` / `missing_lark_table_id`(code `missing_config`)。

### 3.2 capability 取舍

- `stateUpdates` ✅(update record 写状态单选字段)
- `comments` ❌ 省略(无公开记录评论 API;**禁止用 no-op 假装成功**,门面会自动返回
  `unsupported_operation`,这正是契约设计的降级路径)
- `agentTools` ✅ `lark_api`(见 §3.4)
- `ui` ✅:`projectUrl` → base 表格 URL;`defaultPromptTemplate` 可用通用模板
  (不提供即回退 "work item" 版);`workItemNoun: "Lark record"`

### 3.3 tenant_access_token 生命周期

Linear 是静态 key,Lark 是短期 token——插件内做模块级缓存:
`{ token, expiresAt }`,过期前(留 5 分钟余量)重新获取;401/token 失效错误时
清缓存重试一次。缓存放模块级 let 变量 + 测试用 app-env seam 重置
(teardownWorkflow 里记得清理,模式参照 `linear_client_module`)。

### 3.4 agent 动态工具 `lark_api`

角色等价 `linear_graphql`:让 agent 用 Symphony 配置好的鉴权直接调 Lark OpenAPI
(自行写回状态/更新字段/发消息)。

- inputSchema:`{ method: "GET"|"POST"|"PUT"|"PATCH"|"DELETE", path: string(必须以 /open-apis/ 开头), body?: object }`
- 实现:拼 endpoint + path,带缓存 token 发请求;`success` 判定:HTTP 2xx 且响应
  `code === 0`(Lark 的业务错误码);错误 payload 风格参照 graphql-tool.ts 的
  `toolErrorPayload`(参数错误/缺鉴权/HTTP 状态/传输失败四类)。
- 安全:path 校验前缀 `/open-apis/`,拒绝其它路径(防 SSRF 到任意主机——host 永远
  用配置的 endpoint)。
- 测试 seam:`opts.larkClient` 注入,模式照抄 `opts.linearClient`。

### 3.5 错误 tag 约定(全部走 TrackerError 形状)

`lark_api_status`(code `provider_status`,带 `status`)、
`lark_api_error`(code `provider_error`,带 Lark 业务 `code`/`msg`)、
`lark_api_request`(code `transport_failed`)、
`lark_unknown_payload`(code `invalid_payload`)、
`missing_lark_*`(见 §3.1)。外来错误一律 `toTrackerError` 归一化。

## 4. 文件布局与实施步骤

```
typescript/src/symphony/plugins/lark/
  plugin.ts        # LarkPlugin 聚合对象(configSchema + 3 reads + stateUpdates + agentTools + ui)
  settings.ts      # LarkSettings 窄化(照 linear/settings.ts)
  client.ts        # HTTP client:token 缓存、search/batch_get/update、normalize → newWorkItem
  api-tool.ts      # lark_api 动态工具
typescript/test/symphony/plugins/lark/
  client.test.ts   # normalize、分页、filter 构造、token 缓存/刷新(注入 fake requestFun)
  plugin.test.ts   # configSchema cast/finalize/validate、capability 面、经 Tracker 门面的端到端(fake client)
```

步骤(每步 `bun run check` 绿):

1. settings.ts + configSchema(cast/finalize/validate)+ 注册进 `plugins/index.ts`
   + config 测试(kind "lark" 不再是 unsupported)。
2. client.ts:token 管理 + 三个读操作 + normalize(**所有产出必须经 `newWorkItem` 盖章**,
   labels trim+小写,状态词汇表原样保留大小写)。注入 seam:`lark_client_module`
   app-env 键(照 `linear_client_module`),并在 `test-support.ts` teardown 里清理。
3. stateUpdates + ui。
4. api-tool.ts + 挂到 agentTools;dynamic-tool 分发器零改动(验证 kind=lark 时
   toolSpecs 广播 `lark_api`)。
5. 文档:`docs/PLUGIN_CONTRACT.md` §9 增加 lark 小节;`typescript/MIGRATION.md`
   Post-cutover divergence 登记新插件;README 一句话提及。

## 5. 质量门与验收

- `cd typescript && bun run check`(typecheck + biome + 全量测试)必须绿;
  `bun run verify` 必须过(它跑 memory 插件,验证你没破坏核心)。
- 新增测试覆盖:契约三读操作语义、`comments` 缺失时门面返回
  `tracker_capability_unsupported`、token 过期刷新、分页(>1 页)、batch_get 分批(>100 id)、
  filter 构造(多 active states)、configSchema 三钩子、`lark_api` 工具的成功/业务错误/
  参数错误路径。全部用注入 fake,**不打真实网络**。
- 不改 SPEC.md;不改任何 wire name(Liquid `issue.*` 等);核心 `Settings` 不得出现
  lark 专属字段。
- 交付:单独分支 + PR,PR 描述按 `.github/pull_request_template.md`。

## 6. 已知风险 / 开放问题

1. **filter 操作符**:多状态匹配先用 `conjunction: "or"` + 多条 `is`(确定可行);
   若文档确认 `isAnyOf` 支持单选字段,可简化。
2. **QPS 限制**:bitable API 有频控;默认 30s 轮询 + 每 tick ≤3 个请求远低于阈值,
   但 429/频控错误要映射为 `lark_api_status` 让 orchestrator 按既有行为跳过本 tick。
3. **字段类型差异**:单选字段在 search 响应里可能是字符串或 `{text, ...}` 对象、
   人员字段是数组——normalize 必须对每种形状写测试(参照 linear client.test 的
   normalizeIssueForTest 模式,给 client 留 `normalizeRecordForTest` seam)。
4. **记录评论**:若将来 Lark 开放记录评论 API,补 `comments` capability 即可,
   契约无需变动。
5. **`assignee: "me"`**:应用身份无 viewer 概念,v1 不支持;配置文档里写明只接受 open_id。
