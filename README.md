# AppsFlyer Hotspot System

一个围绕 AppsFlyer 数据拉取、投放监控、预算建议、日报推送与 Feishu 多维表格导出的内部运营系统。

## 当前能力

- AppsFlyer Push Callback 入库与小时级聚合
- AppsFlyer Pull `daily_report_v5` 日级拉取与指标趋势
  - 请求级超时、错误分类与瞬时网络故障自动复核
- WebUI 顶部全局调度配置
  - 统一编辑 `Pull 时间` 与 `推送时间`
  - `budget-advisor` 与 `asa-keywords` 自动使用 `Pull 时间`
  - `bitable-export` 自动使用 `推送时间 + 5 分钟`
  - 自动发送链路会等待 `budget-advisor` 与 `asa-keywords` 对应报告日真正完成后，再继续日报 / ASA 简报 / Feishu 多维表格
- WebUI 全局 AI 悬浮入口
  - 右下角提供统一的 `Guru Ads Agent` 入口
  - 当前已接入抽屉式对话窗，支持多模型切换
  - 已接入 `Qwen 3.6-Plus`、`Kimi-K2.5 (OpenRouter)`、`GPT-5.4 (OpenAI)`
  - 支持页面内多轮对话、图片上传、数据库聚合上下文包附带
  - 模型可按当前已配置凭据动态显示，默认优先使用可用的主模型
  - 面板内保留 Gemini 官网外部工具快捷入口
  - 后续可继续扩展诊断助手、投放 Copilot、日报快读等功能
- 通用投放项 / 广告系列监控与预算建议
  - 手动生成预算建议时支持进度条与 `已生成建议 / 总建议` 实时展示
  - 内置“应用级规则配置”向导，按 `app + platform + 建议类型` 单独维护规则
  - 国家 / 媒体阈值、上下文窗口、补充说明都支持结构化编辑
  - 保存前会显示影响摘要，并拦截不支持的平台组合 / 无效同类对比配置
  - `D7 ROAS` 价值链路优先走 AppsFlyer cohort API，失败时回退 `raw_events`
  - 价值事实会显式标记 `revenue_source_missing`，避免把“数据缺口”误当成真实 0 收入
- ASA 关键词专项管理
  - Raw Data 获取关键词与收入
  - Master API 获取关键词级 cost / installs / average eCPI
  - Raw / Master API 请求级超时与 30 秒本地复核，缓解网络抖动
  - 独立 ASA 简报与飞书推送
- 每日简报
  - 通用简报
  - ASA 专项简报
  - 自动发送前会校验下游建议链路是否完成，避免“日报先发、建议后补”
  - 每日调度状态持久化到数据库，避免多实例部署时重复发送
- Feishu 多维表格投放执行表推送
  - 通用投放建议 + ASA 关键词建议合并到同一个 Base 内的按日归档执行表
  - 仅保留投放同学可直接使用的字段
  - 支持执行反馈回读、本地沉淀与 `七天后数据` 自动补列
  - 导入完成后自动向指定群聊发通知

## 主要模块

- `apps/api`
  - HTTP API
  - 内置 WebUI
- `packages/shared`
  - 数据访问、AppsFlyer / Feishu 集成、业务逻辑
- `workers/puller`
  - Pull 定时拉取
- `workers/daily-brief`
  - 通用日报定时发送（等待预算建议 + ASA 关键词链路完成）
- `workers/asa-keywords`
  - ASA 专项数据拉取与重算（按 `Pull 时间` 对齐）
- `workers/asa-daily-brief`
  - ASA 简报定时发送（等待预算建议 + ASA 关键词链路完成）
- `workers/bitable-export`
  - Feishu 多维表格定时导出（等待预算建议 + ASA 关键词链路完成）
- `workers/bitable-feedback-sync`
  - Feishu 执行反馈回读与 `七天后数据` 补列
- `infra`
  - Docker Compose、ClickHouse、Postgres 初始化脚本

## 文档索引

- 接口文档：`docs/API.md`
- WebUI 说明：`docs/UI.md`
- 表结构文档：`docs/SCHEMA.md`
- 启动 / 验证手册：`docs/RUNBOOK.md`
- Agent 部署手册：`docs/DEPLOYMENT_AGENT.md`
  - 面向远程服务器冷启动部署，适合低能力 Agent 线性执行
- 老环境升级清单：`docs/UPGRADE_CHECKLIST.md`
  - 面向已有运行中环境的增量升级与 schema / 凭据收口

## 快速开始

```bash
cd hotspot-system
cp .env.example .env
cd infra
docker compose up -d --build
```

启动后：

- API: `http://localhost:3000`
- WebUI: `http://localhost:3000/ui`

生产环境补充要求：

- 必须显式配置：
  - `ADMIN_BASIC_AUTH_USER`
  - `ADMIN_BASIC_AUTH_PASSWORD`
  - `POSTGRES_USER`
  - `POSTGRES_PASSWORD`
  - `POSTGRES_DB`
  - `CLICKHOUSE_USER`
  - `CLICKHOUSE_PASSWORD`
- `/ui` 与 `/api/*` 现在统一走登录页 + Cookie 会话，不再依赖浏览器原生 Basic Auth 弹窗
- 若启用 `Guru Ads Agent` 多模型，按需补充：
  - `QWEN_*`
  - `OPENROUTER_*`
  - `OPENAI_*`
- 若启用 cohort API 作为 `D7 ROAS` 主来源，建议显式配置：
  - `APPSFLYER_COHORT_ENDPOINT_TEMPLATE`
  - `APPSFLYER_COHORT_TIMEOUT_MS`
  - `APPSFLYER_COHORT_REQUEST_INTERVAL_MS`
- 未登录访问浏览器页面时：
  - `/ui` / `/ui/` 会跳转到 `/login`
  - `/api/*` 仍返回 `401`
- 登录 Cookie 仅在 HTTPS 或 `x-forwarded-proto=https` 时附加 `Secure`
  - 本地 `http://127.0.0.1:3000` 可正常登录验证
  - 线上建议始终走 HTTPS / 反向代理

## 最近补充

- 顶部全局调度配置（Pull / Push 时间统一管理）
- WebUI 全局 `Guru Ads Agent` 悬浮入口
- `Guru Ads Agent` 新增模型列表接口与多模型切换（Qwen / OpenRouter / OpenAI）
- `keyword-engine` 的 `D7 ROAS` 链路优先接入 AppsFlyer cohort API，并为缺口数据打 `revenue_source_missing`
- ASA keyword 成本切换到 AppsFlyer Master API
- Feishu 多维表格按日期留档、反馈回读与 `七天后数据` 自动补列
- 每日 worker 改为数据库持久化运行状态，避免多实例串行重复跑
- AppsFlyer Pull / ASA 链路新增请求级 timeout、错误分类与瞬时故障自愈
- 应用级预算 / ASA 规则配置改为向导式交互，并补平台支持与隐藏字段校验
- 默认 `09:00 / 10:00 / 10:05 (Asia/Shanghai)` 调度，可在页面顶部修改
