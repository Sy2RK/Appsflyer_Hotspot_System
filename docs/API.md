# API

## 1) AppsFlyer Push Callback

### `GET /appsflyer/api/v1/event/:appKey/:dataset/callback`
用于 AppsFlyer callback URL 可达性验证。

Response:
```json
{
  "ok": true,
  "appKey": "ai-video-plus",
  "dataset": "ods_events_device_detail"
}
```

### `POST /appsflyer/api/v1/event/:appKey/:dataset/callback`
Headers:
- `Authorization: <push_token>`
- `Content-Type: application/json`

Body:
- AppsFlyer Push JSON payload（对象或对象数组）

行为:
1. 校验 `app_key + dataset` 是否存在
2. 校验 `Authorization` 与该 app 配置 token 一致
3. 标准化 payload 为 `NormalizedEvent`
4. 生成 `event_uid`（优先 payload 唯一字段；否则 md5 规则）
5. 幂等检查（event_uid）
6. 写入 ClickHouse `raw_events`

Response:
- 成功: `204 No Content`
- 鉴权失败: `401`
- body 非 JSON: `400`

---

## 2) Internal API

### `GET /ui`
内置 Web 控制台（配置管理 + 告警与指标可视化）。

### `GET /api/ai/models`
返回当前 `Guru Ads Agent` 可用模型列表。

返回重点字段：
- `default_model_id`
- `models[].id`
- `models[].label`
- `models[].provider`
- `models[].provider_label`
- `models[].model`
- `models[].supports_images`
- `models[].supports_thinking`

说明：
- 模型列表仅返回当前已配置凭据且可用的模型
- `Guru Ads Agent` 的自动查库链路会复用当前选中的模型来发起 tool calling
- `Kimi-K2.5 (OpenRouter)` 在模型列表里按“当前配置可选”展示；若 provider 侧账号、地区或图片能力存在限制，仍可能在实际请求时报对应 provider 错误

示例响应：
```json
{
  "ok": true,
  "data": {
    "default_model_id": "qwen",
    "models": [
      {
        "id": "qwen",
        "label": "Qwen 3.6-Plus",
        "provider": "dashscope",
        "provider_label": "DashScope",
        "model": "qwen3.6-plus",
        "supports_images": true,
        "supports_thinking": true
      },
      {
        "id": "openrouter_kimi_k25",
        "label": "Kimi-K2.5 (OpenRouter)",
        "provider": "openrouter",
        "provider_label": "OpenRouter",
        "model": "moonshotai/kimi-k2.5",
        "supports_images": true,
        "supports_thinking": false
      }
    ]
  }
}
```

### `POST /api/ai/chat`
`Guru Ads Agent` 对话接口，当前供 WebUI 右下角 AI 抽屉调用。

请求要求：
- `content-type` 必须为 `multipart/form-data`

表单字段：
- `message`
  - 用户输入文本，可空
- `model_id`
  - 可选
  - 当前支持：`qwen`、`openrouter_kimi_k25`、`openai_gpt54`
  - 不传时自动回退到当前默认模型
- `history_json`
  - 最近多轮对话，JSON 数组
  - 每项格式：`{ "role": "user|assistant", "content": "...", "meta": { ... } }`
- `context_packs_json`
  - 已附加的数据库聚合上下文包，JSON 数组
- `page_context_json`
  - 当前页面上下文，JSON 对象
  - 当前由 WebUI 自动附带，供模型自动补齐 `app/platform/from/to` 等参数
- `images`
  - 图片文件，可重复传多个

限制：
- `images` 最多 4 张
- 图片类型仅支持：`image/png`、`image/jpeg`、`image/webp`
- 单张最大 5MB
- `context_packs_json` 最多 3 个
- `message / images / context_packs_json` 三者至少要有一个

返回重点字段：
- `model_id`
- `model`
- `model_label`
- `provider`
- `reply`
- `agent_action`
  - `answer | clarification`
- `tool_trace`
  - 本轮自动查询痕迹
- `clarification_count`
- `attachments_used`
- `warnings`
- `usage`

常见错误：
- `multipart_form_data_required`
- `message_or_attachment_required`
- `too_many_images`
- `too_many_context_packs`
- `unsupported_image_type`
- `image_too_large`
- `invalid_model_id`
- `ai_model_unavailable`
- `ai_model_images_unsupported`
- `ai_chat_timeout`
- `mcp_context_unavailable`
- `openrouter_region_unavailable`

说明：
- 模型列表以 `GET /api/ai/models` 返回结果为准
- 是否支持图片 / thinking 由模型配置动态决定
- 这条接口现在默认支持自然语言自动查库：后端会把当前页面上下文和内部 MCP 工具定义一起发送给当前模型
- 当前自动工具面固定为只读业务工具：
  - `apps.list`
  - `metrics.get_trend`
  - `budget.get_summary`
  - `asa_keywords.get_summary`
- 手动附加的数据包优先于自动查询；命中同一查询时会优先复用手动数据包结果
- 若 MCP 工具或上下文包查询超时，最终会收敛为 `ai_chat_timeout` 或业务可读 warning，而不是原始协议错误串
- `Kimi-K2.5 (OpenRouter)` 即使在模型列表中可见，特定账号或地区下仍可能返回 provider 侧限制错误

### `POST /api/ai/context-packs/preview`
预构建数据库聚合上下文包，用于前端调试或未来的预览能力。

Request:
```json
{
  "contextPacks": [
    {
      "type": "metrics_trend",
      "templateId": "media_source",
      "appKey": "demo-app",
      "platform": "ios",
      "from": "2026-03-01",
      "to": "2026-03-14"
    }
  ]
}
```

限制：
- `contextPacks` 至少 1 个，最多 3 个

返回重点字段：
- 每个上下文包的标题、筛选条件、摘要文本、是否截断

### `GET /api/apps`
返回 app 列表（不返回 push token），包含：
- `display_name`
- `ios_display_name`
- `android_display_name`
- `ios_pull_app_id`
- `android_pull_app_id`
- `pull_app_id`
- 通知通道配置摘要（是否存在 app 级 Feishu / Webhook）

### `POST /api/apps`
新增或更新 app 配置（upsert）。

Request:
```json
{
  "display_name": "Zensi",
  "ios_display_name": "Zensi iOS",
  "android_display_name": "Zensi Android",
  "app_key": "ai-video-plus",
  "ios_pull_app_id": "id6746191879",
  "android_pull_app_id": "com.demo.android.appid",
  "pull_app_id": "id6746191879",
  "dataset": "ods_events_device_detail",
  "timezone": "Asia/Shanghai",
  "push_auth_token": "optional-new-token",
  "notify_feishu_app_id": "cli_xxx",
  "notify_feishu_app_secret": "xxx",
  "notify_feishu_chat_id": "oc_xxx",
  "notify_webhook_url": "https://optional-webhook"
}
```

说明:
- `app_key` 必填。
- `ios_pull_app_id` / `android_pull_app_id` / `pull_app_id` 三者至少填一个。
- `ios_pull_app_id` 与 `android_pull_app_id` 不允许相同。
- `pull_app_id` 为兼容字段，建议优先配置 iOS/Android 分字段。
- `display_name` 仅用于展示；不填时默认使用 `app_key` 去掉 `-`（例如 `ai-screen-time-coach` -> `ai screen time coach`）。
- `ios_display_name` / `android_display_name` 仅用于展示；未填时回退到 `display_name` 或 `app_key`。
- 若不显式提交 `notify_feishu_app_secret`，后端不会覆盖已有 secret；留空默认回退 `.env` 全局 Feishu 配置。

### `GET /api/rules?appKey=`
按 app 查询规则。

### `POST /api/rules`
创建或更新规则。

Request:
```json
{
  "app_key": "ai-video-plus",
  "name": "revenue-hotspot-rule",
  "enabled": true,
  "rule_json": {
    "timezone": "Asia/Shanghai",
    "silence_minutes": 30,
    "metrics": [
      {
        "metric": "revenue",
        "granularity": "hour",
        "window": "last_1h",
        "baseline": "avg_7d_same_hour",
        "up_ratio": 2,
        "down_ratio": 0.5,
        "min_abs_delta": 50,
        "severity": {"spike": "P1", "drop": "P0"},
        "drilldown_dims": ["media_source", "country", "campaign", "attribution", "event_type"]
      }
    ]
  }
}
```

### `POST /api/rules/:id/enable`
启用规则。

### `POST /api/rules/:id/disable`
停用规则。

### `GET /api/alerts?appKey=&status=&severity=&from=&to=`
查询告警。

### `GET /api/alerts/:id`
查询告警详情。

### `GET /api/metrics?appKey=&metric=&from=&to=&source=push|pull&granularity=...&dims=...&eventName=&platform=`
查询指标（支持 Push 小时级 + Pull 日级）。

参数说明:
- `source`:
  - `push`（默认）: 查询 `metrics_hourly`
  - `pull`: 查询 `metrics_daily`
- 当 `source=push`:
  - `granularity` 必须为 `hour`
  - `metric`: `revenue` / `event_count` / `purchase_count`
  - `dims`: `media_source,country,campaign,attribution,event_type,event_name,platform`
  - `eventName`: 当 `metric=event_count` 且需指定事件时使用
- 当 `source=pull`:
  - `granularity` 必须为 `day`
  - `metric`: `installs` / `clicks` / `total_cost`
  - `dims`: `media_source,country,campaign,source,platform`
- `platform` 可选：`ios|android|unknown`

### `GET /api/pull-records?appKey=&from=&to=&platform=&mediaSource=&campaign=&page=&sort=`
查询 Pull 明细记录（来自 `pull_aggregate_daily`）。

参数说明:
- `from` / `to` 必填，格式 `YYYY-MM-DD`
- `appKey` 可选，精确过滤
- `mediaSource` 可选，模糊过滤
- `campaign` 可选，模糊过滤
- `platform` 可选：`ios|android|unknown`
- `page` 可选，默认 `1`
- `pageSize` 固定为 `20`（服务端强制）
- `sort` 白名单：`ingest_time_desc`（默认）/ `ingest_time_asc`

响应:
```json
{
  "ok": true,
  "data": [
    {
      "ingest_time": "2026-03-03 18:38:57",
      "date": "2026-03-02",
      "app_key": "ai-seek",
      "platform": "ios",
      "media_source": "Apple Search Ads",
      "campaign": "Novix_iTunes_us_1226_broad_BR_br",
      "installs": 36,
      "clicks": 93,
      "total_cost": 42.9723,
      "source_report": "daily_report_v5",
      "raw_json": "{...}"
    }
  ],
  "meta": {
    "page": 1,
    "pageSize": 20,
    "total": 10,
    "totalPages": 1,
    "from": "2026-03-01",
    "to": "2026-03-03"
  }
}
```

### `POST /api/pull-records/trigger`
手动触发一次 Pull 读取（默认回填 1 天），返回读取详情，用于 WebUI 弹窗展示。

Request:
```json
{
  "backfillDays": 1
}
```

返回结果补充：
- `retryable_failed_count`：仍会消耗 worker 冷却重试预算的失败数
- `terminal_failed_count`：不会继续调度重试的确定性失败数
- `details[*].failure_kind`：失败分类，常见值有 `timeout / network / rate_limit / auth / not_found / invalid_request / server`
- `details[*].retryable`：该失败是否仍值得后续调度重试
- `details[*].attempts` / `details[*].recovered_by_retry`：30 秒本地复核次数与是否已自动恢复

### `DELETE /api/pull-records`
按明细记录主维度删除 Pull 数据，并同步删除对应 `metrics_daily` 指标。

Request:
```json
{
  "ingest_time": "2026-03-03 18:38:57",
  "date": "2026-03-02",
  "app_key": "ai-seek",
  "platform": "ios",
  "media_source": "Apple Search Ads",
  "campaign": "Novix_iTunes_us_1226_broad_BR_br",
  "source_report": "daily_report_v5"
}
```

Response:
```json
{
  "ok": true,
  "data": {
    "started_at": "2026-03-03T11:10:00.000Z",
    "ended_at": "2026-03-03T11:10:02.000Z",
    "duration_ms": 2000,
    "backfill_days": 1,
    "apps": 3,
    "success_count": 3,
    "failed_count": 0,
    "skipped_count": 0,
    "details": [
      {
        "app_key": "ai-seek",
        "platform": "ios",
        "date": "2026-03-02",
        "status": "ok",
        "rows": 2,
        "metrics_rows": 6
      }
    ]
  }
}
```

### `GET /api/keywords/lifecycle?appKey=&platform=&from=&to=&stage=&keyword=&page=&pageSize=`
查询关键词生命周期状态（分页）。

参数说明:
- `appKey` 可选
- `platform` 可选：`ios|android|unknown`
- `from` / `to` 可选，格式 `YYYY-MM-DD`
- `stage` 可选：`new|learning|scaling|stable|declining|pause_candidate`
- `keyword` 可选，模糊匹配
- `page` 默认 `1`
- `pageSize` 默认 `20`，最大 `100`

### `GET /api/keywords/:keyword/trend?appKey=&platform=&days=&matchType=`
查询关键词趋势（日级，来源 `keyword_daily_metrics`）。

参数说明:
- `appKey` 必填
- `platform` 可选（推荐传入，避免 iOS/Android 混合）
- `days` 可选，默认 `30`
- `matchType` 可选

### `POST /api/keywords/recompute`
手动触发关键词生命周期重算。

Request:
```json
{
  "backfillDays": 30
}
```

### `GET /api/asa-keywords?appKey=&platform=&stage=&from=&to=&keyword=&campaign=&page=&pageSize=`
查询 ASA 真实关键词看板（仅 `Apple Search Ads`）。

口径说明：
- `keyword / campaign / adset / 收入事件`：来自 AppsFlyer Raw Data
- `cost / installs / average_ecpi`：来自 AppsFlyer Master API
- ASA 主粒度：`keyword + campaign + adset`
- `D7 ROAS / CPP`：统一使用 Cohort API 源数据 + 成熟窗口口径
- 返回中的 `roas_data_status` 用于区分：
  - `complete`：成熟窗口 Cohort 数据完整
  - `partial`：成熟窗口内仍有 Cohort 缺口，但覆盖率已达到可采纳阈值（当前 80%）；此时 `ROAS / CPP` 按已覆盖成本计算
  - `partial_low`：成熟窗口覆盖率偏低但仍有部分 Cohort 数据；当前值仅供参考，不直接驱动动作
  - `pending`：成熟窗口内存在 Cohort 源数据缺口，且覆盖率低于 80%
  - `unavailable`：当前还没有可用于判断的成熟窗口数据

返回：
- `data`: ASA 关键词状态列表
- `summary`: `keyword_count / installs / total_cost / ecpi / cpp / d7_roas`
- `summary_window`: ASA 简报与看板摘要使用的成熟窗口
- `meta`: 分页信息

返回字段补充：
- `adset`
- `current_ecpi / current_cpp / current_d7_roas`
- `target_ecpi / target_cpp / target_d7_roas`
- `roas_window_from / roas_window_to / roas_data_status`

### `GET /api/asa-keywords/:keyword/trend?appKey=&platform=&campaign=&adset=`
查询单个 ASA keyword 的日级趋势（来源 `asa_keyword_daily_metrics_v2`）。

说明：
- `campaign` 与 `adset` 必填，用于避免同名 keyword 跨广告组混淆
- 返回中包含：
  - `adset`
  - `average_ecpi`

### `GET /api/asa-keywords/stages`
查询产品阶段配置（`app + platform -> rising|stable`）。

### `POST /api/asa-keywords/stages`
保存产品阶段配置。

Request:
```json
{
  "appKey": "ai-seek",
  "platform": "ios",
  "stage": "rising",
  "enabled": true
}
```

### `POST /api/asa-keywords/recompute`
触发 ASA Raw Data + Master API 拉取、聚合、状态重算与建议生成。

Request:
```json
{
  "backfillDays": 30
}
```

说明：
- Raw Data 只负责 keyword / 收入 / 安装事件
- Master API 负责 keyword 级 `cost / installs / average_ecpi`
- 每个 `app + platform + date` 切片会先做一次 30 秒本地复核，再决定是否进入 worker 级冷却重试

返回结果补充：
- `failed_slice_count`
- `retryable_failed_slice_count`
- `terminal_failed_slice_count`
- `recovered_slice_count`

### `GET /api/asa-keywords/brief/preview?reportDate=&appKey=&platform=`
预览 ASA 专项简报。建议操作已并入简报正文。

### `POST /api/asa-keywords/brief/send`
发送 ASA 专项简报到 Feishu。建议操作会随简报一并发送。

### `GET /api/recommendation-policies?appKey=&platform=&engine=&enabled=`
查询应用级规则配置列表。

参数说明：
- `appKey` 可选
- `platform` 可选：`ios|android|unknown`
- `engine` 可选：`budget|asa`
- `enabled` 可选：`true|false`

返回重点字段：
- `app_key`, `platform`, `engine`
- `enabled`
- `rule_json`
- `manual_prompt_markdown`
- `effective_support`

说明：
- 唯一键为 `app_key + platform + engine`
- WebUI 的“应用级规则配置”向导也使用这组接口

### `POST /api/recommendation-policies`
创建或更新应用级规则配置。

Request:
```json
{
  "appKey": "ai-seek",
  "platform": "ios",
  "engine": "budget",
  "enabled": true,
  "ruleJson": {
    "metric_family": "ecpi",
    "decision_mode": "deterministic",
    "traffic_scope": "all",
    "media_sources": [],
    "maturity_window": {
      "exclude_recent_days": 7,
      "decision_window_days": 14,
      "context_window_days": [7, 14, 21]
    },
    "targets": {
      "global_targets": {
        "ecpi_max": 3
      }
    },
    "spend_policy": {
      "low_spend_threshold_usd": 10,
      "high_spend_threshold_usd": 100,
      "trend_lookback_days": 7,
      "uptrend_min_ratio": 0.15
    }
  },
  "manualPromptMarkdown": "低量级先看跑量能力，不要只看短期回收。"
}
```

校验补充：
- `appKey + platform + engine` 必填
- `platform` 必须是 `ios|android|unknown`
- 应用必须真实存在，且必须支持当前平台
  - `ios` 依赖 `ios_pull_app_id`
  - `android` 依赖 `android_pull_app_id`
  - `unknown` 依赖兼容字段 `pull_app_id`
- `traffic_scope=media_sources` 时，必须提供至少 1 个媒体源
- `metric_family=relative_compare` 时，必须至少提供 1 个比较指标

常见错误返回：
- `appKey_platform_engine_required`
- `invalid_platform`
- `app_not_found`
- `app_platform_not_supported`
- `invalid_metric_family`
- `invalid_decision_mode`
- `invalid_traffic_scope`
- `invalid_media_sources`
- `invalid_window`
- `invalid_rule_json`
- `invalid_relative_compare`

返回格式：
```json
{
  "ok": false,
  "error": "invalid_media_sources",
  "message": "已选择指定媒体源，但媒体源列表为空，请至少添加一个媒体源。"
}
```

### `GET /api/budget/recommendations?appKey=&platform=&status=&from=&to=&executionStatus=&isAdopted=&hasManualReview=&page=`
查询预算建议（分页）。

参数说明:
- `appKey` 可选
- `platform` 可选：`ios|android|unknown`
- `status` 可选：`pending|applied|rejected|expired`
- `from` / `to` 可选，格式 `YYYY-MM-DD`
- `executionStatus` 可选：按飞书回读后的执行状态过滤
- `isAdopted` 可选：`true|false`
- `hasManualReview` 可选：`true|false`
- `page` 默认 `1`

返回新增字段：
- `execution_status`
- `is_adopted`
- `validation_result`
- `feedback_synced_at`

### `POST /api/budget/recommendations/:id/mark-applied`
将建议标记为已执行（`status=applied`）。

### `POST /api/budget/recommendations/:id/reject`
将建议标记为已拒绝（`status=rejected`）。

### `POST /api/budget/recommendations/recompute`
手动触发预算建议生成（含 Qwen 文案增强）。

### `GET /api/budget/recommendations/recompute/status`
查询当前预算建议生成进度。

返回重点字段：
- `running`: 是否仍在生成
- `generated_total`: 当前已生成建议数
- `total_candidates`: 当前已识别的总候选建议数
- `processed_apps` / `total_apps`: 应用级处理进度
- `current_app`: 当前正在处理的应用
- `error`: 失败时的错误信息

预算建议当前关键字段:
- `current_ecpi`: 当前官方 `average_ecpi`
- `target_ecpi`: 同 app / 同平台近期关键词 eCPI 中位基线
- `volume_tier`: `low|medium|high`

规则摘要:
- `low`: 最近 3 天激活 `< 15`，默认观察
- `medium`: 最近 3 天激活 `15-30`
- `high`: 最近 3 天激活 `> 30`
- 单次建议幅度固定 `20%`

### `GET /api/budget/recommendations/feedback-export`
导出预算建议 + 飞书执行反馈数据集，格式固定为 `NDJSON`。

支持参数：
- `appKey`
- `platform`
- `status`
- `from`
- `to`
- `executionStatus`
- `isAdopted`
- `hasManualReview`

返回说明：
- `content-type: application/x-ndjson`
- 每行固定包含 `identity / recommendation / context / feedback / meta`

### `GET /api/budget/recommendations/skills/latest`
查询最新一版预算反馈 `skills.md`。

返回重点字段：
- `skills_markdown`
- `dataset_row_count`
- `from_date`
- `to_date`
- `model`
- `prompt_hash`
- `created_at`

### `GET /api/budget/recommendations/skills/latest/download`
下载最新 `skills.md` 文件。

### `GET /api/daily-brief/preview?reportDate=YYYY-MM-DD`
生成每日报告预览，不发送。

返回重点字段:
- `title`
- `summary`
- `today_judgment`
- `app_rows`
- `budget_highlights`
- `alert_highlights`
- `action_items`
- `render_mode`
- `feishu_card_payload`
- `text`

### `POST /api/daily-brief/send`
生成并发送每日报告到飞书。

Request:
```json
{
  "reportDate": "2026-03-09",
  "force": true
}
```

说明:
- 当前日报推送默认使用 Feishu `interactive card`
- 若卡片发送失败，会自动回退到纯文本发送
- `force=true` 时即使当天发过也会再次发送

### `GET /api/runtime-schedule`
查询当前全局调度配置快照。

返回：
- `singleton_key`
- `pull_time`
- `push_time`
- `bitable_time`
- `timezone`
- `created_at`
- `updated_at`

示例：
```json
{
  "ok": true,
  "data": {
    "singleton_key": "global",
    "pull_time": "09:00",
    "push_time": "10:00",
    "bitable_time": "10:05",
    "timezone": "Asia/Shanghai",
    "created_at": "2026-03-20T07:20:16.000Z",
    "updated_at": "2026-03-20T07:20:16.000Z"
  }
}
```

说明：
- `pull_time` 控制：
  - `puller`
  - `budget-advisor`
  - `asa-keywords`
- `push_time` 控制：
  - `daily-brief`
  - `asa-daily-brief`
- `bitable_time` 不单独存库，固定按 `push_time + 5 分钟` 计算
- 自动闭环 gate：
  - `daily-brief` / `asa-daily-brief` / `bitable-export` 除了等待 `pull_report_readiness=ready`
  - 还会额外等待 `budget-advisor` 与 `asa-keywords` 针对同一 `reportDate` 的长任务真正完成
  - 未完成时 worker 会持续输出 `*_blocked_by_downstream_gate` 日志而不是提前发送

### `POST /api/runtime-schedule`
保存全局调度配置。

Request:
```json
{
  "pullTime": "09:00",
  "pushTime": "10:00"
}
```

说明：
- `pullTime` / `pushTime` 必须是 `HH:MM` 格式
- 保存成功后，worker 会在下一轮检查时读取新配置，不需要手动改 `.env`
- 页面入口位于 WebUI 顶部 `全局调度设置`

### `GET /api/bitable-exports/configs`
查询 Feishu 多维表格导出配置快照。

返回：
- `sources`: 当前固定只返回一种导出源配置
  - `delivery_actions`

每个 source 包含：
- `label`
- `fields`
- `config`
- `table_url`
- `latest_table_url`
- `recent_tables`
- `target_table_hint`

说明：
- `delivery_actions` 会在同一 Base 下按 `reportDate` 创建 / 复用日期表，例如 `投放执行表_2026-03-27`
- 表内只保留可执行信息，不再导出 Pull 明细 / ASA Raw / `raw_json`
- 第一版不开放 Base / Table ID 前端编辑

### `POST /api/bitable-exports/configs/:sourceType`
保存投放执行表推送配置。

Path 参数：
- `sourceType`: `delivery_actions`

Request:
```json
{
  "enabled": true,
  "chatId": "oc_xxx",
  "tableNamePrefix": "投放执行表"
}
```

说明：
- `enabled=true` 且 `chatId` 非空时，才会被每日 `bitable_time` 定时任务纳入执行
- `tableNamePrefix` 决定每日日期表名，最终格式为 `前缀_YYYY-MM-DD`
- 字段列为系统固定输出，接口传入的 `selectedFields` 会被忽略
- `bitable_time` 固定按全局 `push_time + 5 分钟` 计算
- 自动定时导出除了依赖 Pull 完成，也会等待 `budget-advisor` 与 `asa-keywords` 针对该 `reportDate` 完成，避免导出中间态建议

### `POST /api/bitable-exports/run`
手动执行一次投放执行表导出到 Feishu 多维表格，并向指定群聊发送结果通知。

Request:
```json
{
  "sourceType": "delivery_actions",
  "reportDate": "2026-03-18"
}
```

返回重点字段：
- `source_type`
- `report_date`
- `table_id`
- `table_name`
- `table_name_prefix`
- `table_url`
- `selected_fields`
- `deleted_count`

### `POST /api/bitable-exports/feedback-sync`
手动执行一次飞书投放执行表反馈回读。

Request:
```json
{
  "sourceType": "delivery_actions"
}
```

返回重点字段：
- `source_type`
- `table_id`
- `table_count`
- `synced_table_ids`
- `synced_count`
- `skipped_count`
- `feedback_changed`
- `synced_at`
- `latest_skill_updated_at`

说明：
- 每次都只刷新对应 `reportDate` 的日期表，不会删除其他日期归档表
- 历史日期表的人工反馈修改也会继续回读
- 群通知使用与现有日报相同的 Feishu bot
- `delivery_actions`：
  - 仅导出当前仍待处理的建议项（`pending`）
  - 通用投放部分来自 `budget_recommendations + keyword_lifecycle_states`
  - ASA 部分来自 `asa_keyword_recommendations + asa_keyword_states`
  - 表内使用 `执行状态`（单选）+ `是否采纳`（复选框）+ `人工批复` 字段；同一天重导时会尽量保留已有填写结果
  - 目标表会在同一 Base 下自动创建 / 复用 `投放执行表_YYYY-MM-DD`

### `GET /api/operation-logs?source=&status=&limit=`
查询系统操作日志。

参数说明:
- `source` 可选：如 `api.daily_brief`、`worker.puller`、`api.bitable_export`、`worker.bitable_export`
- `status` 可选：`success|failed|skipped|info`
- `limit` 默认 `50`

用途:
- 查看手动操作
- 查看各 worker 定时执行结果
- 追踪日报、Pull、预算、关键词重算等操作

---

## 3) 验收用例（MVP）

1. `GET callback` 返回 `ok=true`
2. `POST callback`（带 Authorization）写入 `raw_events`
3. 5 分钟内 `metrics_hourly` 产生聚合
4. 模拟异常（提升 revenue/purchase）触发 `alerts`
5. 同 fingerprint 30 分钟内告警抑制
6. 指标恢复后 open alert 变 resolved 并发送恢复通知
7. `GET /api/daily-brief/preview` 可生成结构化日报预览
8. `POST /api/daily-brief/send` 可发送飞书日报卡片
9. `GET /api/runtime-schedule` / `POST /api/runtime-schedule` 可读取并更新全局调度时间
10. `GET /api/bitable-exports/configs` / `POST /api/bitable-exports/run` 可执行原始数据多维表格导出
11. `GET /api/operation-logs` 可查询操作与定时任务执行记录
