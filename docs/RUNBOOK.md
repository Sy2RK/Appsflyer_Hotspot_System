# RUNBOOK

## 1. 启动

升级已有环境时，先看：`docs/UPGRADE_CHECKLIST.md`。


生产环境必填：

- `ADMIN_BASIC_AUTH_USER`
- `ADMIN_BASIC_AUTH_PASSWORD`
- `POSTGRES_USER`
- `POSTGRES_PASSWORD`
- `POSTGRES_DB`
- `CLICKHOUSE_USER`
- `CLICKHOUSE_PASSWORD`
- `CLICKHOUSE_API_PASSWORD`（用于 ClickHouse 业务账号初始化）

```bash
cd hotspot-system
cp .env.example .env
# 如需全局兜底通知，可配置 FEISHU_APP_ID/FEISHU_APP_SECRET/FEISHU_CHAT_ID
# 或 ALERT_WEBHOOK_URL（二选一或同时配置）
# Pull 回填天数（默认 3）
# PULLER_BACKFILL_DAYS=3
# Pull 单次请求超时（默认 20000ms）
# PULLER_REQUEST_TIMEOUT_MS=20000
# Pull / 推送时间的 env 仅作为默认值使用
# 启动后可在 WebUI 顶部“全局调度设置”里修改
# PULLER_REPORT_HOUR=9
# 关键词与预算建议 worker
# KEYWORD_ENGINE_INTERVAL_MS 保留兼容，但 keyword-engine 现在按 Pull 时间对齐触发
# KEYWORD_ENGINE_INTERVAL_MS=86400000
# BUDGET_ADVISOR_INTERVAL_MS 保留兼容，但 budget-advisor 现在按 Pull 时间对齐触发
# BUDGET_ADVISOR_INTERVAL_MS=86400000
# ASA Raw / Master API 单次请求超时（默认 20000ms）
# ASA_KEYWORD_REQUEST_TIMEOUT_MS=20000
# ASA_MASTER_API_TIMEOUT_MS=20000
# 每日报告 worker（默认每小时检查一次，到指定小时后发送前一日报告）
# DAILY_BRIEF_ENABLED=true
# DAILY_BRIEF_INTERVAL_MS=3600000
# DAILY_BRIEF_REPORT_HOUR=10
# DAILY_BRIEF_TITLE_PREFIX=Hotspot 每日简报
# ASA keyword 数据准备时间默认与 Pull 一致
# ASA_KEYWORD_REPORT_HOUR=9
# Feishu 多维表格投放执行表默认使用“推送时间 + 5 分钟”
# FEISHU_BITABLE_ENABLED=true
# FEISHU_BITABLE_APP_TOKEN=KlGhboFKLahZJssn17QcdLqTnhc
# FEISHU_BITABLE_ACTION_TABLE_NAME=投放执行表
# FEISHU_BITABLE_SCHEDULE_HOUR=10
# FEISHU_BITABLE_SCHEDULE_MINUTE=5
# Qwen（OpenAI兼容）
# QWEN_BASE_URL=
# QWEN_API_KEY=
# QWEN_MODEL=qwen3.5-plus
# QWEN_THINKING_ENABLED=true
cd infra
docker compose up -d --build
```

服务:
- API: `http://localhost:3000`
- Web UI: `http://localhost:3000/ui`
- ClickHouse HTTP: `http://localhost:8123`
- Postgres: `localhost:5432`

登录行为：
- 未登录浏览器访问 `/ui` / `/ui/` 会跳转到 `/login`
- 未登录访问 `/api/*` 会返回 `401`
- 登录成功后通过 Cookie 保留会话
- Cookie 仅在 HTTPS 或 `x-forwarded-proto=https` 时附加 `Secure`
  - 本地 HTTP 调试可正常使用
  - 生产环境应通过 HTTPS 暴露

> `infra/postgres/init.sql` 会预置 3 个 app：
> - `ai-video-plus` -> `id6746191879`
> - `ai-screen-time-coach` -> `id6756569023`
> - `ai-seek` -> `id6752638454`
> - 初始 token 为占位值，需上线前更新

Web UI 新增能力:
- 顶部全局调度设置（统一编辑 Pull 时间 / 推送时间）
- 自动闭环调度（Pull ready -> budget-advisor / asa-keywords -> daily-brief / asa-daily-brief -> bitable-export）
- 规则 DSL 表单编辑（并可与 JSON 双向同步）
- 告警详情抽屉（查看 `top_contributors` 与原始 JSON）
- 关键词生命周期页面（筛选、分页、趋势抽屉、手动重算）
- 预算建议页面（筛选、分页、详情弹窗、状态流转、手动生成、eCPI 分级规则说明）
  - 内置“应用级规则配置”向导：`平台 -> 应用 -> 建议类型 -> 填写规则 -> 确认保存`
  - 不支持的平台组合不会出现在应用选择里；接口层也会兜底拦截
  - 切换核心指标时，不再适用的隐藏阈值会自动清理，避免“界面看不到但规则仍生效”
- ASA 关键词管理页面（真实 ASA keyword、阶段配置、专项简报 / 建议发送）
- 每日报告页面（结构化预览、飞书 `interactive` 卡片发送、阈值说明）
- 投放执行表推送页面（通用投放建议 + ASA 关键词建议 -> 同一 Base 内按日期归档执行表 + 群通知）
- 操作日志页面（查看手动操作与定时任务执行记录）
- UI 文案默认中文（专有名词保留英文），规则见 `AGENTS.md`

自动调度说明：
- `pull_time` 到达后，先由 `puller` / `keyword-engine` / `budget-advisor` / `asa-keywords` 为前一报告日准备数据
- `push_time` 到达后，`daily-brief` 与 `asa-daily-brief` 不会立刻发送，而是先检查同一 `reportDate` 的 `budget-advisor` 与 `asa-keywords` 是否已经完成
- `bitable-export` 固定在 `push_time + 5 分钟` 检查，但同样会等待上述两个长任务完成后再导出
- 每日 worker 的“是否已跑过 / 是否还能重试”由 Postgres `scheduled_worker_runs` 持久化控制，避免多实例部署时串行重复跑
  - 当前已接入：`puller`、`keyword-engine`、`budget-advisor`、`asa-keywords`、`daily-brief`、`asa-daily-brief`、`bitable-export`
- `puller` 对 AppsFlyer 请求启用请求级超时与错误分类：
  - `timeout / network / 5xx` 会先做一次 30 秒后的本地复核，再决定是否消耗当天 worker 重试额度
  - `401 / 404 / invalid request` 这类确定性错误不会盲目进入同一条复核链路
- `asa-keywords` 对每个 `app + platform + date` 切片也会先做一次 30 秒本地复核，只有仍然属于可调度重试的失败，才会上抛给 worker 级冷却重试
- 如果长任务还在跑，日志里会看到 `*_blocked_by_downstream_gate`

多维表格反馈说明：
- `bitable-feedback-sync` 会回读 `执行状态 / 是否采纳 / 人工批复`
- `七天后数据` 由系统自动补列，但不会被当作“人工反馈变化”触发 `skills.md` 刷新
- feedback sync 的 D+7 补写使用独立 backfill lock，不再长时间占用导出主链的 `bitable:source_io:*`

---

## 2. 健康检查

```bash
curl http://localhost:3000/health
```

---

## 3. 验证 Push Callback

### 3.1 GET callback

```bash
curl "http://localhost:3000/appsflyer/api/v1/event/ai-video-plus/ods_events_device_detail/callback"
```

### 3.2 POST callback（带 Authorization）

```bash
curl -X POST "http://localhost:3000/appsflyer/api/v1/event/ai-video-plus/ods_events_device_detail/callback" \
  -H "Authorization: <your-generated-token>" \
  -H "Content-Type: application/json" \
  -d '{
    "event_time":"2026-02-13T10:10:00+08:00",
    "event_name":"purchase",
    "media_source":"Apple Search Ads",
    "campaign":"ASA-CN-1",
    "country_code":"US",
    "platform":"ios",
    "appsflyer_id":"af_001",
    "event_revenue":"120.5",
    "currency":"USD",
    "event_value":{"order_id":"o_001","sku":"pro"}
  }'
```

预期: HTTP `204`。

---

## 3.3 更新 3 个 app 的 token 与飞书机器人配置

```sql
UPDATE apps
SET push_auth_token = '<generated_token>',
    display_name = '<display_name_optional>',
    notify_feishu_app_id = '<feishu_app_id>',
    notify_feishu_app_secret = '<feishu_app_secret>',
    notify_feishu_chat_id = '<feishu_chat_id>'
WHERE app_key IN ('ai-video-plus', 'ai-screen-time-coach', 'ai-seek');
```

---

## 4. 验证 raw_events 入库

```bash
curl -s "http://localhost:8123/?query=SELECT%20app_key,event_name,revenue,event_time,event_uid%20FROM%20hotspot.raw_events%20ORDER%20BY%20event_time%20DESC%20LIMIT%205"
```

---

## 5. 验证小时聚合（aggregator 每 5 分钟）

```bash
curl -s "http://localhost:8123/?query=SELECT%20hour,app_key,metric,event_name,value%20FROM%20hotspot.metrics_hourly%20FINAL%20ORDER%20BY%20hour%20DESC%20LIMIT%2010"
```

聚合策略:
- `metrics_hourly` 使用 `ReplacingMergeTree(version)`
- 每轮重算最近 `N` 小时（默认 6 小时）
- 通过 `FINAL` 读取最新版本，支持迟到事件修正

---

## 5.1 Pull 日级字段迁移（老环境必做）

如果 ClickHouse 是旧数据卷（不是全新初始化），执行一次：

```bash
docker exec -i hotspot-clickhouse clickhouse-client -n < infra/clickhouse/init.sql
```

---

## 5.2 验证 Pull 入库与日级指标

重启 puller 让其加载新 token 与新回填参数：

```bash
cd hotspot-system/infra
docker compose up -d puller
docker compose logs -f --tail=200 puller
```

检查 `pull_aggregate_daily`：

```bash
curl -s "http://localhost:8123/?query=SELECT%20date,app_key,media_source,installs,clicks,total_cost,source_report%20FROM%20hotspot.pull_aggregate_daily%20ORDER%20BY%20date%20DESC%20LIMIT%2010"
```

检查 `metrics_daily`：

```bash
curl -s "http://localhost:8123/?query=SELECT%20date,app_key,metric,value%20FROM%20hotspot.metrics_daily%20FINAL%20ORDER%20BY%20date%20DESC%20LIMIT%2010"
```

验证 Pull API 查询：

```bash
curl "http://localhost:3000/api/metrics?appKey=ai-seek&metric=installs&source=pull&from=2026-03-01&to=2026-03-03&granularity=day"
```

---

## 5.3 验证 Pull 明细列表接口

```bash
curl -G "http://localhost:3000/api/pull-records" \
  --data-urlencode "from=2026-03-01" \
  --data-urlencode "to=2026-03-03" \
  --data-urlencode "appKey=ai-seek" \
  --data-urlencode "page=1" \
  --data-urlencode "sort=ingest_time_desc"
```

WebUI 查看路径：
- `http://localhost:3000/ui`
- 左侧导航点击 `Pull明细`
- 默认显示最近 3 天数据，支持筛选、分页、行内展开 `raw_json`

手动触发一次 Pull（API）：

```bash
curl -X POST "http://localhost:3000/api/pull-records/trigger" \
  -H "Content-Type: application/json" \
  -d '{"backfillDays":1}'
```

返回结果补充：
- `retryable_failed_count`：仍值得由 worker 冷却重试的失败数
- `terminal_failed_count`：认证、404、错误参数等确定性失败数
- `details[*].failure_kind`：失败分类，常见值有 `timeout / network / rate_limit / auth / not_found / invalid_request / server`
- `details[*].recovered_by_retry=true`：表示该 app/date 已在 30 秒复核中自动恢复

WebUI 手动触发：
- 在 `Pull明细` 区块点击 `手动读取`
- 读取完成后会弹出“读取详情”弹窗

删除单条 Pull 明细：

```bash
curl -X DELETE "http://localhost:3000/api/pull-records" \
  -H "Content-Type: application/json" \
  -d '{
    "ingest_time":"2026-03-03 18:38:57",
    "date":"2026-03-02",
    "app_key":"ai-seek",
    "platform":"ios",
    "media_source":"Apple Search Ads",
    "campaign":"Novix_iTunes_us_1226_broad_BR_br",
    "source_report":"daily_report_v5"
  }'
```

---

## 5.4 验证关键词生命周期链路

手动重算（最近 30 天）：

```bash
curl -X POST "http://localhost:3000/api/keywords/recompute" \
  -H "Content-Type: application/json" \
  -d '{"backfillDays":30}'
```

查询生命周期列表：

```bash
curl -G "http://localhost:3000/api/keywords/lifecycle" \
  --data-urlencode "appKey=ai-seek" \
  --data-urlencode "page=1"
```

查询关键词趋势：

```bash
curl -G "http://localhost:3000/api/keywords/Novix_iTunes_us_1226_broad_BR_br/trend" \
  --data-urlencode "appKey=ai-seek" \
  --data-urlencode "days=30"
```

---

## 5.5 验证预算建议链路（含 Qwen 文案增强）

如需先维护应用级规则配置，可直接使用 WebUI：

- 进入 `预算建议 -> 应用级规则配置`
- 按 `平台 -> 应用 -> 建议类型` 明确选择目标组合
- 若当前组合没有已保存规则，页面会提示“已载入推荐模板”或“当前为空白模板”
- 保存前会显示影响摘要，只影响当前选择的 `app + platform + engine`
- `同类对比判断` 至少需要保留 1 个比较指标，否则前端会阻止保存

手动生成建议：

```bash
curl -X POST "http://localhost:3000/api/budget/recommendations/recompute" \
  -H "Content-Type: application/json" \
  -d '{}'
```

查看生成进度：

```bash
curl -G "http://localhost:3000/api/budget/recommendations/recompute/status"
```

WebUI 行为：
- 预算建议模块会显示进度条
- 进度文案格式为：`已生成建议 / 总建议`
- 生成中会额外显示当前应用处理进度
- 应用级规则配置向导不会默认选中应用或建议类型
- 切换 `平台 / 应用 / 建议类型` 组合时，如当前草稿未保存，会弹出确认
- `国家目标 / 媒体目标 / 上下文窗口` 均使用结构化输入，不再要求直接填写 JSON 或逗号字符串

查询建议列表：

```bash
curl -G "http://localhost:3000/api/budget/recommendations" \
  --data-urlencode "appKey=ai-seek" \
  --data-urlencode "status=pending" \
  --data-urlencode "page=1"
```

状态流转：

```bash
curl -X POST "http://localhost:3000/api/budget/recommendations/1/mark-applied"
curl -X POST "http://localhost:3000/api/budget/recommendations/1/reject"
```

预算建议当前核心规则：
- 核心口径优先使用 AppsFlyer Pull 返回的官方 `average_ecpi`
- 按最近 3 天激活量分为 `low / medium / high`
- 单次调价动作固定为 `+20% / -20%`
- 仅在极端低效且进入 `pause_candidate` 时给出暂停建议

应用级规则配置补充验证：

```bash
curl -G "http://localhost:3000/api/recommendation-policies" \
  --data-urlencode "appKey=ai-seek" \
  --data-urlencode "platform=ios" \
  --data-urlencode "engine=budget"
```

手动保存一条规则：

```bash
curl -X POST "http://localhost:3000/api/recommendation-policies" \
  -H "Content-Type: application/json" \
  -d '{
    "appKey":"ai-seek",
    "platform":"ios",
    "engine":"budget",
    "enabled":true,
    "ruleJson":{
      "metric_family":"ecpi",
      "decision_mode":"deterministic",
      "traffic_scope":"all",
      "maturity_window":{
        "exclude_recent_days":7,
        "decision_window_days":14,
        "context_window_days":[7,14,21]
      },
      "targets":{
        "global_targets":{"ecpi_max":3}
      }
    },
    "manualPromptMarkdown":"低量级优先关注跑量能力。"
  }'
```

预期：

- 同一组合重复保存会更新原记录，不会新增多条
- 不支持的平台组合会返回 `app_platform_not_supported`
- `traffic_scope=media_sources` 但未填写媒体源时，会返回中文 `message`
- `metric_family=relative_compare` 且未勾选任何指标时，会返回中文 `message`

---

## 5.6 验证每日报告链路

预览日报：

```bash
curl -G "http://localhost:3000/api/daily-brief/preview" \
  --data-urlencode "reportDate=2026-03-09"
```

发送日报：

```bash
curl -X POST "http://localhost:3000/api/daily-brief/send" \
  -H "Content-Type: application/json" \
  -d '{"reportDate":"2026-03-09","force":true}'
```

说明：
- 默认发送 Feishu `interactive` 卡片
- 卡片失败会自动回退到纯文本发送
- WebUI 路径：`总览 -> 每日简报`

## 5.7 验证全局调度设置

读取当前调度快照：

```bash
curl "http://localhost:3000/api/runtime-schedule"
```

更新调度时间：

```bash
curl -X POST "http://localhost:3000/api/runtime-schedule" \
  -H "Content-Type: application/json" \
  -d '{"pullTime":"09:00","pushTime":"10:00"}'
```

预期：
- 返回 `pull_time / push_time / bitable_time`
- `bitable_time` 固定为 `push_time + 5 分钟`
- 自动链路会继续等待：
  - `worker.budget_advisor`
  - `worker.asa_keywords`
  这两个 worker 对同一 `reportDate` 完成后，才会真正发送日报 / ASA 简报 / 执行表
- 页面顶部 `全局调度设置` 会显示当前配置
- worker 在下一轮检查时会跟随新时间，不需要手动改 `.env`

---

## 5.8 验证操作日志

```bash
curl -G "http://localhost:3000/api/operation-logs" \
  --data-urlencode "limit=20"
```

WebUI 路径：
- 左侧导航点击 `操作日志`
- 可按 `source / status / limit` 筛选

常见来源：
- `api.pull_records`
- `api.keywords`
- `api.budget`
- `api.daily_brief`
- `api.bitable_export`
- `worker.puller`
- `worker.keyword_engine`
- `worker.budget_advisor`
- `worker.daily_brief`
- `worker.bitable_export`

---

## 5.9 验证 Feishu 投放执行表推送

查询当前导出配置：

```bash
curl "http://localhost:3000/api/bitable-exports/configs"
```

保存投放执行表配置：

```bash
curl -X POST "http://localhost:3000/api/bitable-exports/configs/delivery_actions" \
  -H "Content-Type: application/json" \
  -d '{
    "enabled": true,
    "chatId": "oc_xxx"
  }'
```

手动执行投放执行表导出：

```bash
curl -X POST "http://localhost:3000/api/bitable-exports/run" \
  -H "Content-Type: application/json" \
  -d '{"sourceType":"delivery_actions","reportDate":"2026-03-17"}'
```

预期：
- 系统在同一 Base 下创建 / 复用对应日期的执行表，例如 `投放执行表_2026-03-17`
- 表内同时包含通用投放建议与 ASA 关键词建议
- 不再出现 `raw_json`、`event_uid` 之类技术字段
- 群里收到一条 Feishu 交互卡片，包含：
  - 报告日期
  - 总条数
  - 通用投放 / ASA 关键词条数
  - 表链接

定时任务：
- `worker.bitable_export`
- 默认每天 `10:05 (Asia/Shanghai)` 自动执行
- 实际时间固定按全局 `push_time + 5 分钟`
- 默认导出前一天数据

查看 worker 日志：

```bash
cd hotspot-system/infra
docker compose logs -f bitable-export
```

如果看到：
- `daily_brief_blocked_by_downstream_gate`
- `asa_daily_brief_blocked_by_downstream_gate`
- `bitable_export_blocked_by_downstream_gate`

说明：
- Pull 数据已准备好
- 但 `budget-advisor` / `asa-keywords` 还有至少一个尚未完成
- 这是预期保护行为，用来避免“日报先发、建议后补”

---

## 5.10 验证 ASA 关键词专项链路

保存产品阶段：

```bash
curl -X POST "http://localhost:3000/api/asa-keywords/stages" \
  -H "Content-Type: application/json" \
  -d '{"appKey":"ai-seek","platform":"ios","stage":"rising","enabled":true}'
```

手动重算 ASA 关键词链路：

```bash
curl -X POST "http://localhost:3000/api/asa-keywords/recompute" \
  -H "Content-Type: application/json" \
  -d '{"backfillDays":1}'
```

返回结果补充：
- `failed_slice_count`：`app + platform + date` 切片总失败数
- `retryable_failed_slice_count`：仍值得继续由 worker 冷却重试的失败切片数
- `terminal_failed_slice_count`：确定性失败切片数
- `recovered_slice_count`：在 30 秒本地复核里自动恢复的切片数

验证 Master API 关键词成本直连：

```bash
curl -G "https://hq1.appsflyer.com/api/master-agg-data/v4/app/id6752638454" \
  -H "Authorization: Bearer ${APPSFLYER_MASTER_API_TOKEN:-$APPSFLYER_PULL_TOKEN}" \
  --data-urlencode "from=2026-03-18" \
  --data-urlencode "to=2026-03-18" \
  --data-urlencode "groupings=pid,c,af_adset,af_keywords" \
  --data-urlencode "kpis=cost,installs,average_ecpi" \
  --data-urlencode "pid=Apple Search Ads" \
  --data-urlencode "timezone=preferred" \
  --data-urlencode "currency=preferred" \
  --data-urlencode "format=json"
```

查询 ASA 关键词列表：

```bash
curl -G "http://localhost:3000/api/asa-keywords" \
  --data-urlencode "appKey=ai-screen-time-coach" \
  --data-urlencode "platform=ios" \
  --data-urlencode "page=1"
```

查询 ASA 关键词趋势：

```bash
curl -G "http://localhost:3000/api/asa-keywords/controle%20de%20tempo%20de%20tela/trend" \
  --data-urlencode "appKey=ai-screen-time-coach" \
  --data-urlencode "platform=ios" \
  --data-urlencode "campaign=Zensi_pt(br)_broad_260213_Wancy_br" \
  --data-urlencode "adset=broad"
```

预览 ASA 简报：

```bash
curl -G "http://localhost:3000/api/asa-keywords/brief/preview" \
  --data-urlencode "reportDate=2026-03-12" \
  --data-urlencode "appKey=ai-seek" \
  --data-urlencode "platform=ios"
```

发送 ASA 简报：

```bash
curl -X POST "http://localhost:3000/api/asa-keywords/brief/send" \
  -H "Content-Type: application/json" \
  -d '{"reportDate":"2026-03-12","appKey":"ai-seek","platform":"ios","force":true}'
```

WebUI 路径：
- 左侧导航点击 `ASA 关键词管理`
- 可配置 `app + platform` 阶段
- 可筛选真实 ASA keyword
- 列表中的 `广告组（adset）` 与成本口径直接来自 AppsFlyer Master API
- 可手动预览 / 发送 ASA 简报，建议操作已并入简报

排障说明：
- 如果 Raw Data 的 `cost_value` 仍为 0，但 Master API 关键词成本可返回，系统属于正常状态
- 当前 ASA 专项以 Master API 作为唯一成本主来源，不再依赖 Raw Data `cost_value`

---

## 6. 规则与告警

### 查询规则

```bash
curl "http://localhost:3000/api/rules?appKey=ai-video-plus"
```

### 创建规则

```bash
curl -X POST "http://localhost:3000/api/rules" \
  -H "Content-Type: application/json" \
  -d '{
    "app_key":"ai-video-plus",
    "name":"manual-rule",
    "enabled":true,
    "rule_json":{
      "timezone":"Asia/Shanghai",
      "silence_minutes":30,
      "metrics":[{
        "metric":"revenue",
        "granularity":"hour",
        "window":"last_1h",
        "baseline":"avg_7d_same_hour",
        "up_ratio":2,
        "down_ratio":0.5,
        "min_abs_delta":50,
        "severity":{"spike":"P1","drop":"P0"},
        "drilldown_dims":["media_source","country","campaign","attribution","event_type"]
      }]
    }
  }'
```

### 查告警

```bash
curl "http://localhost:3000/api/alerts?appKey=ai-video-plus&status=open"
```

---

## 7. 验收用例步骤

1. `GET callback` 返回 `{ok:true}`
2. `POST callback` 成功后，`raw_events` 能查到数据
3. 最长 5 分钟后，`metrics_hourly FINAL` 出现对应小时记录
4. 连续推入高 revenue/purchase 数据，detector 触发并写入 `alerts`
5. 同一异常 fingerprint 在 30 分钟内不会重复发（抑制）
6. 停止推高值后恢复正常区间，open 告警会被置为 `resolved`
7. `GET /api/daily-brief/preview` 可生成结构化日报
8. `POST /api/daily-brief/send` 可发送飞书交互卡片
9. `GET /api/operation-logs` 可查询手动操作和定时任务执行记录

---

## 8. 运维排障

查看容器日志:
```bash
cd hotspot-system/infra
docker compose logs -f api
docker compose logs -f aggregator
docker compose logs -f detector
docker compose logs -f puller
docker compose logs -f keyword-engine
docker compose logs -f budget-advisor
docker compose logs -f daily-brief
```

常见问题:
- `401 authorization_invalid`: 检查 apps 表中 `push_auth_token` 与 header 是否一致
- `event_uid length mismatch`: 确保 event_uid 是 32 位 md5（当前实现已统一）
- `metrics_hourly 为空`: 检查 `raw_events` 是否有数据，以及 aggregator 日志
- `日报预览为空`: 检查报告日期是否晚于最新 Pull 日期
- `每日卡片发送失败`: 检查 `.env` 或 app 级 Feishu 配置，并查看 `operation_logs`
- `Pull 连续失败`:
  - `failure_kind=timeout|network|server`：优先看网络抖动、出口质量、AppsFlyer 短时可用性
  - `failure_kind=rate_limit`：说明命中 AppsFlyer 限流，优先拉开重试窗口
  - `failure_kind=auth|not_found|invalid_request`：优先检查 token、app_id、接口参数，这类不会靠继续重试自愈
- `ASA 连续失败`:
  - 先看 `asa_keyword_slice_retry_scheduled / asa_keyword_slice_retry_recovered / asa_keyword_slice_failed` 日志
  - 如果大量切片停留在 `timeout|network|server`，优先排查出口网络和 AppsFlyer 波动
  - 如果集中在 `auth|invalid_request`，优先检查 `RAW_DATA_TOKEN / MASTER_API_TOKEN / app_id`

生成高强度 push token（推荐 48 bytes）:
```bash
cd hotspot-system
npm run token:gen
# 或指定字节数：npm run token:gen -- 64
```
