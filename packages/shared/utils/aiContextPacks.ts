import { env } from '../config/env.js';
import { getDateStringInTimezone, getDateTimeStringInTimezone, shiftDateString } from './businessDate.js';
import { chQuery } from './clickhouse.js';
import { pgQuery } from './postgres.js';
import { buildMatureRoasContextPack } from './roasSummaryTool.js';

export type AiContextPackType = 'metrics_trend' | 'roas_summary' | 'budget_summary' | 'asa_keyword_summary';
export type AiContextPackTemplateId =
  | 'media_source'
  | 'country'
  | 'campaign'
  | 'dashboard_d7_roas'
  | 'mature_window'
  | 'platform_media_source'
  | 'action_status'
  | 'keyword'
  | 'stage'
  | 'campaign_adset';

export interface AiContextPackSpec {
  type: AiContextPackType;
  templateId: AiContextPackTemplateId;
  appKey: string;
  scope?: 'budget' | 'asa';
  platform?: string;
  from?: string;
  to?: string;
  reportDate?: string;
  sourceSection?: string;
  source?: 'push' | 'pull';
  metric?: string;
  eventName?: string;
  status?: string;
  executionStatus?: string;
  isAdopted?: boolean;
  hasManualReview?: boolean;
  stage?: string;
  keyword?: string;
  campaign?: string;
}

export interface AiBuiltContextPack {
  type: AiContextPackType;
  templateId: AiContextPackTemplateId;
  title: string;
  summaryMarkdown: string;
  structured: Record<string, unknown>;
  rowCount: number;
  truncated: boolean;
  appliedFilters: Record<string, unknown>;
}

const MAX_BUCKET_ROWS = 40;
const MAX_GROUP_ROWS = 10;
const PULL_METRICS = new Set(['installs', 'clicks', 'total_cost']);
const PUSH_METRICS = new Set(['revenue', 'event_count', 'purchase_count']);
const METRICS_DIMS: Record<string, 'media_source' | 'country' | 'campaign'> = {
  media_source: 'media_source',
  country: 'country',
  campaign: 'campaign'
};
const BUDGET_TEMPLATES = new Set<AiContextPackTemplateId>(['platform_media_source', 'action_status', 'keyword']);
const ASA_TEMPLATES = new Set<AiContextPackTemplateId>(['stage', 'campaign_adset', 'keyword']);

function hasText(value: unknown): boolean {
  return String(value ?? '').trim().length > 0;
}

function formatNum(value: unknown): string {
  return Number(value ?? 0).toFixed(2);
}

function formatRoasPercent(value: unknown): string {
  return `${(Math.max(0, Number(value ?? 0)) * 100).toFixed(2)}%`;
}

function formatOptionalRoasPercent(value: unknown): string {
  if (value == null || String(value).trim() === '') {
    return '当前不可用';
  }
  const numeric = Number(value);
  return Number.isFinite(numeric) ? formatRoasPercent(numeric) : '当前不可用';
}

function parseNullableNumber(value: unknown): number | null {
  if (value == null || String(value).trim() === '') {
    return null;
  }
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function normalizePlatform(platform?: string): string | undefined {
  const value = String(platform ?? '')
    .trim()
    .toLowerCase();
  return value ? value : undefined;
}

function normalizeRoasScope(scope?: string): 'budget' | 'asa' {
  return String(scope || '')
    .trim()
    .toLowerCase() === 'asa'
    ? 'asa'
    : 'budget';
}

function normalizeDate(value: string | undefined, fallback: string): string {
  const raw = String(value ?? '').trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : fallback;
}

function normalizeDateTimeLike(value: string | undefined, fallback: string, isEndExclusive = false): string {
  const raw = String(value ?? '').trim();
  if (!raw) {
    return fallback;
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    if (isEndExclusive) {
      const date = new Date(`${raw}T00:00:00Z`);
      date.setUTCDate(date.getUTCDate() + 1);
      return date.toISOString().slice(0, 19).replace('T', ' ');
    }
    return `${raw} 00:00:00`;
  }
  const normalized = raw.replace('T', ' ').slice(0, 19);
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(normalized)) {
    return normalized;
  }
  return fallback;
}

function sliceTail<T>(items: T[], limit: number): T[] {
  return items.length <= limit ? items : items.slice(items.length - limit);
}

function buildMetricsNoDataHint(source: 'pull' | 'push', metric: string): string {
  const sourceLabel = source === 'pull' ? '广告日报（日级）' : '实时回传（小时级）';
  const metricLabel = formatMetricLabel(metric);
  return `- 当前时间范围内没有任何 ${sourceLabel} 的「${metricLabel}」聚合记录；这通常表示数据缺失、尚未回传或尚未完成聚合，不能直接视为 0。`;
}

function formatMetricLabel(metric: string): string {
  switch (metric) {
    case 'revenue':
      return '收入';
    case 'event_count':
      return '事件次数';
    case 'purchase_count':
      return '购买次数';
    case 'installs':
      return '安装量';
    case 'clicks':
      return '点击量';
    case 'total_cost':
      return '花费';
    default:
      return metric;
  }
}

function formatDimensionLabel(templateId: AiContextPackTemplateId): string {
  switch (templateId) {
    case 'media_source':
      return '媒体源';
    case 'country':
      return '国家';
    case 'campaign':
      return '活动';
    case 'dashboard_d7_roas':
    case 'mature_window':
      return 'AF Dashboard D7 ROAS';
    case 'platform_media_source':
      return '平台 / 媒体源';
    case 'action_status':
      return '动作 / 状态';
    case 'keyword':
      return '关键词';
    case 'stage':
      return '阶段';
    case 'campaign_adset':
      return '活动 / 广告组';
    default:
      return templateId;
  }
}

function buildMetricsEventFilter(metric: string, eventName?: string): { sql: string; params: Record<string, unknown> } {
  if (metric === 'revenue') {
    return { sql: `AND event_name = '__all__'`, params: {} };
  }
  if (metric === 'purchase_count') {
    return { sql: `AND event_name = 'purchase'`, params: {} };
  }
  if (metric === 'event_count' && hasText(eventName)) {
    return {
      sql: 'AND event_name = {eventName:String}',
      params: { eventName: String(eventName).trim() }
    };
  }
  return { sql: '', params: {} };
}

function resolveMetricsTrendSource(metric: string | undefined, source: string | undefined): 'pull' | 'push' {
  const normalizedMetric = String(metric || '')
    .trim()
    .toLowerCase();
  if (PUSH_METRICS.has(normalizedMetric)) {
    return 'push';
  }
  if (PULL_METRICS.has(normalizedMetric)) {
    return 'pull';
  }
  return source === 'push' ? 'push' : 'pull';
}

async function buildMetricsTrendPack(spec: AiContextPackSpec): Promise<AiBuiltContextPack> {
  const source = resolveMetricsTrendSource(spec.metric, spec.source);
  const platform = normalizePlatform(spec.platform);
  const dim = METRICS_DIMS[spec.templateId];
  if (!dim) {
    throw new Error('invalid_metrics_template');
  }

  const now = new Date();
  const defaultPullTo = getDateStringInTimezone(now, env.timezone);
  const defaultPullFrom = shiftDateString(defaultPullTo, -13);
  const defaultPushTo = getDateTimeStringInTimezone(now, env.timezone);
  const defaultPushFrom = getDateTimeStringInTimezone(new Date(now.getTime() - 72 * 60 * 60 * 1000), env.timezone);

  const metric = String(spec.metric || (source === 'pull' ? 'installs' : 'revenue'))
    .trim()
    .toLowerCase();

  if (source === 'pull' && !PULL_METRICS.has(metric)) {
    throw new Error('invalid_pull_metric');
  }
  if (source === 'push' && !PUSH_METRICS.has(metric)) {
    throw new Error('invalid_push_metric');
  }

  const from = source === 'pull' ? normalizeDate(spec.from, defaultPullFrom) : normalizeDateTimeLike(spec.from, defaultPushFrom);
  const to = source === 'pull' ? normalizeDate(spec.to, defaultPullTo) : normalizeDateTimeLike(spec.to, defaultPushTo, true);

  const table = source === 'pull' ? 'metrics_daily FINAL' : 'metrics_hourly FINAL';
  const bucketExpr = source === 'pull' ? 'toString(date)' : 'toString(hour)';
  const rangeSql =
    source === 'pull'
      ? `date >= toDate({from:String}) AND date <= toDate({to:String})`
      : `hour >= toDateTime({from:String}) AND hour < toDateTime({to:String})`;
  const eventFilter = source === 'push' ? buildMetricsEventFilter(metric, spec.eventName) : { sql: '', params: {} };
  const baseParams: Record<string, unknown> = {
    appKey: spec.appKey,
    platform: platform ?? '',
    from,
    to,
    metric,
    ...eventFilter.params
  };

  const bucketRows = await chQuery<Record<string, unknown>>(
    `SELECT
        ${bucketExpr} AS bucket,
        sum(value) AS value
      FROM ${table}
      WHERE app_key = {appKey:String}
        AND metric = {metric:String}
        AND ({platform:String} = '' OR platform = {platform:String})
        AND ${rangeSql}
        ${eventFilter.sql}
      GROUP BY bucket
      ORDER BY bucket ASC
      LIMIT 400`,
    baseParams
  );
  const topRows = await chQuery<Record<string, unknown>>(
    `SELECT
        ifNull(nullIf(${dim}, ''), 'unknown') AS label,
        sum(value) AS value
      FROM ${table}
      WHERE app_key = {appKey:String}
        AND metric = {metric:String}
        AND ({platform:String} = '' OR platform = {platform:String})
        AND ${rangeSql}
        ${eventFilter.sql}
      GROUP BY label
      ORDER BY value DESC
      LIMIT ${MAX_GROUP_ROWS}`,
    baseParams
  );

  const normalizedBuckets = bucketRows.map((row) => ({
    bucket: String(row.bucket || ''),
    value: Number(row.value || 0)
  }));
  const trimmedBuckets = sliceTail(normalizedBuckets, MAX_BUCKET_ROWS);
  const normalizedGroups = topRows.map((row) => ({
    label: String(row.label || 'unknown'),
    value: Number(row.value || 0)
  }));

  const total = normalizedBuckets.reduce((sum, row) => sum + row.value, 0);
  const latest = trimmedBuckets.at(-1) ?? { bucket: '-', value: 0 };
  const first = trimmedBuckets[0] ?? { bucket: '-', value: 0 };
  const peak = trimmedBuckets.reduce(
    (best, row) => (row.value > best.value ? row : best),
    trimmedBuckets[0] ?? { bucket: '-', value: 0 }
  );
  const deltaRatio = first.value > 0 ? ((latest.value - first.value) / first.value) * 100 : null;
  const truncated = normalizedBuckets.length > trimmedBuckets.length;
  const hasData = normalizedBuckets.length > 0 || normalizedGroups.length > 0;

  const summaryMarkdown = [
    `### 指标时序包`,
    `- 应用：${spec.appKey}${platform ? ` / ${platform}` : ''}`,
    `- 来源：${source === 'pull' ? '广告日报（日级）' : '实时回传（小时级）'}；指标：${formatMetricLabel(metric)}；维度：${formatDimensionLabel(spec.templateId)}`,
    `- 时间范围：${from} ~ ${to}`,
    hasData
      ? `- 总量：${formatNum(total)}；最新点：${latest.bucket} = ${formatNum(latest.value)}；峰值：${peak.bucket} = ${formatNum(peak.value)}`
      : buildMetricsNoDataHint(source, metric),
    hasData
      ? deltaRatio === null
        ? '- 趋势变化：首点为 0，暂不计算变化率'
        : `- 趋势变化：相对首点 ${deltaRatio >= 0 ? '+' : ''}${formatNum(deltaRatio)}%`
      : '- 这份结果不能直接用于判断收入为 0、ROAS 为 0% 或转化为 0；更准确的结论是当前来源暂无可用数据。',
    hasData && normalizedGroups.length
      ? `- Top 维度：${normalizedGroups.map((row) => `${row.label} ${formatNum(row.value)}`).join('；')}`
      : '- Top 维度：当前筛选条件下暂无聚合结果'
  ].join('\n');

  return {
    type: 'metrics_trend',
    templateId: spec.templateId,
    title: `指标时序 · ${formatDimensionLabel(spec.templateId)}`,
    summaryMarkdown,
    structured: {
      source,
      metric,
      eventName: spec.eventName || null,
      appKey: spec.appKey,
      platform: platform || null,
      from,
      to,
      bucketTotals: trimmedBuckets,
      topDimensions: normalizedGroups,
      total,
      latest,
      peak,
      deltaRatio,
      hasData,
      dataStatus: hasData ? 'available' : 'missing'
    },
    rowCount: normalizedGroups.length + trimmedBuckets.length,
    truncated,
    appliedFilters: {
      appKey: spec.appKey,
      platform: platform || null,
      from,
      to,
      source,
      metric,
      eventName: spec.eventName || null
    }
  };
}

function buildBudgetWhere(spec: AiContextPackSpec): { whereSql: string; values: unknown[] } {
  const values: unknown[] = [];
  const clauses: string[] = [];

  values.push(spec.appKey);
  clauses.push(`br.app_key = $${values.length}`);

  const platform = normalizePlatform(spec.platform);
  if (platform) {
    values.push(platform);
    clauses.push(`br.platform = $${values.length}`);
  }
  if (hasText(spec.status)) {
    values.push(String(spec.status).trim());
    clauses.push(`br.status = $${values.length}`);
  }
  if (hasText(spec.from)) {
    values.push(String(spec.from).trim());
    clauses.push(`br.date >= $${values.length}::date`);
  }
  if (hasText(spec.to)) {
    values.push(String(spec.to).trim());
    clauses.push(`br.date <= $${values.length}::date`);
  }
  if (hasText(spec.executionStatus)) {
    values.push(String(spec.executionStatus).trim());
    clauses.push(`COALESCE(ref.execution_status, '') = $${values.length}`);
  }
  if (typeof spec.isAdopted === 'boolean') {
    values.push(spec.isAdopted);
    clauses.push(`COALESCE(ref.is_adopted, FALSE) = $${values.length}`);
  }
  if (typeof spec.hasManualReview === 'boolean') {
    clauses.push(
      spec.hasManualReview
        ? `NULLIF(BTRIM(COALESCE(ref.validation_result, '')), '') IS NOT NULL`
        : `NULLIF(BTRIM(COALESCE(ref.validation_result, '')), '') IS NULL`
    );
  }

  return {
    whereSql: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '',
    values
  };
}

async function buildBudgetSummaryPack(spec: AiContextPackSpec): Promise<AiBuiltContextPack> {
  if (!BUDGET_TEMPLATES.has(spec.templateId)) {
    throw new Error('invalid_budget_template');
  }

  const joinSql = `LEFT JOIN recommendation_execution_feedbacks ref
       ON ref.source_type = 'delivery_actions_non_asa'
      AND ref.recommendation_type = 'budget'
      AND ref.recommendation_id = br.id`;
  const { whereSql, values } = buildBudgetWhere(spec);

  const summaryResult = await pgQuery<{
    total: string;
    avg_confidence: string | null;
    pending_count: string;
    applied_count: string;
    rejected_count: string;
    expired_count: string;
  }>(
    `SELECT
        to_char(count(*), 'FM999999999999999') AS total,
        to_char(avg(br.confidence), 'FM999999990.00') AS avg_confidence,
        to_char(sum(CASE WHEN br.status = 'pending' THEN 1 ELSE 0 END), 'FM999999999999999') AS pending_count,
        to_char(sum(CASE WHEN br.status = 'applied' THEN 1 ELSE 0 END), 'FM999999999999999') AS applied_count,
        to_char(sum(CASE WHEN br.status = 'rejected' THEN 1 ELSE 0 END), 'FM999999999999999') AS rejected_count,
        to_char(sum(CASE WHEN br.status = 'expired' THEN 1 ELSE 0 END), 'FM999999999999999') AS expired_count
      FROM budget_recommendations br
      ${joinSql}
      ${whereSql}`,
    values
  );

  const actionRows = await pgQuery<{ action: string; total: string }>(
    `SELECT br.action, to_char(count(*), 'FM999999999999999') AS total
      FROM budget_recommendations br
      ${joinSql}
      ${whereSql}
      GROUP BY br.action
      ORDER BY count(*) DESC, br.action ASC
      LIMIT 6`,
    values
  );

  let groupSql = '';
  if (spec.templateId === 'platform_media_source') {
    groupSql = `SELECT
        br.platform AS key_a,
        br.media_source AS key_b,
        to_char(count(*), 'FM999999999999999') AS total,
        to_char(avg(br.confidence), 'FM999999990.00') AS avg_confidence,
        to_char(avg(br.change_ratio), 'FM999999990.00') AS avg_change_ratio
      FROM budget_recommendations br
      ${joinSql}
      ${whereSql}
      GROUP BY br.platform, br.media_source
      ORDER BY count(*) DESC, avg(br.confidence) DESC
      LIMIT ${MAX_GROUP_ROWS}`;
  } else if (spec.templateId === 'action_status') {
    groupSql = `SELECT
        br.action AS key_a,
        br.status AS key_b,
        to_char(count(*), 'FM999999999999999') AS total,
        to_char(avg(br.confidence), 'FM999999990.00') AS avg_confidence,
        to_char(avg(br.change_ratio), 'FM999999990.00') AS avg_change_ratio
      FROM budget_recommendations br
      ${joinSql}
      ${whereSql}
      GROUP BY br.action, br.status
      ORDER BY count(*) DESC, avg(br.confidence) DESC
      LIMIT ${MAX_GROUP_ROWS}`;
  } else {
    groupSql = `SELECT
        br.keyword AS key_a,
        '' AS key_b,
        to_char(count(*), 'FM999999999999999') AS total,
        to_char(avg(br.confidence), 'FM999999990.00') AS avg_confidence,
        to_char(avg(br.change_ratio), 'FM999999990.00') AS avg_change_ratio
      FROM budget_recommendations br
      ${joinSql}
      ${whereSql}
      GROUP BY br.keyword
      ORDER BY count(*) DESC, avg(br.confidence) DESC
      LIMIT ${MAX_GROUP_ROWS}`;
  }

  const groupRowsResult = await pgQuery<{
    key_a: string;
    key_b: string;
    total: string;
    avg_confidence: string | null;
    avg_change_ratio: string | null;
  }>(groupSql, values);

  const summary = summaryResult.rows[0] ?? {
    total: '0',
    avg_confidence: '0.00',
    pending_count: '0',
    applied_count: '0',
    rejected_count: '0',
    expired_count: '0'
  };
  const groups = groupRowsResult.rows.map((row) => ({
    label: row.key_b ? `${row.key_a} / ${row.key_b}` : row.key_a,
    total: Number(row.total || 0),
    avgConfidence: Number(row.avg_confidence || 0),
    avgChangeRatio: Number(row.avg_change_ratio || 0)
  }));
  const actions = actionRows.rows.map((row) => `${row.action} ${row.total}`);

  const summaryMarkdown = [
    `### 预算建议包`,
    `- 应用：${spec.appKey}${spec.platform ? ` / ${spec.platform}` : ''}`,
    `- 聚合维度：${formatDimensionLabel(spec.templateId)}`,
    hasText(spec.from) || hasText(spec.to)
      ? `- 日期范围：${String(spec.from || '不限')} ~ ${String(spec.to || '不限')}`
      : '- 日期范围：不限',
    `- 总建议数：${summary.total}；平均置信度：${formatNum(summary.avg_confidence || 0)}`,
    `- 状态分布：pending ${summary.pending_count} / applied ${summary.applied_count} / rejected ${summary.rejected_count} / expired ${summary.expired_count}`,
    actions.length ? `- 动作分布：${actions.join('；')}` : '- 动作分布：暂无',
    groups.length
      ? `- Top 聚合：${groups
          .map((row) => `${row.label}（${row.total} 条，置信度 ${formatNum(row.avgConfidence)}）`)
          .join('；')}`
      : '- Top 聚合：当前筛选条件下暂无数据'
  ].join('\n');

  return {
    type: 'budget_summary',
    templateId: spec.templateId,
    title: `预算建议 · ${formatDimensionLabel(spec.templateId)}`,
    summaryMarkdown,
    structured: {
      appKey: spec.appKey,
      platform: normalizePlatform(spec.platform) || null,
      from: spec.from || null,
      to: spec.to || null,
      status: spec.status || null,
      executionStatus: spec.executionStatus || null,
      isAdopted: typeof spec.isAdopted === 'boolean' ? spec.isAdopted : null,
      hasManualReview: typeof spec.hasManualReview === 'boolean' ? spec.hasManualReview : null,
      summary: {
        total: Number(summary.total || 0),
        avgConfidence: Number(summary.avg_confidence || 0),
        pendingCount: Number(summary.pending_count || 0),
        appliedCount: Number(summary.applied_count || 0),
        rejectedCount: Number(summary.rejected_count || 0),
        expiredCount: Number(summary.expired_count || 0)
      },
      actionBreakdown: actionRows.rows.map((row) => ({
        action: row.action,
        total: Number(row.total || 0)
      })),
      groups
    },
    rowCount: groups.length,
    truncated: false,
    appliedFilters: {
      appKey: spec.appKey,
      platform: normalizePlatform(spec.platform) || null,
      from: spec.from || null,
      to: spec.to || null,
      status: spec.status || null,
      executionStatus: spec.executionStatus || null,
      isAdopted: typeof spec.isAdopted === 'boolean' ? spec.isAdopted : null,
      hasManualReview: typeof spec.hasManualReview === 'boolean' ? spec.hasManualReview : null
    }
  };
}

async function buildRoasSummaryPack(spec: AiContextPackSpec): Promise<AiBuiltContextPack> {
  if (spec.templateId !== 'dashboard_d7_roas' && spec.templateId !== 'mature_window') {
    throw new Error('invalid_roas_template');
  }
  const templateId = spec.templateId === 'mature_window' ? 'dashboard_d7_roas' : spec.templateId;
  const pack = await buildMatureRoasContextPack({
    appKey: spec.appKey,
    scope: normalizeRoasScope(spec.scope),
    platform: normalizePlatform(spec.platform),
    reportDate: spec.reportDate
  });
  return {
    type: 'roas_summary',
    templateId,
    title: pack.title,
    summaryMarkdown: pack.summaryMarkdown,
    structured: pack.structured,
    rowCount: pack.rowCount,
    truncated: false,
    appliedFilters: pack.appliedFilters
  };
}

function buildAsaWhere(spec: AiContextPackSpec): { whereSql: string; values: unknown[] } {
  const values: unknown[] = [];
  const clauses: string[] = [];

  values.push(spec.appKey);
  clauses.push(`app_key = $${values.length}`);

  const platform = normalizePlatform(spec.platform);
  if (platform) {
    values.push(platform);
    clauses.push(`platform = $${values.length}`);
  }
  if (hasText(spec.stage)) {
    values.push(String(spec.stage).trim());
    clauses.push(`current_stage = $${values.length}`);
  }
  if (hasText(spec.keyword)) {
    values.push(`%${String(spec.keyword).trim().toLowerCase()}%`);
    clauses.push(`(LOWER(keyword) LIKE $${values.length} OR LOWER(campaign) LIKE $${values.length} OR LOWER(adset) LIKE $${values.length})`);
  }
  if (hasText(spec.campaign)) {
    values.push(`%${String(spec.campaign).trim().toLowerCase()}%`);
    clauses.push(`LOWER(campaign) LIKE $${values.length}`);
  }
  if (hasText(spec.from)) {
    values.push(String(spec.from).trim());
    clauses.push(`last_seen_date >= $${values.length}::date`);
  }
  if (hasText(spec.to)) {
    values.push(String(spec.to).trim());
    clauses.push(`last_seen_date <= $${values.length}::date`);
  }

  return {
    whereSql: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '',
    values
  };
}

async function buildAsaKeywordPack(spec: AiContextPackSpec): Promise<AiBuiltContextPack> {
  if (!ASA_TEMPLATES.has(spec.templateId)) {
    throw new Error('invalid_asa_template');
  }

  const { whereSql, values } = buildAsaWhere(spec);

  const summaryResult = await pgQuery<{
    total: string;
    installs_7d: string | null;
    total_cost_7d: string | null;
    avg_ecpi: string | null;
    avg_cpp: string | null;
    avg_roas: string | null;
  }>(
    `SELECT
        to_char(count(*), 'FM999999999999999') AS total,
        to_char(sum(installs_7d), 'FM999999999999990.00') AS installs_7d,
        to_char(sum(total_cost_7d), 'FM999999999999990.00') AS total_cost_7d,
        to_char(avg(current_ecpi), 'FM999999990.00') AS avg_ecpi,
        to_char(avg(current_cpp), 'FM999999990.00') AS avg_cpp,
        to_char(
          sum(current_d7_roas * CASE WHEN roas_primary_source = 'af_cohort' AND roas_warning_code = 'none' THEN total_cost_7d ELSE 0 END)
            / nullif(sum(CASE WHEN roas_primary_source = 'af_cohort' AND roas_warning_code = 'none' THEN total_cost_7d ELSE 0 END), 0),
          'FM999999990.00'
        ) AS avg_roas
      FROM asa_keyword_states
      ${whereSql}`,
    values
  );

  let groupSql = '';
  if (spec.templateId === 'stage') {
    groupSql = `SELECT
        current_stage AS key_a,
        '' AS key_b,
        to_char(count(*), 'FM999999999999999') AS total,
        to_char(sum(installs_7d), 'FM999999999999990.00') AS installs_7d,
        to_char(avg(current_ecpi), 'FM999999990.00') AS avg_ecpi,
        to_char(
          sum(current_d7_roas * CASE WHEN roas_primary_source = 'af_cohort' AND roas_warning_code = 'none' THEN total_cost_7d ELSE 0 END)
            / nullif(sum(CASE WHEN roas_primary_source = 'af_cohort' AND roas_warning_code = 'none' THEN total_cost_7d ELSE 0 END), 0),
          'FM999999990.00'
        ) AS avg_roas
      FROM asa_keyword_states
      ${whereSql}
      GROUP BY current_stage
      ORDER BY count(*) DESC, current_stage ASC
      LIMIT ${MAX_GROUP_ROWS}`;
  } else if (spec.templateId === 'campaign_adset') {
    groupSql = `SELECT
        campaign AS key_a,
        adset AS key_b,
        to_char(count(*), 'FM999999999999999') AS total,
        to_char(sum(installs_7d), 'FM999999999999990.00') AS installs_7d,
        to_char(avg(current_ecpi), 'FM999999990.00') AS avg_ecpi,
        to_char(
          sum(current_d7_roas * CASE WHEN roas_primary_source = 'af_cohort' AND roas_warning_code = 'none' THEN total_cost_7d ELSE 0 END)
            / nullif(sum(CASE WHEN roas_primary_source = 'af_cohort' AND roas_warning_code = 'none' THEN total_cost_7d ELSE 0 END), 0),
          'FM999999990.00'
        ) AS avg_roas
      FROM asa_keyword_states
      ${whereSql}
      GROUP BY campaign, adset
      ORDER BY sum(installs_7d) DESC, count(*) DESC
      LIMIT ${MAX_GROUP_ROWS}`;
  } else {
    groupSql = `SELECT
        keyword AS key_a,
        '' AS key_b,
        to_char(count(*), 'FM999999999999999') AS total,
        to_char(sum(installs_7d), 'FM999999999999990.00') AS installs_7d,
        to_char(avg(current_ecpi), 'FM999999990.00') AS avg_ecpi,
        to_char(
          sum(current_d7_roas * CASE WHEN roas_primary_source = 'af_cohort' AND roas_warning_code = 'none' THEN total_cost_7d ELSE 0 END)
            / nullif(sum(CASE WHEN roas_primary_source = 'af_cohort' AND roas_warning_code = 'none' THEN total_cost_7d ELSE 0 END), 0),
          'FM999999990.00'
        ) AS avg_roas
      FROM asa_keyword_states
      ${whereSql}
      GROUP BY keyword
      ORDER BY sum(installs_7d) DESC, count(*) DESC
      LIMIT ${MAX_GROUP_ROWS}`;
  }

  const groupRowsResult = await pgQuery<{
    key_a: string;
    key_b: string;
    total: string;
    installs_7d: string | null;
    avg_ecpi: string | null;
    avg_roas: string | null;
  }>(groupSql, values);

  const recoClauses: string[] = ['app_key = $1'];
  const recoValues: unknown[] = [spec.appKey];
  const platform = normalizePlatform(spec.platform);
  if (platform) {
    recoValues.push(platform);
    recoClauses.push(`platform = $${recoValues.length}`);
  }
  if (hasText(spec.from)) {
    recoValues.push(String(spec.from).trim());
    recoClauses.push(`date >= $${recoValues.length}::date`);
  }
  if (hasText(spec.to)) {
    recoValues.push(String(spec.to).trim());
    recoClauses.push(`date <= $${recoValues.length}::date`);
  }
  const recoWhereSql = recoClauses.length ? `WHERE ${recoClauses.join(' AND ')}` : '';
  const actionRows = await pgQuery<{ action: string; total: string }>(
    `SELECT action, to_char(count(*), 'FM999999999999999') AS total
      FROM asa_keyword_recommendations
      ${recoWhereSql}
      GROUP BY action
      ORDER BY count(*) DESC, action ASC
      LIMIT 6`,
    recoValues
  );

  const summary = summaryResult.rows[0] ?? {
    total: '0',
    installs_7d: '0.00',
    total_cost_7d: '0.00',
    avg_ecpi: '0.00',
    avg_cpp: '0.00',
    avg_roas: null
  };
  const groups = groupRowsResult.rows.map((row) => ({
    label: row.key_b ? `${row.key_a} / ${row.key_b}` : row.key_a,
    total: Number(row.total || 0),
    installs7d: Number(row.installs_7d || 0),
    avgEcpi: Number(row.avg_ecpi || 0),
    avgRoas: parseNullableNumber(row.avg_roas)
  }));
  const actions = actionRows.rows.map((row) => `${row.action} ${row.total}`);

  const summaryMarkdown = [
    `### ASA 关键词包`,
    `- 应用：${spec.appKey}${platform ? ` / ${platform}` : ''}`,
    `- 聚合维度：${formatDimensionLabel(spec.templateId)}`,
    hasText(spec.from) || hasText(spec.to)
      ? `- 日期范围：${String(spec.from || '不限')} ~ ${String(spec.to || '不限')}`
      : '- 日期范围：不限',
    `- 关键词总数：${summary.total}；7 日安装：${formatNum(summary.installs_7d || 0)}；7 日花费：${formatNum(summary.total_cost_7d || 0)}`,
    `- 均值：eCPI ${formatNum(summary.avg_ecpi || 0)} / CPP ${formatNum(summary.avg_cpp || 0)} / D7 ROAS ${formatOptionalRoasPercent(summary.avg_roas)}`,
    actions.length ? `- 建议动作：${actions.join('；')}` : '- 建议动作：当前范围内暂无推荐记录',
    groups.length
      ? `- Top 聚合：${groups
          .map((row) => `${row.label}（${row.total} 个词，安装 ${formatNum(row.installs7d)}）`)
          .join('；')}`
      : '- Top 聚合：当前筛选条件下暂无数据'
  ].join('\n');

  return {
    type: 'asa_keyword_summary',
    templateId: spec.templateId,
    title: `ASA 关键词 · ${formatDimensionLabel(spec.templateId)}`,
    summaryMarkdown,
    structured: {
      appKey: spec.appKey,
      platform: platform || null,
      from: spec.from || null,
      to: spec.to || null,
      stage: spec.stage || null,
      keyword: spec.keyword || null,
      campaign: spec.campaign || null,
      summary: {
        total: Number(summary.total || 0),
        installs7d: Number(summary.installs_7d || 0),
        totalCost7d: Number(summary.total_cost_7d || 0),
        avgEcpi: Number(summary.avg_ecpi || 0),
        avgCpp: Number(summary.avg_cpp || 0),
        avgRoas: parseNullableNumber(summary.avg_roas)
      },
      actionBreakdown: actionRows.rows.map((row) => ({
        action: row.action,
        total: Number(row.total || 0)
      })),
      groups
    },
    rowCount: groups.length,
    truncated: false,
    appliedFilters: {
      appKey: spec.appKey,
      platform: platform || null,
      from: spec.from || null,
      to: spec.to || null,
      stage: spec.stage || null,
      keyword: spec.keyword || null,
      campaign: spec.campaign || null
    }
  };
}

export async function buildAiContextPack(spec: AiContextPackSpec): Promise<AiBuiltContextPack> {
  if (!spec || !hasText(spec.appKey)) {
    throw new Error('missing_app_key');
  }
  if (spec.type === 'metrics_trend') {
    return buildMetricsTrendPack(spec);
  }
  if (spec.type === 'roas_summary') {
    return buildRoasSummaryPack(spec);
  }
  if (spec.type === 'budget_summary') {
    return buildBudgetSummaryPack(spec);
  }
  if (spec.type === 'asa_keyword_summary') {
    return buildAsaKeywordPack(spec);
  }
  throw new Error(`unsupported_context_pack_type:${String((spec as { type?: unknown }).type || 'unknown')}`);
}

export async function buildAiContextPacks(
  specs: AiContextPackSpec[]
): Promise<{ packs: AiBuiltContextPack[]; warnings: string[] }> {
  const packs: AiBuiltContextPack[] = [];
  const warnings: string[] = [];

  for (const spec of specs) {
    try {
      packs.push(await buildAiContextPack(spec));
    } catch (error) {
      warnings.push(error instanceof Error ? error.message : '数据包构建失败');
    }
  }

  return { packs, warnings };
}
