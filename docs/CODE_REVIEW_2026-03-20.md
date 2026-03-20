# Code Review Report

日期：`2026-03-20`

范围：
- `apps/api`
- `packages/shared`
- `workers/*`
- `infra`

审查方式：
- 全量静态审查
- 未做任何代码修改
- 已执行 `npm run typecheck`，当前类型检查通过

## Critical

- 控制面基本没有鉴权/授权保护。除 AppsFlyer callback 外，`/ui`、应用配置、调度修改、手动 Pull、明细删除、预算/ASA 重算等高危入口都可直接访问；只要 `3000` 端口可达，外部就可以读配置、改 token、删数据、触发任务。
  位置：`apps/api/src/app.module.ts:20`、`apps/api/src/modules/ui/ui.routes.ts:11`、`apps/api/src/modules/apps.routes.ts:43`、`apps/api/src/modules/pullRecords/pullRecords.routes.ts:155`、`apps/api/src/modules/runtimeSchedule/runtimeSchedule.routes.ts:21`

- 默认部署配置本身不安全。Compose 直接暴露 ClickHouse、Postgres、API 端口；ClickHouse 默认空密码，Postgres 使用 `postgres/postgres`，`hotspot_api` 还是 `no_password` 且拥有 `ALTER/DROP` 权限。与上面的无鉴权 API 叠加后，风险等同于“拿到网络就拿到系统”。
  位置：`infra/docker-compose.yml:6`、`infra/docker-compose.yml:21`、`infra/docker-compose.yml:40`、`infra/docker-compose.yml:12`、`infra/docker-compose.yml:25`、`infra/clickhouse/init.sql:3`

## High

- Pull 的“同内容跳过”签名只覆盖了 `installs/clicks/total_cost/average_ecpi`，但实际落库字段还包括 `agency_pmd/impressions/ctr/conversion_rate/sessions/loyal_users/revenue/events` 等。只要这些未参与签名的字段变化、而签名字段不变，系统就会误判为“内容未变”并跳过更新，留下错误数据。
  位置：`packages/shared/utils/puller.ts:301`、`packages/shared/utils/puller.ts:376`、`packages/shared/utils/puller.ts:614`

- Feishu/Webhook 发送成功判断过于乐观，只检查 HTTP 状态，不检查响应体里的业务码。Feishu 存在 `HTTP 200` 但 `code != 0` 的失败场景；当前实现会把这类失败记成成功，导致告警/日报显示“已发送”，但实际上消息并未真正投递。
  位置：`packages/shared/utils/notifier.ts:90`、`packages/shared/utils/notifier.ts:117`、`packages/shared/utils/notifier.ts:180`、`packages/shared/utils/notifier.ts:204`

- ASA raw 明细每次重算都会无条件重新插入，底层表又是普通 `MergeTree`，没有去重、覆盖或幂等保护。只要手动重算、补跑、worker 重启后重复执行，同一批 install/event 就会永久重复，后续原始数据导出也会跟着重复。
  位置：`packages/shared/utils/asaKeywords.ts:933`、`packages/shared/utils/asaKeywords.ts:959`、`infra/clickhouse/init.sql:142`

- 多维表导出采用“先删旧记录，再写新记录”的方式，中间没有事务、回滚或 staging。任何删除后的失败都会把当天导出数据直接清空，属于明显的数据丢失窗口。
  位置：`packages/shared/utils/bitableExport.ts:824`、`packages/shared/utils/bitableExport.ts:825`、`packages/shared/utils/bitableExport.ts:828`

- 多条核心链路使用 UTC `toISOString().slice(0, 10)` 来计算“昨天/回填窗口”，而系统调度和业务时区又明确是 `Asia/Shanghai`。只要任务在本地时间 08:00 前运行，或将调度改到更早时段，就会处理错一天的数据；`budgetAdvisor` 与 `keywordEngine` 因为不是严格依赖固定日历触发，风险更高。
  位置：`packages/shared/utils/puller.ts:254`、`packages/shared/utils/asaKeywords.ts:548`、`packages/shared/utils/budgetAdvisor.ts:77`、`packages/shared/utils/budgetAdvisor.ts:367`、`packages/shared/utils/keywordEngine.ts:114`、`packages/shared/utils/keywordEngine.ts:139`、`packages/shared/utils/bitableExport.ts:884`

- 删除单条 Pull 明细时，`pull_aggregate_daily` 按明细条件删，但 `metrics_daily` 是按维度和值批量删，而且底层还是 `ReplacingMergeTree(version)`。这意味着删掉一条 UI 可见记录时，可能把该日期/维度下多个版本的聚合指标一起删掉，历史趋势会被误伤。
  位置：`apps/api/src/modules/pullRecords/pullRecords.routes.ts:177`、`apps/api/src/modules/pullRecords/pullRecords.routes.ts:202`、`infra/clickhouse/init.sql:99`

## Medium

- 路由化日报的告警统计没有真正按路由过滤。`queryOpenAlertCounts` 完全忽略 `appKey/platform`，`alertHighlights` 也直接拿全局 open alerts，所以一个“只发某个 app/平台”的日报仍可能混入别的应用告警，连标题色和“今日判断”都可能错误。
  位置：`packages/shared/utils/dailyBrief.ts:476`、`packages/shared/utils/dailyBrief.ts:716`、`packages/shared/utils/dailyBrief.ts:742`

- 规则保存接口校验过弱，只要求 `metrics` 是数组，很多坏 DSL 都能入库成功。真正的严格校验发生在 detector 中，而 detector 遇到坏规则只是记一条 `warn` 后跳过，结果就是“配置保存成功，但监控失效且没有明确失败信号”。
  位置：`apps/api/src/modules/rules/rules.routes.ts:12`、`apps/api/src/modules/rules/rules.routes.ts:37`、`packages/shared/utils/ruleParser.ts:7`、`workers/detector/src/detector.ts:199`

- Push 入库链路扩展性较差。每条事件都先查一次 ClickHouse 再做批量 claim，而且成功后 dedup key 永久保留在 Postgres 中，只有 ClickHouse 插入失败才会释放。数据量一上来会同时面临写入放大和 dedup 表持续膨胀的问题。
  位置：`apps/api/src/modules/ingest/ingest.routes.ts:61`、`apps/api/src/modules/ingest/ingest.routes.ts:110`、`packages/shared/utils/repositories.ts:101`、`infra/postgres/init.sql:74`

- 多维表导出在规模上也很容易退化。当前流程会先把整张表所有记录拉回本地，再在内存中过滤目标日期，然后逐条调用删除接口；一旦表规模扩大，导出耗时和失败概率都会线性上升。
  位置：`packages/shared/utils/bitableExport.ts:372`、`packages/shared/utils/bitableExport.ts:665`、`packages/shared/utils/bitableExport.ts:672`

- ASA dashboard 为了拼“最新 recommendation”，直接对整张 `asa_keyword_recommendations` 执行 `DISTINCT ON`，再在内存中按当前页 key 过滤。历史数据一多，这个查询会越来越重，而且与分页规模不成比例。
  位置：`packages/shared/utils/asaKeywords.ts:995`

## Low

- `/health` 中的插入耗时数组会无限增长，而且展示的是“进程生命周期平均值”，不是运营上有意义的时间窗口指标。API 跑得越久，内存占用越大，指标也越钝化。
  位置：`apps/api/src/common/utils/request.ts:10`、`apps/api/src/modules/ingest/ingest.routes.ts:117`、`apps/api/src/modules/health/health.routes.ts:6`

- 当前仓库没有自动化测试入口，源码中也未发现 `test/spec` 文件。对于以定时任务、外部 API、数据链路为核心的系统，这会显著放大回归风险。
  位置：`package.json:6`
