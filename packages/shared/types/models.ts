export type EventType = 'ua' | 'retargeting' | 'unknown';
export type AttributionType = 'organic' | 'non_organic' | 'unknown';

export interface NormalizedEvent {
  app_key: string;
  dataset: string;
  event_time: Date;
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

export interface LlmExplainResult {
  summary_cn: string;
  risk_level: 'low' | 'medium' | 'high';
  checklist: string[];
  explanation_points: string[];
}

export interface BudgetRecommendationRow {
  id: number;
  app_key: string;
  platform: string;
  keyword: string;
  match_type: string;
  date: string;
  action: BudgetAction;
  change_ratio: number;
  suggested_budget: number;
  current_cost: number;
  current_ecpi: number;
  target_ecpi: number;
  volume_tier: string;
  expected_installs_delta: number;
  confidence: number;
  reason_code: string;
  llm_summary: unknown;
  status: BudgetRecommendationStatus;
  created_at: string;
  updated_at: string;
}

export interface DailyBriefDispatchRecord {
  id: number;
  report_date: string;
  kind: string;
  channel: string;
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
