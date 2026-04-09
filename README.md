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
  - 支持自然语言自动查库：模型可通过内部只读 MCP 工具自动调用 `apps.list / metrics.get_trend / roas.get_summary / budget.get_summary / asa_keywords.get_summary`
  - `roas.get_summary` 专门用于“与简报 / 日报口径对齐”的成熟窗口 D7 ROAS 查询
    - `scope=budget`：每日简报 / 预算建议口径
    - `scope=asa`：ASA 简报 / ASA 看板口径
    - 返回结果会显式带 `报告日期` 与 `成熟窗口 from ~ to`
  - 会在回复里回显 `已自动查询什么`，并在需要时进入澄清轮次
  - 模型可按当前已配置凭据动态显示，默认优先使用可用的主模型
  - 面板内保留 Gemini 官网外部工具快捷入口
  - 后续可继续扩展诊断助手、投放 Copilot、日报快读等功能
- 通用投放项 / 广告系列监控与预算建议
  - 手动生成预算建议时支持进度条与 `已生成建议 / 总建议` 实时展示
  - 内置“应用级规则配置”向导，按 `app + platform + 建议类型` 单独维护规则
  - 国家 / 媒体阈值、上下文窗口、补充说明都支持结构化编辑
  - 保存前会显示影响摘要，并拦截不支持的平台组合 / 无效同类对比配置
  - `D7 ROAS` 价值链路改为直接使用 AppsFlyer cohort API 源数据
  - `D7 ROAS` 统一按成熟窗口读取：至少排除最近 7 天，再按策略窗口聚合
  - 价值事实会显式标记 `revenue_source_missing`，避免把“数据缺口”误当成真实 0 收入
  - 预算建议与导出会额外输出 `roas_window_from / roas_window_to / roas_data_status`
- ASA 关键词专项管理
  - Raw Data 获取关键词与收入
  - Master API 获取关键词级 cost / installs / average eCPI
  - Raw / Master API 请求级超时与 30 秒本地复核，缓解网络抖动
  - 独立 ASA 简报与飞书推送
  - `D7 ROAS / CPP` 已统一切到 Cohort API 源数据 + 成熟窗口口径
  - `待补齐 / 暂无成熟数据 / 真实 0.00` 三种状态会显式区分，不再混用
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

## 当前运行口径与注意事项

- 每日自动链路的真实顺序是：
  - `puller / keyword-engine / budget-advisor / asa-keywords` 在 `Pull 时间` 对前一报告日准备数据
  - `daily-brief / asa-daily-brief` 在 `推送时间` 到达后，会先等待 `budget-advisor` 与 `asa-keywords` 对应 `report_date` 完成，再决定是否发送
  - `bitable-export` 固定在 `推送时间 + 5 分钟` 检查，同样会等待这两个下游完成
- 当前最常见的“日报迟迟不发”原因不是日报 worker 本身报错，而是 `budget-advisor` 或 `asa-keywords` 还没有落下 completion log
- ASA cohort API 的瞬时 `404 / 5xx / timeout` 现在不会再默认把整轮 `asa-keywords` 自动任务卡死
  - 若本轮没有可调度重试失败，则允许以“降级完成”写入 worker completion，避免单个终态 slice 长期阻塞日报 / ASA 简报下游
- 全系统 `D7 ROAS / CPP` 已统一到“成熟窗口 + 覆盖率状态”口径
  - `complete`：成熟窗口成本全部被 Cohort 数据覆盖
  - `partial`：成熟窗口仍有缺口，但已覆盖成本占比达到可采纳阈值（当前 80%）；此时 `ROAS / CPP / 收入 / 购买数` 按已覆盖成本计算
  - `pending`：成熟窗口仍有缺口，且覆盖率低于 80%；UI 会显示“待补齐（源数据缺失）”
  - `unavailable`：当前还没有可用于判断的成熟窗口
- ASA 关键词管理页面中 `CPP / D7 ROAS` 即使不是全量为 0，也可能因为成熟窗口覆盖率尚未达到 80% 而统一显示“待补齐（源数据缺失）”
- `Guru Ads Agent` 当前已接入多模型与内部 MCP 自动查库，但模型列表展示的是“当前已配置且可选”，不是 provider 的绝对能力承诺
  - `Kimi-K2.5 (OpenRouter)` 仍可能因 provider 账号、地区或图片能力限制，在发送时返回 provider 侧失败
  - 自动查库依赖 `mcp-server`；若内部 MCP 超时或不可达，最终会体现在 AI chat warning / timeout，而不是静默回退为纯模型回答
- Docker 磁盘占用的主要风险通常来自 `Docker.raw` 内的历史卷、build cache 与旧镜像，而不是退出容器数量本身
  - 长期运行环境建议定期核对未挂载卷、build cache 和历史镜像，避免宿主机可用空间过低影响 Docker Desktop 与 worker 稳定性

## 主要模块

- `apps/api`
  - HTTP API
  - 内置 WebUI
- `apps/mcp-server`
  - Guru Ads Agent 内部只读 MCP 服务
  - 当前承接业务型只读工具，不直接对公网暴露
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
- 若启用 `Guru Ads Agent` 自动查库链路，补充：
  - `MCP_BASE_URL`
  - `MCP_TIMEOUT_MS`
  - `MCP_INTERNAL_TOKEN`
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
- `Guru Ads Agent` 新增内部 `mcp-server` 与原生 function calling 自动查库链路
- AI chat 请求现在会默认附带当前页面上下文，并在回复中返回 `tool_trace / agent_action / clarification_count`
- `keyword-engine` 的 `D7 ROAS` 链路已切换为 AppsFlyer cohort API 源数据，并为缺口数据打 `revenue_source_missing`
- 预算建议、ASA 建议、ASA 简报、多维表中的 `D7 ROAS` 已统一为“Cohort API 源数据 + 成熟窗口”口径
- ROAS 缺口会显示 `待补齐 / 部分可采纳 / 暂无成熟数据`，不再把源数据缺失展示成 `0.00`
- ASA keyword 成本切换到 AppsFlyer Master API
- Feishu 多维表格按日期留档、反馈回读与 `七天后数据` 自动补列
- 每日 worker 改为数据库持久化运行状态，避免多实例串行重复跑
- AppsFlyer Pull / ASA 链路新增请求级 timeout、错误分类与瞬时故障自愈
- 应用级预算 / ASA 规则配置改为向导式交互，并补平台支持与隐藏字段校验
- 默认 `09:00 / 10:00 / 10:05 (Asia/Shanghai)` 调度，可在页面顶部修改
