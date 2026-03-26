# ASA Monitor System

一个围绕 AppsFlyer 数据拉取、投放监控、预算建议、日报推送与 Feishu 多维表格导出的内部运营系统。

## 当前能力

- AppsFlyer Push Callback 入库与小时级聚合
- AppsFlyer Pull `daily_report_v5` 日级拉取与指标趋势
- WebUI 顶部全局调度配置
  - 统一编辑 `Pull 时间` 与 `推送时间`
  - `bitable-export` 自动使用 `推送时间 + 5 分钟`
- WebUI 全局 AI 悬浮入口
  - 右下角提供统一的 AI 功能舱入口
  - 当前内置 Gemini 官网跳转
  - 后续可继续扩展诊断助手、投放 Copilot 等功能
- 通用投放项 / 广告系列监控与预算建议
  - 手动生成预算建议时支持进度条与 `已生成建议 / 总建议` 实时展示
- ASA 关键词专项管理
  - Raw Data 获取关键词与收入
  - Master API 获取关键词级 cost / installs / average eCPI
  - 独立 ASA 简报与飞书推送
- 每日简报
  - 通用简报
  - ASA 专项简报
- Feishu 多维表格投放执行表推送
  - 通用投放建议 + ASA 关键词建议合并到单张执行表
  - 仅保留投放同学可直接使用的字段
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
  - 通用日报定时发送
- `workers/asa-keywords`
  - ASA 专项数据拉取与重算
- `workers/asa-daily-brief`
  - ASA 简报定时发送
- `workers/bitable-export`
  - Feishu 多维表格定时导出
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
- 未登录访问浏览器页面时：
  - `/ui` / `/ui/` 会跳转到 `/login`
  - `/api/*` 仍返回 `401`
- 登录 Cookie 仅在 HTTPS 或 `x-forwarded-proto=https` 时附加 `Secure`
  - 本地 `http://127.0.0.1:3000` 可正常登录验证
  - 线上建议始终走 HTTPS / 反向代理

## 最近补充

- 顶部全局调度配置（Pull / Push 时间统一管理）
- WebUI 全局 Gemini 悬浮舱入口
- ASA keyword 成本切换到 AppsFlyer Master API
- Feishu 多维表格原始数据推送模块
- 默认 `09:00 / 10:00 / 10:05 (Asia/Shanghai)` 调度，可在页面顶部修改
