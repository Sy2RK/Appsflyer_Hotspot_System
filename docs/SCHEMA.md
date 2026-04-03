# SCHEMA

## 1) ClickHouse

### `raw_events`
- 明细事件表（Push 入库）
- 引擎: `MergeTree`
- 分区: `toYYYYMM(event_date)`
- 排序: `(app_key, event_date, event_name, media_source, country, campaign, event_time, event_uid)`

关键字段:
- `event_time`, `ingest_time`, `app_key`, `dataset`
- `install_time`（用于 D7 cohort / 价值回收口径，未提供时默认回退 `event_time`）
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

### `keyword_value_daily_metrics`
- 通用预算建议的价值回收事实表（按安装 cohort 聚合）
- 引擎: `ReplacingMergeTree(version)`
- 分区: `toYYYYMM(install_date)`
- 排序: `(app_key, platform, install_date, media_source, country, campaign, keyword, match_type)`

字段:
- `install_date`, `app_key`, `platform`
- `media_source`, `country`, `campaign`
- `keyword`, `match_type`
- `installs`, `total_cost`
- `purchase_count`, `revenue_d7`, `revenue_source_missing`
- `ctr`, `cvr`, `cpi`, `cpp`, `d7_roas`
- `version`

说明：
- 供 `budget-advisor` 的 `d7_roas_cpp` / `relative_compare` evaluator 使用
- `revenue_d7 / purchase_count / d7_roas` 直接来自 AppsFlyer Cohort API 的 D+7 源数据
- `revenue_source_missing=1` 表示该安装 cohort 没有拿到可用的 Cohort 源数据，只代表回收数据缺口，不等于真实 0 收入

### `asa_raw_installs`
- ASA Raw Data 安装明细（仅 `Apple Search Ads`）
- 引擎: `MergeTree`
- 分区: `toYYYYMM(install_date)`
- 排序: `(app_key, platform, install_date, keyword, campaign, event_uid)`

字段:
- `install_date`, `install_time`, `ingest_time`
- `app_key`, `platform`
- `keyword`, `campaign`, `adset`, `country`
- `cost_value`, `currency`
- `event_uid`, `raw_json`

### `asa_raw_in_app_events`
- ASA Raw Data 收入事件明细（仅 `Apple Search Ads`）
- 引擎: `MergeTree`
- 分区: `toYYYYMM(install_date)`
- 排序: `(app_key, platform, install_date, keyword, campaign, event_time, event_uid)`

字段:
- `install_date`, `install_time`, `event_time`, `ingest_time`
- `app_key`, `platform`
- `keyword`, `campaign`, `adset`, `country`
- `event_name`
- `event_revenue_usd`
- `cost_value`, `currency`
- `event_uid`, `raw_json`

### `asa_keyword_daily_metrics_v2`
- ASA 真实 keyword 日级事实表
- 引擎: `ReplacingMergeTree(version)`
- 分区: `toYYYYMM(date)`
- 排序: `(app_key, platform, date, keyword, campaign, adset)`

口径:
- `keyword / campaign / adset / 收入事件`: Raw Data
- `cost / installs / average_ecpi`: Master API
- ASA 专项不再使用 `country` 作为主维度

字段:
- `date`, `app_key`, `platform`
- `keyword`, `campaign`, `adset`
- `installs`, `total_cost`, `purchase_count`
- `revenue_d0`, `revenue_d7`
- `ecpi`, `average_ecpi`, `cpp`, `d7_roas`
- `snapshot_id`
- `version`

### `asa_keyword_country_daily_metrics`
- ASA keyword 国家切片日级事实表
- 引擎: `ReplacingMergeTree(version)`
- 分区: `toYYYYMM(date)`
- 排序: `(app_key, platform, date, country, keyword, campaign, adset)`

字段:
- `date`, `app_key`, `platform`
- `country`, `keyword`, `campaign`, `adset`
- `installs`, `total_cost`, `ecpi`
- `snapshot_id`
- `version`

说明：
- 用于 ASA 应用级规则中的 `country_targets`
- 与 `asa_keyword_daily_metrics_v2` 共享同一批 `snapshot_id`

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
- `primary_metric`
- `metric_mode`
- `current_roas`
- `target_roas`
- `volume_tier` (`low|medium|high`)
- `expected_installs_delta`
- `confidence`
- `reason_code`
- `llm_summary`
- `status` (`pending|applied|rejected|expired`)
- `created_at`, `updated_at`

说明：
- 飞书执行表回读后的 `执行状态 / 是否采纳 / 人工批复` 不直接写回该表，而是通过 `recommendation_execution_feedbacks` 关联展示
- WebUI 查询预算建议时会按 `recommendation_id = budget_recommendations.id` 左联反馈快照

### `recommendation_policy_configs`
- 应用级预算 / ASA 规则配置表

字段:
- `id`
- `app_key` (fk -> apps.app_key)
- `platform`
- `engine` (`budget|asa`)
- `enabled`
- `rule_json` (jsonb)
- `manual_prompt_markdown`
- `created_at`, `updated_at`

说明：
- 唯一键：`(app_key, platform, engine)`
- `rule_json` 保存结构化规则，包含 `metric_family / decision_mode / traffic_scope / maturity_window / targets / spend_policy / relative_compare`
- `manual_prompt_markdown` 用于补充特殊投放经验或例外处理规则
- WebUI 的“应用级规则配置”向导与 `/api/recommendation-policies` 直接读写该表

### `product_stage_configs`
- `app + platform` 的人工产品阶段配置

字段:
- `id`
- `app_key`
- `platform`
- `stage` (`rising|stable`)
- `enabled`
- `created_at`, `updated_at`

### `asa_keyword_states`
- ASA keyword 状态快照

字段:
- `id`
- `app_key`, `platform`
- `keyword`, `campaign`, `adset`
- `current_stage`
- `stage_score`
- `first_seen_date`, `last_seen_date`
- `current_ecpi`, `current_cpp`, `current_d7_roas`
- `target_ecpi`, `target_cpp`, `target_d7_roas`
- `installs_7d`, `total_cost_7d`, `purchase_count_7d`, `revenue_d7_7d`
- `trend_json`
- `created_at`, `updated_at`

### `asa_keyword_recommendations`
- ASA keyword 专项建议

字段:
- `id`
- `app_key`, `platform`
- `keyword`, `campaign`, `adset`
- `date`
- `action` (`increase|decrease|hold|pause`)
- `change_ratio`
- `primary_metric` (`ecpi|d7_roas_cpp`)
- `current_ecpi`, `current_cpp`, `current_d7_roas`
- `target_ecpi`, `target_cpp`, `target_d7_roas`
- `reason_code`
- `llm_summary`
- `status` (`pending|sent|applied|rejected|expired`)
- `created_at`, `updated_at`

### `asa_keyword_routes`
- ASA keyword 专项 Feishu 推送路由

字段:
- `id`
- `route_name`
- `app_key`, `platform`
- `notify_feishu_app_id`
- `notify_feishu_app_secret`
- `notify_feishu_chat_id`
- `priority`
- `enabled`
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

### `bitable_export_configs`
- Feishu 多维表格投放执行表导出配置与最近同步状态

字段:
- `id`
- `source_type` (`pull_daily|asa_raw|delivery_actions`)
- `enabled`
- `target_table_id`
- `target_table_name`
- `table_name_prefix`
- `chat_id`
- `selected_fields` (jsonb)
- `last_status` (`idle|success|failed|partial_success`)
- `last_error`
- `last_synced_at`
- `last_record_count`
- `created_at`
- `updated_at`

说明：
- `delivery_actions` 为当前主导出源，会在同一个 Feishu Base 内按 `report_date` 创建 / 复用日期表
- 该表只保留投放执行所需字段，不再输出原始技术明细
- `target_table_id` / `target_table_name` 表示最近一次同步的日期表
- `table_name_prefix` 用于生成每日日期表名，例如 `投放执行表_2026-03-27`
- 该表只保存导出配置与最近同步结果，不保存实际导出数据

### `bitable_export_daily_tables`
- Feishu 多维表格按日期留档的表级元数据

字段:
- `id`
- `source_type`
- `report_date`
- `table_id`
- `table_name`
- `table_name_prefix`
- `last_record_count`
- `last_synced_at`
- `created_at`
- `updated_at`

说明：
- 每个 `report_date` 对应同一个 Base 左侧导航中的一张表
- 同一天重复导出时会复用该日期对应的表
- 历史日期表永久保留，并继续参与执行反馈回读

### `bitable_export_record_refs`
- 飞书投放执行表 `record_id` 与本地建议记录的映射表

字段:
- `id`
- `source_type`
- `report_date`
- `table_id`
- `snapshot_id`
- `sync_key`
- `record_id`
- `recommendation_type` (`budget|asa_keyword`)
- `recommendation_id`
- `validation_result`
- `is_adopted`
- `created_at`
- `updated_at`

说明：
- 该表负责把飞书行级记录定位回本地预算建议 / ASA 建议
- 导出时会刷新当前快照映射，回读时通过 `record_id` 找到本地建议主键

### `recommendation_execution_feedbacks`
- 飞书执行反馈的本地持久快照表

字段:
- `id`
- `source_type`
- `recommendation_type` (`budget|asa_keyword`)
- `recommendation_id`
- `report_date`
- `table_id`
- `record_id`
- `sync_key`
- `execution_status`
- `is_adopted`
- `validation_result`
- `raw_fields_json`
- `bitable_last_modified_time`
- `synced_at`
- `created_at`
- `updated_at`

说明：
- 唯一键：`(source_type, recommendation_type, recommendation_id)`
- 本地持久保存飞书里的 `执行状态 / 是否采纳 / 人工批复`，即使执行表后续被下一次快照覆盖，也能保留历史反馈
- `bitable_last_modified_time` 仅用于记录飞书侧最近修改时间，不单独作为“人工反馈已变化”的判定依据

### `feedback_skill_versions`
- 基于预算建议反馈数据生成的版本化 `skills.md`

字段:
- `id`
- `scope`
- `source_type`
- `from_date`
- `to_date`
- `dataset_row_count`
- `stats_json`
- `skills_markdown`
- `model`
- `prompt_hash`
- `created_at`

说明：
- 当前 `scope` 已支持 `budget` 与 `asa`
- 每次反馈回读检测到变化后，会新增一版 `skills.md`，供后续 LLM 分析追加到 prompt
- 系统自动补写 `七天后数据` 不会触发这里的新版本生成

### `runtime_schedule_configs`
- 全局运行时调度配置（单行表）

字段:
- `singleton_key`
- `pull_time`
- `push_time`
- `created_at`
- `updated_at`

说明：
- 默认只有一行：`singleton_key = 'global'`
- `pull_time` 控制：
  - `puller`
  - `keyword-engine`
  - `budget-advisor`
  - `asa-keywords`
- `push_time` 控制：
  - `daily-brief`
  - `asa-daily-brief`
- `bitable-export` 不单独存库，固定按 `push_time + 5 分钟` 计算
- `daily-brief` / `asa-daily-brief` / `bitable-export` 在定时执行前，还会额外检查同一 `report_date` 的 `budget-advisor` 与 `asa-keywords` 是否已完成

### `scheduled_worker_runs`
- 每日 worker 的持久化运行状态表

字段:
- `worker_name`
- `run_marker`
- `status` (`running|failed|completed`)
- `attempt_count`
- `last_attempt_at`
- `next_allowed_at`
- `completed_at`
- `last_error`
- `created_at`
- `updated_at`

说明：
- 主键：`(worker_name, run_marker)`
- 用于 `puller / keyword-engine / budget-advisor / asa-keywords / daily-brief / asa-daily-brief / bitable-export`
- 负责跨实例判断“同一天是否已完成 / 是否还允许重试”，不再只依赖单进程内存
- `next_allowed_at` 用于每日失败后的冷却重试控制
- `attempt_count` 主要消耗在“仍值得自动重试”的瞬时失败；认证、404、错误参数这类确定性失败会尽量在业务层提前归类，避免盲目耗尽每日预算

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

说明：
- `worker.budget_advisor` 的 `scheduled_budget_cycle` 会把 `target_key` 记录为对应 `report_date`
- `worker.asa_keywords` 的 `scheduled_asa_keyword_cycle` 也会把 `target_key` 记录为对应 `report_date`
- 下游自动链路会用这两类操作日志，结合 job lock，判断某个 `report_date` 的长任务是否已经真正完成
- `operation_logs` 继续承担审计与门控查询；“每日只跑一次”的最终去重状态由 `scheduled_worker_runs` 承担
- Pull / ASA 网络抖动相关日志会在 `detail_json` 中补充失败分类与恢复信息，例如 `failure_kind`、`retryable_failed_count`、`recovered_slice_count`

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
