# SCHEMA

## 1) ClickHouse

### `raw_events`
- 明细事件表（Push 入库）
- 引擎: `MergeTree`
- 分区: `toYYYYMM(event_date)`
- 排序: `(app_key, event_date, event_name, media_source, country, campaign, event_time, event_uid)`

关键字段:
- `event_time`, `ingest_time`, `app_key`, `dataset`
- `event_name`, `event_type`, `attribution`
- `media_source`, `campaign`, `country`, `platform`
- `revenue`, `currency`
- `event_uid FixedString(32)`
- `raw_json`

### `metrics_hourly`
- 小时指标聚合表（detector 输入）
- 引擎: `ReplacingMergeTree(version)`
- 分区: `toYYYYMM(hour)`
- 排序: `(app_key, platform, hour, metric, event_name, attribution, event_type, media_source, country, campaign)`

字段:
- `hour`, `app_key`, `metric`, `value`
- `event_name`, `platform`
- `attribution`, `event_type`
- `media_source`, `country`, `campaign`
- `version`

### `pull_aggregate_daily`
- Pull API 每日聚合（原始 + 标准化列）
- 保留兼容列: `country, revenue, events`
- 新增标准列:
  - `agency_pmd`
  - `impressions`
  - `clicks`
  - `ctr`
  - `installs`
  - `conversion_rate`
  - `sessions`
  - `loyal_users`
  - `loyal_users_installs_ratio`
  - `total_cost`
  - `average_ecpi`
  - `source_report`
  - `pull_window_from`
  - `pull_window_to`

### `metrics_daily`
- Pull 日级指标聚合表（第一阶段可视化查询）
- 引擎: `ReplacingMergeTree(version)`
- 分区: `toYYYYMM(date)`
- 排序: `(app_key, platform, date, metric, media_source, campaign, country, source)`

字段:
- `date`, `app_key`, `metric`, `value`
- `platform`
- `media_source`, `campaign`, `country`
- `source`（例: `pull_daily_report_v5`）
- `version`

### `keyword_daily_metrics`
- 关键词代理项（日级）事实表（由 `campaign` 解析得到 `keyword + match_type`）
- 引擎: `ReplacingMergeTree(version)`
- 分区: `toYYYYMM(date)`
- 排序: `(app_key, platform, date, keyword, match_type, campaign, media_source, country)`

字段:
- `date`, `app_key`, `platform`
- `keyword`, `match_type`
- `campaign`, `media_source`, `country`
- `installs`, `clicks`, `total_cost`, `cpi`, `cvr`
- `af_average_ecpi`
- `source_report`
- `version`

---

## 2) Postgres

### `apps`
- `app_key` 唯一
- 维护 Push token、dataset、timezone、通知通道

字段:
- `id`
- `app_key` (unique)
- `display_name`（展示名称，空值时前端/接口会回退为去掉 `-` 的 `app_key`）
- `ios_display_name`
- `android_display_name`
- `ios_pull_app_id`（iOS Pull API app-id，通常 `idxxxx`）
- `android_pull_app_id`（Android Pull API app-id）
- `pull_app_id`（兼容字段，建议仅作为回退）
- `dataset`
- `push_auth_token`
- `timezone`
- `notify_webhook_url`
- `notify_feishu_app_id`
- `notify_feishu_app_secret`
- `notify_feishu_chat_id`
- `created_at`, `updated_at`

### `rules`
- 每个 app 可有多条规则
- `rule_json` 存 DSL

字段:
- `id`
- `app_key` (fk -> apps.app_key)
- `name`
- `enabled`
- `rule_json` (jsonb)
- `created_at`, `updated_at`

### `alerts`
- 告警状态机（open/resolved）
- `fingerprint` 用于抑制

字段:
- `id`
- `app_key`
- `rule_id` (nullable)
- `severity` (`P0/P1/P2`)
- `status` (`open/resolved`)
- `metric`, `window`
- `current_value`, `baseline_value`, `delta_value`, `delta_ratio`
- `top_contributors` (jsonb)
- `explanation`
- `fingerprint`
- `created_at`, `updated_at`, `resolved_at`

索引:
- `uq_alert_open_fingerprint`（部分唯一索引，`status='open'`）
- `idx_alerts_lookup`
- `idx_rules_app_enabled`

### `keyword_extract_rules`
- campaign -> keyword 提取规则（按 priority 依次命中）

字段:
- `id`
- `app_key` (fk -> apps.app_key)
- `priority`
- `regex_pattern`
- `keyword_group_index`
- `match_type_group_index` (nullable)
- `enabled`
- `created_at`, `updated_at`

### `keyword_lifecycle_states`
- 关键词生命周期状态机快照

字段:
- `id`
- `app_key`
- `platform`
- `keyword`
- `match_type`
- `current_stage` (`new|learning|scaling|stable|declining|pause_candidate`)
- `stage_score`
- `first_seen_date`, `last_seen_date`
- `days_in_stage`
- `last_cpi`, `last_installs`, `last_clicks`
- `trend_json`
- `created_at`, `updated_at`

### `budget_recommendations`
- 预算半自动建议（第一阶段仅建议，不自动执行）

字段:
- `id`
- `app_key`
- `platform`
- `keyword`
- `match_type`
- `date`
- `action` (`increase|decrease|hold|pause`)
- `change_ratio`
- `suggested_budget`
- `current_cost`
- `current_ecpi`
- `target_ecpi`
- `volume_tier` (`low|medium|high`)
- `expected_installs_delta`
- `confidence`
- `reason_code`
- `llm_summary`
- `status` (`pending|applied|rejected|expired`)
- `created_at`, `updated_at`

### `llm_audit_logs`
- LLM 调用审计日志

字段:
- `id`
- `biz_type`, `biz_id`
- `model`
- `prompt_hash`
- `response_json`
- `latency_ms`
- `success`
- `created_at`

### `daily_brief_dispatches`
- 每日报告发送记录，保证每日发送幂等并保留 payload 审计

字段:
- `id`
- `report_date`
- `channel`
- `status`
- `message_id`
- `payload_json`
- `sent_at`
- `created_at`
- `updated_at`

### `operation_logs`
- 统一记录 API 手动操作与 worker 定时任务执行结果

字段:
- `id`
- `source`
- `action`
- `target_type`
- `target_key`
- `status` (`success|failed|skipped|info`)
- `summary`
- `detail_json`
- `created_at`

---

## 3) NormalizedEvent

```ts
interface NormalizedEvent {
  app_key: string;
  dataset: string;
  event_time: Date;
  ingest_time: Date;
  event_name: string;
  event_type: 'ua' | 'retargeting' | 'unknown';
  attribution: 'organic' | 'non_organic' | 'unknown';
  media_source?: string;
  campaign?: string;
  adset?: string;
  ad?: string;
  country?: string;
  platform?: string;
  af_id?: string;
  device_id?: string;
  revenue?: number;
  currency?: string;
  event_value_json?: string;
  raw_json: string;
  event_uid: string;
}
```

`event_uid`:
- 若 payload 存在唯一字段（`event_uuid/af_event_id/...`），会先拼接上下文后 md5
- 否则使用稳定拼接字段 md5（含 stable stringify）
