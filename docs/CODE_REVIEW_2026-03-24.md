# Code Review Report

日期：`2026-03-24`

范围：
- `apps/api`
- `packages/shared`
- `workers/*`
- `infra`

审查方式：
- 重新梳理系统架构与业务主链路
- 全量静态审查
- 执行 `npm run typecheck`，当前类型检查通过

## 架构理解

当前系统是一个围绕 AppsFlyer Push / Pull、异常监控、关键词与预算建议、ASA 关键词专项、日报推送和 Feishu 多维表格导出的 monorepo：

- `apps/api`
  - 控制面 API
  - 内置 Web UI
- `workers/*`
  - 定时拉取、聚合、检测、建议生成、日报推送、bitable 导出
- `packages/shared`
  - 数据访问、第三方集成、业务规则
- `ClickHouse`
  - Push / Pull / ASA 事实数据与聚合
- `Postgres`
  - 配置、状态机、建议结果、发送路由、操作日志、调度快照

主业务链路：

1. AppsFlyer Push / Pull 入库
2. 聚合与异常检测
3. 关键词生命周期、预算建议、ASA keyword 建议
4. 每日报告、ASA 简报、Feishu bitable 执行表导出

## 优先级清单

### Critical

- 通用日报在未指定平台时，告警统计与告警摘要只取 `platform='__all__'`，会漏掉 `ios/android` 平台级告警，直接影响 `open_alerts`、`alert_highlights` 与 `today_judgment` 的业务判断。
  - 位置：`packages/shared/utils/dailyBrief.ts`
  - 状态：`已修复`

### High

- 展示层里仍然把产品名展示和日报产品计数硬编码在 `ai-seek` 上。这会让展示口径依赖单个 app，扩新产品时容易失真。
  - 位置：`packages/shared/utils/displayName.ts`、`packages/shared/utils/dailyBrief.ts`
  - 状态：`已修复`

- 预算建议主指标仍然对 `ai-seek/android` 写死为 `roas_pending_revenue`，还没有收口到配置层。
  - 位置：`packages/shared/utils/budgetAdvisor.ts`
  - 状态：`待处理`

- 多个高风险任务只使用单进程内存变量防重，扩成多实例后会失效，可能出现重复重算、重复发送或重复导出。
  - 位置：`apps/api/src/modules/*`、`workers/*`
  - 状态：`部分完成（手动 API 入口与核心 worker 已接入 PG 锁）`

### Medium

- Push callback 文档声明非 JSON body 返回 `400`，但当前 `express.json()` 解析异常会进入通用 `500` handler，接口契约与实现不一致。
  - 位置：`apps/api/src/app.module.ts`、`apps/api/src/modules/ingest/ingest.routes.ts`、`docs/API.md`
  - 状态：`已修复`

- ASA dashboard 为当前页拼接 recommendation 时，先扫整张 `asa_keyword_recommendations` 再在内存过滤，分页性能会随历史数据量退化。
  - 位置：`packages/shared/utils/asaKeywords.ts`
  - 状态：`待处理`

- bitable 导出为了保留“验证结果”，会逐条回读旧记录，导出耗时与历史记录数线性增长，存在明显的规模风险。
  - 位置：`packages/shared/utils/bitableExport.ts`
  - 状态：`待处理`

### Low

- 仓库目前缺少自动化测试入口，业务口径与接口契约问题不容易被回归测试提前发现。
  - 位置：`package.json`
  - 状态：`待处理`

## 执行顺序

1. 修复通用日报告警统计与摘要口径
2. 去掉展示层里对 `ai-seek` 的硬编码
3. 修复 Push 非 JSON body 返回码与文档契约不一致
4. 继续推进任务分布式互斥锁
5. 把预算主指标从 `ai-seek/android` 特例收口到配置层
6. 再处理 ASA dashboard 与 bitable 导出的性能优化
