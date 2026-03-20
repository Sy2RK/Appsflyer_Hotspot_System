# ASA Monitor System

一个围绕 AppsFlyer 数据拉取、投放监控、预算建议、日报推送与 Feishu 多维表格导出的内部运营系统。

## 当前能力

- AppsFlyer Push Callback 入库与小时级聚合
- AppsFlyer Pull `daily_report_v5` 日级拉取与指标趋势
- WebUI 顶部全局调度配置
  - 统一编辑 `Pull 时间` 与 `推送时间`
  - `bitable-export` 自动使用 `推送时间 + 5 分钟`
- 通用投放项 / 广告系列监控与预算建议
- ASA 关键词专项管理
  - Raw Data 获取关键词与收入
  - Master API 获取关键词级 cost / installs / average eCPI
  - 独立 ASA 简报与飞书推送
- 每日简报
  - 通用简报
  - ASA 专项简报
- Feishu 多维表格原始数据推送
  - Pull 明细 -> 固定表
  - ASA Raw -> 同一 Base 下自动建表
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
- 表结构文档：`docs/SCHEMA.md`
- 启动 / 验证手册：`docs/RUNBOOK.md`
- Agent 部署手册：`docs/DEPLOYMENT_AGENT.md`
  - 面向远程服务器冷启动部署，适合低能力 Agent 线性执行

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

## 最近补充

- 顶部全局调度配置（Pull / Push 时间统一管理）
- ASA keyword 成本切换到 AppsFlyer Master API
- Feishu 多维表格原始数据推送模块
- 默认 `09:00 / 10:00 / 10:05 (Asia/Shanghai)` 调度，可在页面顶部修改
