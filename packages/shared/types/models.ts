export type EventType = 'ua' | 'retargeting' | 'unknown';
export type AttributionType = 'organic' | 'non_organic' | 'unknown';

export interface NormalizedEvent {
  app_key: string;
  dataset: string;
  event_time: Date;
  install_time: Date;
  ingest_time: Date;
  event_name: string;
  event_type: EventType;
  attribution: AttributionType;
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

export interface AppConfigRecord {
  id: number;
  app_key: string;
  display_name: string;
  ios_display_name: string;
  android_display_name: string;
  pull_app_id: string;
  ios_pull_app_id: string;
  android_pull_app_id: string;
  dataset: string;
  push_auth_token: string;
  timezone: string;
  notify_webhook_url: string | null;
  notify_feishu_app_id: string | null;
  notify_feishu_app_secret: string | null;
  notify_feishu_chat_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface AlertRecord {
  id: number;
  app_key: string;
  platform: string;
  rule_id: number | null;
  severity: 'P0' | 'P1' | 'P2';
  status: 'open' | 'resolved';
  metric: string;
  window: string;
  current_value: number;
  baseline_value: number;
  delta_value: number;
  delta_ratio: number;
  top_contributors: unknown;
  explanation: string;
  fingerprint: string;
  created_at: string;
  updated_at: string;
  resolved_at: string | null;
}

export interface PullAggregateRow {
  date: string;
  app_key: string;
  platform: string;
  media_source: string;
  country: string;
  campaign: string;
  agency_pmd: string;
  impressions: number;
  clicks: number;
  ctr: number;
  installs: number;
  conversion_rate: number;
  sessions: number;
  loyal_users: number;
  loyal_users_installs_ratio: number;
  total_cost: number;
  average_ecpi: number;
  source_report: string;
  pull_window_from: string;
  pull_window_to: string;
  revenue: number;
  events: number;
  raw_json: string;
  ingest_time: string;
}

export interface DailyMetricRow {
  date: string;
  app_key: string;
  metric: string;
  value: number;
  platform: string;
  media_source: string;
  campaign: string;
  country: string;
  source: string;
  version: number;
}

export interface PullRecordRow {
  ingest_time: string;
  date: string;
  app_key: string;
  platform: string;
  media_source: string;
  campaign: string;
  installs: number;
  clicks: number;
  total_cost: number;
  source_report: string;
  raw_json: string;
}

export interface PullRecordsResponseMeta {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
  from: string;
  to: string;
}

export interface KeywordExtractRuleRecord {
  id: number;
  app_key: string;
  priority: number;
  regex_pattern: string;
  keyword_group_index: number;
  match_type_group_index: number | null;
  enabled: boolean;
  created_at: string;
  updated_at: string;
}

export type KeywordLifecycleStage =
  | 'new'
  | 'learning'
  | 'scaling'
  | 'stable'
  | 'declining'
  | 'pause_candidate';

export interface KeywordDailyMetricRow {
  date: string;
  app_key: string;
  platform: string;
  keyword: string;
  match_type: string;
  campaign: string;
  media_source: string;
  country: string;
  installs: number;
  clicks: number;
  total_cost: number;
  cpi: number;
  af_average_ecpi: number;
  cvr: number;
  source_report: string;
  version: number;
}

export interface KeywordLifecycleStateRow {
  id: number;
  app_key: string;
  platform: string;
  keyword: string;
  match_type: string;
  current_stage: KeywordLifecycleStage;
  stage_score: number;
  first_seen_date: string;
  last_seen_date: string;
  days_in_stage: number;
  last_cpi: number;
  last_installs: number;
  last_clicks: number;
  trend_json: unknown;
  created_at: string;
  updated_at: string;
}

export type BudgetAction = 'increase' | 'decrease' | 'hold' | 'pause';
export type BudgetRecommendationStatus = 'pending' | 'applied' | 'rejected' | 'expired';
export type RecommendationType = 'budget' | 'asa_keyword';
export type RecommendationPolicyEngine = 'budget' | 'asa';
export type RecommendationMetricFamily = 'ecpi' | 'd7_roas_cpp' | 'relative_compare';
export type RecommendationDecisionMode = 'deterministic' | 'hybrid';
export type RecommendationTrafficScope = 'all' | 'asa_only' | 'media_sources';
export type RecommendationCompareGranularity = 'campaign';
export type BudgetExecutionActionCode =
  | 'iterate_creative'
  | 'increase_spend_capacity'
  | 'raise_roas_target'
  | 'scale_gradually';
export type BudgetExecutionActionSource = 'scenario' | 'policy';
export type RoasDataStatus = 'complete' | 'partial' | 'partial_low' | 'pending' | 'unavailable';

export interface RecommendationThresholdTargets {
  ecpi_max?: number;
  roas_min?: number;
  roas_good?: number;
  cpp_max?: number;
  cpp_pause_threshold?: number;
}

export interface RecommendationPolicyMaturityWindow {
  exclude_recent_days: number;
  decision_window_days: number;
  context_window_days: number[];
}

export interface RecommendationPolicyTargetConfig {
  global_targets: RecommendationThresholdTargets;
  country_targets: Record<string, RecommendationThresholdTargets>;
  media_targets: Record<string, RecommendationThresholdTargets>;
}

export interface RecommendationPolicySpendConfig {
  daily_budget_cap_usd?: number;
  low_spend_threshold_usd?: number;
  high_spend_threshold_usd?: number;
  trend_lookback_days: number;
  uptrend_min_ratio: number;
}

export interface RecommendationPolicyAdjustmentConfig {
  default_increase_ratio: number;
  default_decrease_ratio: number;
  high_spend_uptrend_increase_ratio: number;
}

export interface RecommendationPolicyScenarioRule {
  enabled: boolean;
  action_tags: string[];
}

export interface RecommendationPolicyActionPlaybook {
  low_spend_signal_weak: RecommendationPolicyScenarioRule;
  high_spend_uptrend_expandable: RecommendationPolicyScenarioRule;
}

export interface RecommendationPolicyRelativeCompare {
  compare_granularity: RecommendationCompareGranularity;
  metrics: Array<'ctr' | 'cvr' | 'cpi' | 'roas'>;
  min_peer_count: number;
  underperform_ratio: number;
  min_failed_metrics: number;
}

export interface RecommendationPolicyRuleJson {
  metric_family: RecommendationMetricFamily;
  decision_mode: RecommendationDecisionMode;
  traffic_scope: RecommendationTrafficScope;
  media_sources: string[];
  maturity_window: RecommendationPolicyMaturityWindow;
  targets: RecommendationPolicyTargetConfig;
  spend_policy: RecommendationPolicySpendConfig;
  adjustment_policy: RecommendationPolicyAdjustmentConfig;
  action_playbook: RecommendationPolicyActionPlaybook;
  relative_compare: RecommendationPolicyRelativeCompare;
}

export interface RecommendationPolicyConfigRecord {
  id: number;
  app_key: string;
  platform: string;
  engine: RecommendationPolicyEngine;
  enabled: boolean;
  rule_json: RecommendationPolicyRuleJson;
  manual_prompt_markdown: string | null;
  created_at: string;
  updated_at: string;
}

export interface LlmExplainResult {
  summary_cn: string;
  risk_level: 'low' | 'medium' | 'high';
  checklist: string[];
  explanation_points: string[];
  action_items: string[];
  scenario_tags: string[];
}

export interface BudgetExecutionAction {
  code: BudgetExecutionActionCode;
  label: string;
  source: BudgetExecutionActionSource;
  priority: number;
}

export interface BudgetRecommendationRow {
  id: number;
  app_key: string;
  platform: string;
  media_source: string;
  keyword: string;
  match_type: string;
  date: string;
  action: BudgetAction;
  change_ratio: number;
  suggested_budget: number;
  current_cost: number;
  current_ecpi: number;
  target_ecpi: number;
  primary_metric: 'ecpi' | 'roas';
  metric_mode: 'active' | 'roas_pending_revenue';
  current_roas: number | null;
  target_roas: number | null;
  roas_window_from: string | null;
  roas_window_to: string | null;
  roas_data_status: RoasDataStatus;
  volume_tier: string;
  expected_installs_delta: number;
  confidence: number;
  reason_code: string;
  llm_summary: unknown;
  execution_actions: BudgetExecutionAction[];
  scenario_tags: string[];
  status: BudgetRecommendationStatus;
  execution_status: string | null;
  is_adopted: boolean;
  validation_result: string | null;
  feedback_synced_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface DailyBriefDispatchRecord {
  id: number;
  report_date: string;
  kind: string;
  channel: string;
  route_key: string;
  title: string;
  content: string;
  payload_json: unknown;
  status: 'sent' | 'failed';
  manual_triggered: boolean;
  last_error: string | null;
  sent_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface OperationLogRecord {
  id: number;
  source: string;
  action: string;
  target_type: string;
  target_key: string;
  status: 'success' | 'failed' | 'skipped' | 'info';
  summary: string;
  detail_json: unknown;
  created_at: string;
}

export interface DailyBriefRouteRecord {
  id: number;
  enabled: boolean;
  route_name: string;
  media_sources: string[];
  app_key: string | null;
  platform: string | null;
  notify_feishu_app_id: string | null;
  notify_feishu_app_secret: string | null;
  notify_feishu_chat_id: string | null;
  priority: number;
  created_at: string;
  updated_at: string;
}

export type ProductStage = 'rising' | 'stable';

export interface ProductStageConfigRecord {
  id: number;
  app_key: string;
  platform: string;
  stage: ProductStage;
  enabled: boolean;
  created_at: string;
  updated_at: string;
}

export interface AsaKeywordDailyMetricRow {
  date: string;
  app_key: string;
  platform: string;
  keyword: string;
  campaign: string;
  adset: string;
  installs: number;
  total_cost: number;
  purchase_count: number;
  revenue_d0: number;
  revenue_d7: number;
  ecpi: number;
  average_ecpi: number;
  cpp: number;
  d7_roas: number;
  roas_source_missing: number;
  version: number;
}

export interface AsaKeywordStateRow {
  id: number;
  app_key: string;
  platform: string;
  keyword: string;
  campaign: string;
  adset: string;
  current_stage: ProductStage;
  stage_score: number;
  first_seen_date: string;
  last_seen_date: string;
  current_ecpi: number;
  current_cpp: number;
  current_d7_roas: number;
  roas_window_from: string | null;
  roas_window_to: string | null;
  roas_data_status: RoasDataStatus;
  target_ecpi: number;
  target_cpp: number;
  target_d7_roas: number;
  installs_7d: number;
  total_cost_7d: number;
  purchase_count_7d: number;
  revenue_d7_7d: number;
  trend_json: unknown;
  created_at: string;
  updated_at: string;
}

export type AsaRecommendationAction = 'increase' | 'decrease' | 'hold' | 'pause';
export type AsaRecommendationPrimaryMetric = 'ecpi' | 'd7_roas_cpp';
export type AsaRecommendationStatus = 'pending' | 'sent' | 'applied' | 'rejected' | 'expired';

export interface AsaKeywordRecommendationRow {
  id: number;
  app_key: string;
  platform: string;
  keyword: string;
  campaign: string;
  adset: string;
  date: string;
  action: AsaRecommendationAction;
  change_ratio: number;
  primary_metric: AsaRecommendationPrimaryMetric;
  current_ecpi: number;
  current_cpp: number;
  current_d7_roas: number;
  roas_window_from: string | null;
  roas_window_to: string | null;
  roas_data_status: RoasDataStatus;
  target_ecpi: number;
  target_cpp: number;
  target_d7_roas: number;
  reason_code: string;
  llm_summary: unknown;
  status: AsaRecommendationStatus;
  created_at: string;
  updated_at: string;
}

export interface AsaKeywordRouteRecord {
  id: number;
  enabled: boolean;
  route_name: string;
  app_key: string | null;
  platform: string | null;
  notify_feishu_app_id: string | null;
  notify_feishu_app_secret: string | null;
  notify_feishu_chat_id: string | null;
  priority: number;
  created_at: string;
  updated_at: string;
}

export type BitableExportSourceType = 'pull_daily' | 'asa_raw' | 'delivery_actions';

export interface BitableExportConfigRecord {
  id: number;
  source_type: BitableExportSourceType;
  enabled: boolean;
  target_table_id: string | null;
  target_table_name: string | null;
  table_name_prefix: string;
  chat_id: string | null;
  selected_fields: string[];
  last_status: 'idle' | 'success' | 'failed' | 'partial_success';
  last_error: string | null;
  last_synced_at: string | null;
  last_record_count: number;
  created_at: string;
  updated_at: string;
}

export interface BitableExportDailyTableRecord {
  id: number;
  source_type: BitableExportSourceType;
  report_date: string;
  table_id: string;
  table_name: string;
  table_name_prefix: string;
  last_record_count: number;
  last_synced_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface BitableExportRecordRefRecord {
  id: number;
  source_type: BitableExportSourceType;
  report_date: string;
  table_id: string;
  snapshot_id: string;
  sync_key: string;
  record_id: string;
  recommendation_type: RecommendationType | null;
  recommendation_id: number | null;
  validation_result: string | null;
  is_adopted: boolean;
  created_at: string;
  updated_at: string;
}

export interface RecommendationExecutionFeedbackRecord {
  id: number;
  source_type: BitableExportSourceType;
  recommendation_type: RecommendationType;
  recommendation_id: number;
  report_date: string;
  table_id: string;
  record_id: string;
  sync_key: string;
  execution_status: string | null;
  is_adopted: boolean;
  validation_result: string | null;
  raw_fields_json: unknown;
  bitable_last_modified_time: string | null;
  synced_at: string;
  created_at: string;
  updated_at: string;
}

export interface FeedbackSkillVersionRecord {
  id: number;
  scope: string;
  source_type: BitableExportSourceType;
  from_date: string | null;
  to_date: string | null;
  dataset_row_count: number;
  stats_json: unknown;
  skills_markdown: string;
  model: string;
  prompt_hash: string;
  created_at: string;
}

export interface RuntimeScheduleConfigRecord {
  singleton_key: string;
  pull_time: string;
  push_time: string;
  created_at: string;
  updated_at: string;
}
