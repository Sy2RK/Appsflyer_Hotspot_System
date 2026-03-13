import { pgQuery } from './postgres.js';
import {
  AlertRecord,
  AppConfigRecord,
  BudgetRecommendationRow,
  BudgetRecommendationStatus,
  DailyBriefDispatchRecord,
  KeywordExtractRuleRecord,
  KeywordLifecycleStateRow,
  OperationLogRecord
} from '../types/models.js';

export interface RuleRecord {
  id: number;
  app_key: string;
  name: string;
  enabled: boolean;
  rule_json: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface AppRuleRecord extends RuleRecord {
  timezone: string;
  notify_webhook_url: string | null;
  notify_feishu_app_id: string | null;
  notify_feishu_app_secret: string | null;
  notify_feishu_chat_id: string | null;
}

export interface AlertsFilter {
  appKey?: string;
  status?: 'open' | 'resolved';
  severity?: 'P0' | 'P1' | 'P2';
  from?: string;
  to?: string;
  limit?: number;
}

export interface UpsertAppInput {
  app_key: string;
  display_name?: string;
  ios_display_name?: string;
  android_display_name?: string;
  pull_app_id: string;
  ios_pull_app_id?: string;
  android_pull_app_id?: string;
  dataset: string;
  push_auth_token?: string;
  timezone: string;
  notify_webhook_url?: string | null;
  notify_feishu_app_id?: string | null;
  notify_feishu_app_secret?: string | null;
  notify_feishu_chat_id?: string | null;
  replace_notify_feishu_app_secret?: boolean;
}

export interface PullCycleLockRecord {
  name: string;
  owner_id: string;
  expires_at: string;
  created_at: string;
  updated_at: string;
}

export interface PullContentGuardRecord {
  app_key: string;
  platform: string;
  report_date: string;
  source_report: string;
  content_signature: string;
  last_status: string;
  last_error: string | null;
  attempted_at: string;
  next_allowed_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface UpsertPullContentGuardInput {
  app_key: string;
  platform: string;
  report_date: string;
  source_report: string;
  content_signature?: string;
  last_status: string;
  last_error?: string | null;
  attempted_at?: string;
  next_allowed_at?: string | null;
}

export async function claimIngestDedupKeys(
  rows: Array<{ event_uid: string; app_key: string }>
): Promise<Set<string>> {
  if (rows.length === 0) {
    return new Set();
  }

  const eventUids = rows.map((row) => row.event_uid);
  const appKeys = rows.map((row) => row.app_key);
  const result = await pgQuery<{ event_uid: string }>(
    `INSERT INTO ingest_dedup_keys (event_uid, app_key)
     SELECT * FROM unnest($1::text[], $2::text[])
     ON CONFLICT (event_uid) DO NOTHING
     RETURNING event_uid`,
    [eventUids, appKeys]
  );

  return new Set(result.rows.map((row) => row.event_uid));
}

export async function releaseIngestDedupKeys(eventUids: string[]): Promise<void> {
  if (eventUids.length === 0) {
    return;
  }

  await pgQuery(`DELETE FROM ingest_dedup_keys WHERE event_uid = ANY($1::text[])`, [eventUids]);
}

export async function tryAcquirePullCycleLock(name: string, ownerId: string, ttlMs: number): Promise<boolean> {
  const result = await pgQuery<{ name: string }>(
    `INSERT INTO pull_cycle_locks (name, owner_id, expires_at)
     VALUES ($1, $2, NOW() + ($3 * INTERVAL '1 millisecond'))
     ON CONFLICT (name) DO UPDATE
        SET owner_id = EXCLUDED.owner_id,
            expires_at = EXCLUDED.expires_at,
            updated_at = NOW()
      WHERE pull_cycle_locks.expires_at <= NOW()
     RETURNING name`,
    [name, ownerId, Math.max(1000, Math.floor(ttlMs))]
  );

  return (result.rowCount ?? 0) > 0;
}

export async function releasePullCycleLock(name: string, ownerId: string): Promise<void> {
  await pgQuery(`DELETE FROM pull_cycle_locks WHERE name = $1 AND owner_id = $2`, [name, ownerId]);
}

export async function getPullContentGuard(
  appKey: string,
  platform: string,
  reportDate: string,
  sourceReport: string
): Promise<PullContentGuardRecord | null> {
  const result = await pgQuery<PullContentGuardRecord>(
    `SELECT app_key, platform, report_date, source_report, content_signature, last_status, last_error,
            attempted_at, next_allowed_at, created_at, updated_at
       FROM pull_content_guards
      WHERE app_key = $1
        AND platform = $2
        AND report_date = $3::date
        AND source_report = $4
      LIMIT 1`,
    [appKey, platform, reportDate, sourceReport]
  );

  return result.rows[0] ?? null;
}

export async function upsertPullContentGuard(input: UpsertPullContentGuardInput): Promise<PullContentGuardRecord> {
  const result = await pgQuery<PullContentGuardRecord>(
    `INSERT INTO pull_content_guards (
      app_key, platform, report_date, source_report, content_signature, last_status, last_error, attempted_at, next_allowed_at
    ) VALUES (
      $1, $2, $3::date, $4, COALESCE($5, ''), $6, NULLIF($7, ''), COALESCE($8::timestamptz, NOW()), $9::timestamptz
    )
    ON CONFLICT (app_key, platform, report_date, source_report) DO UPDATE SET
      content_signature = COALESCE($5, pull_content_guards.content_signature),
      last_status = EXCLUDED.last_status,
      last_error = EXCLUDED.last_error,
      attempted_at = EXCLUDED.attempted_at,
      next_allowed_at = EXCLUDED.next_allowed_at,
      updated_at = NOW()
    RETURNING app_key, platform, report_date, source_report, content_signature, last_status, last_error,
              attempted_at, next_allowed_at, created_at, updated_at`,
    [
      input.app_key,
      input.platform,
      input.report_date,
      input.source_report,
      input.content_signature ?? '',
      input.last_status,
      input.last_error ?? '',
      input.attempted_at ?? null,
      input.next_allowed_at ?? null
    ]
  );

  return result.rows[0];
}

export async function listApps(): Promise<AppConfigRecord[]> {
  const result = await pgQuery<AppConfigRecord>(
    `SELECT id, app_key, display_name, ios_display_name, android_display_name, pull_app_id, ios_pull_app_id, android_pull_app_id, dataset, push_auth_token, timezone, notify_webhook_url,
            notify_feishu_app_id, notify_feishu_app_secret, notify_feishu_chat_id, created_at, updated_at
       FROM apps
      ORDER BY app_key ASC`
  );
  return result.rows;
}

export async function getAppByKey(appKey: string): Promise<AppConfigRecord | null> {
  const result = await pgQuery<AppConfigRecord>(
    `SELECT id, app_key, display_name, ios_display_name, android_display_name, pull_app_id, ios_pull_app_id, android_pull_app_id, dataset, push_auth_token, timezone, notify_webhook_url,
            notify_feishu_app_id, notify_feishu_app_secret, notify_feishu_chat_id, created_at, updated_at
       FROM apps
      WHERE app_key = $1
      LIMIT 1`,
    [appKey]
  );
  return result.rows[0] ?? null;
}

export async function getAppByKeyAndDataset(appKey: string, dataset: string): Promise<AppConfigRecord | null> {
  const result = await pgQuery<AppConfigRecord>(
    `SELECT id, app_key, display_name, ios_display_name, android_display_name, pull_app_id, ios_pull_app_id, android_pull_app_id, dataset, push_auth_token, timezone, notify_webhook_url,
            notify_feishu_app_id, notify_feishu_app_secret, notify_feishu_chat_id, created_at, updated_at
       FROM apps
      WHERE app_key = $1 AND dataset = $2
      LIMIT 1`,
    [appKey, dataset]
  );
  return result.rows[0] ?? null;
}

export async function upsertAppConfig(input: UpsertAppInput): Promise<AppConfigRecord> {
  const result = await pgQuery<AppConfigRecord>(
    `INSERT INTO apps (
      app_key, display_name, ios_display_name, android_display_name, pull_app_id, ios_pull_app_id, android_pull_app_id, dataset, push_auth_token, timezone, notify_webhook_url,
      notify_feishu_app_id, notify_feishu_app_secret, notify_feishu_chat_id
    ) VALUES (
      $1,
      COALESCE(NULLIF($2, ''), replace($1, '-', ' ')),
      COALESCE(NULLIF($3, ''), ''),
      COALESCE(NULLIF($4, ''), ''),
      $5, COALESCE(NULLIF($6, ''), ''), COALESCE(NULLIF($7, ''), ''),
      $8, COALESCE(NULLIF($9, ''), md5(random()::text || clock_timestamp()::text)),
      $10, NULLIF($11, ''), NULLIF($12, ''), NULLIF($13, ''), NULLIF($14, '')
    )
    ON CONFLICT (app_key) DO UPDATE SET
      display_name = COALESCE(NULLIF($2, ''), replace(apps.app_key, '-', ' ')),
      ios_display_name = COALESCE(NULLIF($3, ''), apps.ios_display_name),
      android_display_name = COALESCE(NULLIF($4, ''), apps.android_display_name),
      pull_app_id = EXCLUDED.pull_app_id,
      ios_pull_app_id = COALESCE(NULLIF($6, ''), apps.ios_pull_app_id),
      android_pull_app_id = COALESCE(NULLIF($7, ''), apps.android_pull_app_id),
      dataset = EXCLUDED.dataset,
      push_auth_token = CASE
        WHEN NULLIF($9, '') IS NULL THEN apps.push_auth_token
        ELSE NULLIF($9, '')
      END,
      timezone = EXCLUDED.timezone,
      notify_webhook_url = NULLIF($11, ''),
      notify_feishu_app_id = NULLIF($12, ''),
      notify_feishu_app_secret = CASE
        WHEN $15::boolean IS TRUE THEN NULLIF($13, '')
        ELSE apps.notify_feishu_app_secret
      END,
      notify_feishu_chat_id = NULLIF($14, ''),
      updated_at = NOW()
    RETURNING id, app_key, display_name, ios_display_name, android_display_name, pull_app_id, ios_pull_app_id, android_pull_app_id, dataset, push_auth_token, timezone, notify_webhook_url,
              notify_feishu_app_id, notify_feishu_app_secret, notify_feishu_chat_id, created_at, updated_at`,
    [
      input.app_key,
      input.display_name ?? '',
      input.ios_display_name ?? '',
      input.android_display_name ?? '',
      input.pull_app_id,
      input.ios_pull_app_id ?? '',
      input.android_pull_app_id ?? '',
      input.dataset,
      input.push_auth_token ?? '',
      input.timezone,
      input.notify_webhook_url ?? '',
      input.notify_feishu_app_id ?? '',
      input.notify_feishu_app_secret ?? '',
      input.notify_feishu_chat_id ?? '',
      input.replace_notify_feishu_app_secret === true
    ]
  );

  return result.rows[0];
}

export async function listRules(appKey?: string): Promise<RuleRecord[]> {
  const values: unknown[] = [];
  let where = '';
  if (appKey) {
    values.push(appKey);
    where = 'WHERE app_key = $1';
  }

  const result = await pgQuery<RuleRecord>(
    `SELECT id, app_key, name, enabled, rule_json, created_at, updated_at
       FROM rules
       ${where}
      ORDER BY updated_at DESC`,
    values
  );
  return result.rows;
}

export async function listEnabledRulesWithApp(): Promise<AppRuleRecord[]> {
  const result = await pgQuery<AppRuleRecord>(
    `SELECT r.id, r.app_key, r.name, r.enabled, r.rule_json, r.created_at, r.updated_at,
            a.timezone, a.notify_webhook_url, a.notify_feishu_app_id, a.notify_feishu_app_secret, a.notify_feishu_chat_id
       FROM rules r
       JOIN apps a ON a.app_key = r.app_key
      WHERE r.enabled = true`
  );

  return result.rows;
}

export interface UpsertRuleInput {
  id?: number;
  app_key: string;
  name: string;
  enabled?: boolean;
  rule_json: Record<string, unknown>;
}

export async function upsertRule(input: UpsertRuleInput): Promise<RuleRecord> {
  if (input.id) {
    const result = await pgQuery<RuleRecord>(
      `UPDATE rules
          SET app_key = $1,
              name = $2,
              enabled = COALESCE($3, enabled),
              rule_json = $4,
              updated_at = NOW()
        WHERE id = $5
      RETURNING id, app_key, name, enabled, rule_json, created_at, updated_at`,
      [input.app_key, input.name, input.enabled ?? null, input.rule_json, input.id]
    );
    if (!result.rows[0]) {
      throw new Error(`Rule id ${input.id} not found`);
    }
    return result.rows[0];
  }

  const result = await pgQuery<RuleRecord>(
    `INSERT INTO rules (app_key, name, enabled, rule_json)
     VALUES ($1, $2, COALESCE($3, true), $4)
     RETURNING id, app_key, name, enabled, rule_json, created_at, updated_at`,
    [input.app_key, input.name, input.enabled ?? true, input.rule_json]
  );

  return result.rows[0];
}

export async function setRuleEnabled(id: number, enabled: boolean): Promise<RuleRecord | null> {
  const result = await pgQuery<RuleRecord>(
    `UPDATE rules
        SET enabled = $1,
            updated_at = NOW()
      WHERE id = $2
    RETURNING id, app_key, name, enabled, rule_json, created_at, updated_at`,
    [enabled, id]
  );

  return result.rows[0] ?? null;
}

export async function listAlerts(filters: AlertsFilter): Promise<AlertRecord[]> {
  const clauses: string[] = [];
  const values: unknown[] = [];

  if (filters.appKey) {
    values.push(filters.appKey);
    clauses.push(`app_key = $${values.length}`);
  }
  if (filters.status) {
    values.push(filters.status);
    clauses.push(`status = $${values.length}`);
  }
  if (filters.severity) {
    values.push(filters.severity);
    clauses.push(`severity = $${values.length}`);
  }
  if (filters.from) {
    values.push(filters.from);
    clauses.push(`created_at >= $${values.length}`);
  }
  if (filters.to) {
    values.push(filters.to);
    clauses.push(`created_at <= $${values.length}`);
  }

  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  values.push(filters.limit ?? 200);

  const result = await pgQuery<AlertRecord>(
    `SELECT id, app_key, rule_id, severity, status, metric, "window", current_value, baseline_value,
            delta_value, delta_ratio, top_contributors, explanation, fingerprint, created_at,
            updated_at, resolved_at
       FROM alerts
       ${where}
      ORDER BY created_at DESC
      LIMIT $${values.length}`,
    values
  );

  return result.rows;
}

export async function getAlertById(id: number): Promise<AlertRecord | null> {
  const result = await pgQuery<AlertRecord>(
    `SELECT id, app_key, rule_id, severity, status, metric, "window", current_value, baseline_value,
            delta_value, delta_ratio, top_contributors, explanation, fingerprint, created_at,
            updated_at, resolved_at
       FROM alerts
      WHERE id = $1`,
    [id]
  );

  return result.rows[0] ?? null;
}

export interface CreateAlertInput {
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
}

export async function createAlert(input: CreateAlertInput): Promise<AlertRecord> {
  const result = await pgQuery<AlertRecord>(
    `INSERT INTO alerts (
      app_key, rule_id, severity, status, metric, "window", current_value, baseline_value,
      delta_value, delta_ratio, top_contributors, explanation, fingerprint
    ) VALUES (
      $1, $2, $3, $4, $5, $6, $7, $8,
      $9, $10, $11, $12, $13
    )
    ON CONFLICT (fingerprint) WHERE status = 'open' DO UPDATE SET
      updated_at = NOW(),
      current_value = EXCLUDED.current_value,
      baseline_value = EXCLUDED.baseline_value,
      delta_value = EXCLUDED.delta_value,
      delta_ratio = EXCLUDED.delta_ratio,
      top_contributors = EXCLUDED.top_contributors,
      explanation = EXCLUDED.explanation
    RETURNING id, app_key, rule_id, severity, status, metric, "window", current_value, baseline_value,
              delta_value, delta_ratio, top_contributors, explanation, fingerprint, created_at,
              updated_at, resolved_at`,
    [
      input.app_key,
      input.rule_id,
      input.severity,
      input.status,
      input.metric,
      input.window,
      input.current_value,
      input.baseline_value,
      input.delta_value,
      input.delta_ratio,
      JSON.stringify(input.top_contributors),
      input.explanation,
      input.fingerprint
    ]
  );
  return result.rows[0];
}

export async function findRecentOpenAlertByFingerprint(
  fingerprint: string,
  silenceMinutes: number
): Promise<AlertRecord | null> {
  const result = await pgQuery<AlertRecord>(
    `SELECT id, app_key, rule_id, severity, status, metric, "window", current_value, baseline_value,
            delta_value, delta_ratio, top_contributors, explanation, fingerprint, created_at,
            updated_at, resolved_at
       FROM alerts
      WHERE fingerprint = $1
        AND status = 'open'
        AND created_at >= NOW() - ($2::text || ' minutes')::interval
      ORDER BY created_at DESC
      LIMIT 1`,
    [fingerprint, silenceMinutes]
  );

  return result.rows[0] ?? null;
}

export async function resolveOpenAlertsByRuleMetric(
  appKey: string,
  ruleId: number,
  metric: string,
  window: string
): Promise<number> {
  const result = await pgQuery<{ id: number }>(
    `UPDATE alerts
        SET status = 'resolved',
            updated_at = NOW(),
            resolved_at = NOW()
      WHERE app_key = $1
        AND rule_id = $2
        AND metric = $3
        AND "window" = $4
        AND status = 'open'
      RETURNING id`,
    [appKey, ruleId, metric, window]
  );

  return result.rowCount ?? 0;
}

export async function listOpenAlertsByRuleMetric(
  appKey: string,
  ruleId: number,
  metric: string,
  window: string
): Promise<AlertRecord[]> {
  const result = await pgQuery<AlertRecord>(
    `SELECT id, app_key, rule_id, severity, status, metric, "window", current_value, baseline_value,
            delta_value, delta_ratio, top_contributors, explanation, fingerprint, created_at,
            updated_at, resolved_at
       FROM alerts
      WHERE app_key = $1
        AND rule_id = $2
        AND metric = $3
        AND "window" = $4
        AND status = 'open'`,
    [appKey, ruleId, metric, window]
  );

  return result.rows;
}

export async function listKeywordExtractRules(appKey?: string): Promise<KeywordExtractRuleRecord[]> {
  const values: unknown[] = [];
  const where = appKey ? 'WHERE app_key = $1' : '';
  if (appKey) {
    values.push(appKey);
  }
  const result = await pgQuery<KeywordExtractRuleRecord>(
    `SELECT id, app_key, priority, regex_pattern, keyword_group_index, match_type_group_index,
            enabled, created_at, updated_at
       FROM keyword_extract_rules
       ${where}
      ORDER BY app_key ASC, priority ASC, id ASC`,
    values
  );
  return result.rows;
}

export async function listKeywordLifecycleStatesByApp(appKey: string): Promise<KeywordLifecycleStateRow[]> {
  return listKeywordLifecycleStatesByAppPlatform(appKey);
}

export async function listKeywordLifecycleStatesByAppPlatform(
  appKey: string,
  platform?: string
): Promise<KeywordLifecycleStateRow[]> {
  const values: unknown[] = [appKey];
  const platformFilter = platform ? `AND platform = $2` : '';
  if (platform) {
    values.push(platform);
  }
  const result = await pgQuery<KeywordLifecycleStateRow>(
    `SELECT id, app_key, platform, keyword, match_type, current_stage, stage_score, first_seen_date, last_seen_date,
            days_in_stage, last_cpi, last_installs, last_clicks, trend_json, created_at, updated_at
       FROM keyword_lifecycle_states
      WHERE app_key = $1
        ${platformFilter}
      ORDER BY updated_at DESC`,
    values
  );
  return result.rows;
}

export interface KeywordLifecycleFilter {
  appKey?: string;
  platform?: string;
  stage?: string;
  keyword?: string;
  from?: string;
  to?: string;
  page?: number;
  pageSize?: number;
}

export interface PagedResult<T> {
  rows: T[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

export async function queryKeywordLifecycleStates(
  filter: KeywordLifecycleFilter
): Promise<PagedResult<KeywordLifecycleStateRow>> {
  const pageSize = Math.min(100, Math.max(1, filter.pageSize ?? 20));
  const page = Math.max(1, filter.page ?? 1);
  const values: unknown[] = [];
  const clauses: string[] = [];

  if (filter.appKey) {
    values.push(filter.appKey);
    clauses.push(`app_key = $${values.length}`);
  }
  if (filter.platform) {
    values.push(filter.platform);
    clauses.push(`platform = $${values.length}`);
  }
  if (filter.stage) {
    values.push(filter.stage);
    clauses.push(`current_stage = $${values.length}`);
  }
  if (filter.keyword) {
    values.push(`%${filter.keyword}%`);
    clauses.push(`keyword ILIKE $${values.length}`);
  }
  if (filter.from) {
    values.push(filter.from);
    clauses.push(`last_seen_date >= $${values.length}::date`);
  }
  if (filter.to) {
    values.push(filter.to);
    clauses.push(`last_seen_date <= $${values.length}::date`);
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';

  const countResult = await pgQuery<{ total: string }>(
    `SELECT to_char(count(*), 'FM999999999999999') AS total
       FROM keyword_lifecycle_states
      ${where}`,
    values
  );
  const total = Number(countResult.rows[0]?.total ?? 0);
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const safePage = Math.min(page, totalPages);
  const offset = (safePage - 1) * pageSize;

  const listValues = [...values, pageSize, offset];
  const rowsResult = await pgQuery<KeywordLifecycleStateRow>(
    `SELECT id, app_key, platform, keyword, match_type, current_stage, stage_score, first_seen_date, last_seen_date,
            days_in_stage, last_cpi, last_installs, last_clicks, trend_json, created_at, updated_at
       FROM keyword_lifecycle_states
       ${where}
      ORDER BY updated_at DESC, id DESC
      LIMIT $${listValues.length - 1}
      OFFSET $${listValues.length}`,
    listValues
  );

  return {
    rows: rowsResult.rows,
    total,
    page: safePage,
    pageSize,
    totalPages
  };
}

export interface UpsertKeywordLifecycleInput {
  app_key: string;
  platform: string;
  keyword: string;
  match_type: string;
  current_stage: string;
  stage_score: number;
  first_seen_date: string;
  last_seen_date: string;
  days_in_stage: number;
  last_cpi: number;
  last_installs: number;
  last_clicks: number;
  trend_json: unknown;
}

export async function upsertKeywordLifecycleState(
  input: UpsertKeywordLifecycleInput
): Promise<KeywordLifecycleStateRow> {
  const stageScore = Number(input.stage_score);
  const daysInStage = Number(input.days_in_stage);
  const lastCpi = Number(input.last_cpi);
  const lastInstalls = Number(input.last_installs);
  const lastClicks = Number(input.last_clicks);

  const result = await pgQuery<KeywordLifecycleStateRow>(
    `INSERT INTO keyword_lifecycle_states (
      app_key, platform, keyword, match_type, current_stage, stage_score, first_seen_date, last_seen_date,
      days_in_stage, last_cpi, last_installs, last_clicks, trend_json
    ) VALUES (
      $1, $2, $3, $4, $5, $6, $7::date, $8::date,
      $9, $10, $11, $12, $13
    )
    ON CONFLICT (app_key, platform, keyword, match_type) DO UPDATE SET
      current_stage = EXCLUDED.current_stage,
      stage_score = EXCLUDED.stage_score,
      first_seen_date = LEAST(keyword_lifecycle_states.first_seen_date, EXCLUDED.first_seen_date),
      last_seen_date = EXCLUDED.last_seen_date,
      days_in_stage = EXCLUDED.days_in_stage,
      last_cpi = EXCLUDED.last_cpi,
      last_installs = EXCLUDED.last_installs,
      last_clicks = EXCLUDED.last_clicks,
      trend_json = EXCLUDED.trend_json,
      updated_at = NOW()
    RETURNING id, app_key, platform, keyword, match_type, current_stage, stage_score, first_seen_date, last_seen_date,
              days_in_stage, last_cpi, last_installs, last_clicks, trend_json, created_at, updated_at`,
    [
      input.app_key,
      input.platform,
      input.keyword,
      input.match_type,
      input.current_stage,
      Number.isFinite(stageScore) ? stageScore : 0,
      input.first_seen_date,
      input.last_seen_date,
      Number.isFinite(daysInStage) ? Math.max(1, Math.floor(daysInStage)) : 1,
      Number.isFinite(lastCpi) ? lastCpi : 0,
      Number.isFinite(lastInstalls) ? lastInstalls : 0,
      Number.isFinite(lastClicks) ? lastClicks : 0,
      JSON.stringify(input.trend_json ?? {})
    ]
  );
  return result.rows[0];
}

export interface BudgetRecommendationFilter {
  appKey?: string;
  platform?: string;
  status?: BudgetRecommendationStatus;
  from?: string;
  to?: string;
  page?: number;
  pageSize?: number;
}

export interface UpsertBudgetRecommendationInput {
  app_key: string;
  platform: string;
  keyword: string;
  match_type: string;
  date: string;
  action: 'increase' | 'decrease' | 'hold' | 'pause';
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
  status?: BudgetRecommendationStatus;
}

export async function upsertBudgetRecommendation(
  input: UpsertBudgetRecommendationInput
): Promise<BudgetRecommendationRow> {
  const result = await pgQuery<BudgetRecommendationRow>(
    `INSERT INTO budget_recommendations (
      app_key, platform, keyword, match_type, date, action, change_ratio, suggested_budget, current_cost,
      current_ecpi, target_ecpi, volume_tier, expected_installs_delta, confidence, reason_code, llm_summary, status
    ) VALUES (
      $1, $2, $3, $4, $5::date, $6, $7, $8, $9,
      $10, $11, $12, $13, $14, $15, $16, COALESCE($17, 'pending')
    )
    ON CONFLICT (app_key, platform, keyword, match_type, date) DO UPDATE SET
      action = EXCLUDED.action,
      change_ratio = EXCLUDED.change_ratio,
      suggested_budget = EXCLUDED.suggested_budget,
      current_cost = EXCLUDED.current_cost,
      current_ecpi = EXCLUDED.current_ecpi,
      target_ecpi = EXCLUDED.target_ecpi,
      volume_tier = EXCLUDED.volume_tier,
      expected_installs_delta = EXCLUDED.expected_installs_delta,
      confidence = EXCLUDED.confidence,
      reason_code = EXCLUDED.reason_code,
      llm_summary = EXCLUDED.llm_summary,
      status = CASE
        WHEN budget_recommendations.status IN ('applied', 'rejected') THEN budget_recommendations.status
        ELSE EXCLUDED.status
      END,
      updated_at = NOW()
    RETURNING id, app_key, platform, keyword, match_type, date, action, change_ratio, suggested_budget, current_cost,
              current_ecpi, target_ecpi, volume_tier, expected_installs_delta, confidence, reason_code, llm_summary, status, created_at, updated_at`,
    [
      input.app_key,
      input.platform,
      input.keyword,
      input.match_type,
      input.date,
      input.action,
      input.change_ratio,
      input.suggested_budget,
      input.current_cost,
      input.current_ecpi,
      input.target_ecpi,
      input.volume_tier,
      input.expected_installs_delta,
      input.confidence,
      input.reason_code,
      JSON.stringify(input.llm_summary ?? {}),
      input.status ?? 'pending'
    ]
  );
  return result.rows[0];
}

export async function queryBudgetRecommendations(
  filter: BudgetRecommendationFilter
): Promise<PagedResult<BudgetRecommendationRow>> {
  const pageSize = Math.min(100, Math.max(1, filter.pageSize ?? 20));
  const page = Math.max(1, filter.page ?? 1);
  const values: unknown[] = [];
  const clauses: string[] = [];

  if (filter.appKey) {
    values.push(filter.appKey);
    clauses.push(`app_key = $${values.length}`);
  }
  if (filter.platform) {
    values.push(filter.platform);
    clauses.push(`platform = $${values.length}`);
  }
  if (filter.status) {
    values.push(filter.status);
    clauses.push(`status = $${values.length}`);
  }
  if (filter.from) {
    values.push(filter.from);
    clauses.push(`date >= $${values.length}::date`);
  }
  if (filter.to) {
    values.push(filter.to);
    clauses.push(`date <= $${values.length}::date`);
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';

  const countResult = await pgQuery<{ total: string }>(
    `SELECT to_char(count(*), 'FM999999999999999') AS total
       FROM budget_recommendations
      ${where}`,
    values
  );
  const total = Number(countResult.rows[0]?.total ?? 0);
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const safePage = Math.min(page, totalPages);
  const offset = (safePage - 1) * pageSize;
  const listValues = [...values, pageSize, offset];

  const rowsResult = await pgQuery<BudgetRecommendationRow>(
    `SELECT id, app_key, platform, keyword, match_type, date, action, change_ratio, suggested_budget, current_cost,
            current_ecpi, target_ecpi, volume_tier, expected_installs_delta, confidence, reason_code, llm_summary, status, created_at, updated_at
       FROM budget_recommendations
       ${where}
      ORDER BY date DESC, updated_at DESC, id DESC
      LIMIT $${listValues.length - 1}
      OFFSET $${listValues.length}`,
    listValues
  );

  return {
    rows: rowsResult.rows,
    total,
    page: safePage,
    pageSize,
    totalPages
  };
}

export async function setBudgetRecommendationStatus(
  id: number,
  status: BudgetRecommendationStatus
): Promise<BudgetRecommendationRow | null> {
  const result = await pgQuery<BudgetRecommendationRow>(
    `UPDATE budget_recommendations
        SET status = $1,
            updated_at = NOW()
      WHERE id = $2
      RETURNING id, app_key, platform, keyword, match_type, date, action, change_ratio, suggested_budget, current_cost,
                current_ecpi, target_ecpi, volume_tier, expected_installs_delta, confidence, reason_code, llm_summary, status, created_at, updated_at`,
    [status, id]
  );
  return result.rows[0] ?? null;
}

export async function expirePendingBudgetRecommendationsForDate(appKey: string, date: string): Promise<void> {
  await pgQuery(
    `UPDATE budget_recommendations
        SET status = 'expired',
            updated_at = NOW()
      WHERE app_key = $1
        AND date = $2::date
        AND status = 'pending'`,
    [appKey, date]
  );
}

export interface LlmAuditLogInput {
  biz_type: string;
  biz_id: string;
  model: string;
  prompt_hash: string;
  response_json: unknown;
  latency_ms: number;
  success: boolean;
}

export async function insertLlmAuditLog(input: LlmAuditLogInput): Promise<void> {
  await pgQuery(
    `INSERT INTO llm_audit_logs (
      biz_type, biz_id, model, prompt_hash, response_json, latency_ms, success
    ) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      input.biz_type,
      input.biz_id,
      input.model,
      input.prompt_hash,
      JSON.stringify(input.response_json ?? {}),
      input.latency_ms,
      input.success
    ]
  );
}

export async function getDailyBriefDispatch(
  reportDate: string,
  kind = 'ops_daily',
  channel = 'feishu'
): Promise<DailyBriefDispatchRecord | null> {
  const result = await pgQuery<DailyBriefDispatchRecord>(
    `SELECT id, report_date, kind, channel, title, content, payload_json, status, manual_triggered,
            last_error, sent_at, created_at, updated_at
       FROM daily_brief_dispatches
      WHERE report_date = $1::date
        AND kind = $2
        AND channel = $3
      LIMIT 1`,
    [reportDate, kind, channel]
  );
  return result.rows[0] ?? null;
}

export interface UpsertDailyBriefDispatchInput {
  report_date: string;
  kind?: string;
  channel?: string;
  title: string;
  content: string;
  payload_json: unknown;
  status: 'sent' | 'failed';
  manual_triggered?: boolean;
  last_error?: string | null;
  sent_at?: string | null;
}

export async function upsertDailyBriefDispatch(
  input: UpsertDailyBriefDispatchInput
): Promise<DailyBriefDispatchRecord> {
  const result = await pgQuery<DailyBriefDispatchRecord>(
    `INSERT INTO daily_brief_dispatches (
      report_date, kind, channel, title, content, payload_json, status, manual_triggered, last_error, sent_at
    ) VALUES (
      $1::date, $2, $3, $4, $5, $6, $7, COALESCE($8, false), NULLIF($9, ''), $10::timestamptz
    )
    ON CONFLICT (report_date, kind, channel) DO UPDATE SET
      title = EXCLUDED.title,
      content = EXCLUDED.content,
      payload_json = EXCLUDED.payload_json,
      status = EXCLUDED.status,
      manual_triggered = daily_brief_dispatches.manual_triggered OR EXCLUDED.manual_triggered,
      last_error = EXCLUDED.last_error,
      sent_at = EXCLUDED.sent_at,
      updated_at = NOW()
    RETURNING id, report_date, kind, channel, title, content, payload_json, status, manual_triggered,
              last_error, sent_at, created_at, updated_at`,
    [
      input.report_date,
      input.kind ?? 'ops_daily',
      input.channel ?? 'feishu',
      input.title,
      input.content,
      JSON.stringify(input.payload_json ?? {}),
      input.status,
      input.manual_triggered ?? false,
      input.last_error ?? '',
      input.sent_at ?? null
    ]
  );
  return result.rows[0];
}

export interface CreateOperationLogInput {
  source: string;
  action: string;
  target_type?: string;
  target_key?: string;
  status?: 'success' | 'failed' | 'skipped' | 'info';
  summary?: string;
  detail_json?: unknown;
}

export async function createOperationLog(input: CreateOperationLogInput): Promise<OperationLogRecord> {
  const result = await pgQuery<OperationLogRecord>(
    `INSERT INTO operation_logs (
      source, action, target_type, target_key, status, summary, detail_json
    ) VALUES (
      $1, $2, COALESCE($3, ''), COALESCE($4, ''), COALESCE($5, 'info'), COALESCE($6, ''), $7
    )
    RETURNING id, source, action, target_type, target_key, status, summary, detail_json, created_at`,
    [
      input.source,
      input.action,
      input.target_type ?? '',
      input.target_key ?? '',
      input.status ?? 'info',
      input.summary ?? '',
      JSON.stringify(input.detail_json ?? {})
    ]
  );
  return result.rows[0];
}

export interface OperationLogFilter {
  source?: string;
  status?: 'success' | 'failed' | 'skipped' | 'info';
  limit?: number;
}

export async function listOperationLogs(filter: OperationLogFilter = {}): Promise<OperationLogRecord[]> {
  const values: unknown[] = [];
  const clauses: string[] = [];

  if (filter.source) {
    values.push(filter.source);
    clauses.push(`source = $${values.length}`);
  }
  if (filter.status) {
    values.push(filter.status);
    clauses.push(`status = $${values.length}`);
  }

  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  values.push(Math.min(200, Math.max(1, filter.limit ?? 50)));

  const result = await pgQuery<OperationLogRecord>(
    `SELECT id, source, action, target_type, target_key, status, summary, detail_json, created_at
       FROM operation_logs
       ${where}
      ORDER BY created_at DESC, id DESC
      LIMIT $${values.length}`,
    values
  );
  return result.rows;
}
