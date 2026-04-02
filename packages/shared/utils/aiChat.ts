import { env } from '../config/env.js';
import { chQuery } from './clickhouse.js';
import { pgQuery } from './postgres.js';

export type AiContextPackType = 'metrics_trend' | 'budget_summary' | 'asa_keyword_summary';
export type AiContextPackTemplateId =
  | 'media_source'
  | 'country'
  | 'campaign'
  | 'platform_media_source'
  | 'action_status'
  | 'keyword'
  | 'stage'
  | 'campaign_adset';

export interface AiChatHistoryMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface AiChatImageInput {
  name: string;
  mimeType: string;
  size: number;
  base64Data: string;
}

export interface AiContextPackSpec {
  type: AiContextPackType;
  templateId: AiContextPackTemplateId;
  appKey: string;
  platform?: string;
  from?: string;
  to?: string;
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

export interface AiChatResult {
  model: string;
  reply: string;
  usage: Record<string, unknown> | null;
  warnings: string[];
  attachments_used: {
    images: Array<{ name: string; mimeType: string; size: number }>;
    context_packs: Array<{
      type: AiContextPackType;
      templateId: AiContextPackTemplateId;
      title: string;
      rowCount: number;
      truncated: boolean;
    }>;
  };
  raw: Record<string, unknown>;
}

const MAX_HISTORY_MESSAGES = 96;
const MAX_HISTORY_CHARS_PER_MESSAGE = 32000;
const MAX_HISTORY_TOTAL_CHARS = 120000;
const MAX_BUCKET_ROWS = 40;
const MAX_GROUP_ROWS = 10;
const MAX_CONTEXT_PACK_PROMPT_CHARS = 24000;
const MAX_CONTEXT_PACK_SUMMARY_CHARS = 7000;
const MIN_CONTEXT_PACK_SUMMARY_CHARS = 240;
const AI_CHAT_TIMEOUT_ERROR = 'ai_chat_timeout';
const AI_CHAT_REQUEST_TIMEOUT_MS = Math.max(env.qwen.timeoutMs, 90000);

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

function normalizePlatform(platform?: string): string | undefined {
  const value = String(platform ?? '')
    .trim()
    .toLowerCase();
  return value ? value : undefined;
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

function normalizeHistory(history: AiChatHistoryMessage[]): AiChatHistoryMessage[] {
  const trimmed = sliceTail(
    history
      .filter((item) => item && (item.role === 'user' || item.role === 'assistant') && hasText(item.content))
      .map((item) => ({
        role: item.role,
        content: String(item.content).trim().slice(0, MAX_HISTORY_CHARS_PER_MESSAGE)
      })),
    MAX_HISTORY_MESSAGES
  );

  let totalChars = 0;
  const kept: AiChatHistoryMessage[] = [];
  for (let index = trimmed.length - 1; index >= 0; index -= 1) {
    const item = trimmed[index];
    const nextChars = totalChars + item.content.length;
    if (kept.length > 0 && nextChars > MAX_HISTORY_TOTAL_CHARS) {
      break;
    }
    kept.push(item);
    totalChars = nextChars;
  }
  return kept.reverse();
}

function extractTextFromMessageContent(raw: unknown): string {
  if (typeof raw === 'string') {
    return raw.trim();
  }
  if (Array.isArray(raw)) {
    return raw
      .map((item) => {
        if (typeof item === 'string') {
          return item.trim();
        }
        if (!item || typeof item !== 'object') {
          return '';
        }
        const obj = item as Record<string, unknown>;
        if (typeof obj.text === 'string') {
          return obj.text.trim();
        }
        return '';
      })
      .filter(Boolean)
      .join('\n')
      .trim();
  }
  return '';
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

function truncateText(value: string, maxChars: number): { text: string; truncated: boolean } {
  const normalized = String(value || '').trim();
  if (!normalized) {
    return { text: '', truncated: false };
  }
  if (!Number.isFinite(maxChars) || maxChars <= 0 || normalized.length <= maxChars) {
    return { text: normalized, truncated: false };
  }
  const clipped = normalized.slice(0, Math.max(0, maxChars - 1)).trimEnd();
  return {
    text: `${clipped}…`,
    truncated: true
  };
}

function formatContextPackFilterValue(value: unknown): string {
  if (typeof value === 'boolean') {
    return value ? '是' : '否';
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? String(value) : '';
  }
  if (typeof value === 'string') {
    return value.trim();
  }
  return '';
}

function buildContextPackMetaLine(pack: AiBuiltContextPack): string {
  const metaParts = [`条目 ${pack.rowCount}`];
  if (pack.truncated) {
    metaParts.push('结果已按 Top N 截断');
  }
  const filterParts = Object.entries(pack.appliedFilters || {})
    .flatMap(([key, value]) => {
      const text = formatContextPackFilterValue(value);
      return text ? [`${key}=${text}`] : [];
    })
    .slice(0, 6);
  if (filterParts.length > 0) {
    metaParts.push(`筛选：${filterParts.join('；')}`);
  }
  return `元信息：${metaParts.join('；')}`;
}

function formatDimensionLabel(templateId: AiContextPackTemplateId): string {
  switch (templateId) {
    case 'media_source':
      return '媒体源';
    case 'country':
      return '国家';
    case 'campaign':
      return '活动';
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

async function buildMetricsTrendPack(spec: AiContextPackSpec): Promise<AiBuiltContextPack> {
  const source = spec.source === 'push' ? 'push' : 'pull';
  const platform = normalizePlatform(spec.platform);
  const dim = METRICS_DIMS[spec.templateId];
  if (!dim) {
    throw new Error('invalid_metrics_template');
  }

  const now = new Date();
  const defaultPullTo = now.toISOString().slice(0, 10);
  const defaultPullFrom = new Date(now.getTime() - 13 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const defaultPushTo = now.toISOString().slice(0, 19).replace('T', ' ');
  const defaultPushFrom = new Date(now.getTime() - 72 * 60 * 60 * 1000).toISOString().slice(0, 19).replace('T', ' ');

  const metric = String(
    spec.metric ||
      (source === 'pull'
        ? 'installs'
        : 'revenue')
  )
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

  const summaryMarkdown = [
    `### 指标时序包`,
    `- 应用：${spec.appKey}${platform ? ` / ${platform}` : ''}`,
    `- 来源：${source === 'pull' ? '广告日报（日级）' : '实时回传（小时级）'}；指标：${formatMetricLabel(metric)}；维度：${formatDimensionLabel(spec.templateId)}`,
    `- 时间范围：${from} ~ ${to}`,
    `- 总量：${formatNum(total)}；最新点：${latest.bucket} = ${formatNum(latest.value)}；峰值：${peak.bucket} = ${formatNum(peak.value)}`,
    deltaRatio === null ? '- 趋势变化：首点为 0，暂不计算变化率' : `- 趋势变化：相对首点 ${deltaRatio >= 0 ? '+' : ''}${formatNum(deltaRatio)}%`,
    normalizedGroups.length
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
      deltaRatio
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
       ON ref.source_type = 'delivery_actions'
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
        to_char(avg(current_d7_roas), 'FM999999990.00') AS avg_roas
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
        to_char(avg(current_d7_roas), 'FM999999990.00') AS avg_roas
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
        to_char(avg(current_d7_roas), 'FM999999990.00') AS avg_roas
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
        to_char(avg(current_d7_roas), 'FM999999990.00') AS avg_roas
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
    avg_roas: '0.00'
  };
  const groups = groupRowsResult.rows.map((row) => ({
    label: row.key_b ? `${row.key_a} / ${row.key_b}` : row.key_a,
    total: Number(row.total || 0),
    installs7d: Number(row.installs_7d || 0),
    avgEcpi: Number(row.avg_ecpi || 0),
    avgRoas: Number(row.avg_roas || 0)
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
    `- 均值：eCPI ${formatNum(summary.avg_ecpi || 0)} / CPP ${formatNum(summary.avg_cpp || 0)} / D7 ROAS ${formatNum(summary.avg_roas || 0)}`,
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
        avgRoas: Number(summary.avg_roas || 0)
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

export async function buildAiContextPacks(
  specs: AiContextPackSpec[]
): Promise<{ packs: AiBuiltContextPack[]; warnings: string[] }> {
  const packs: AiBuiltContextPack[] = [];
  const warnings: string[] = [];

  for (const spec of specs) {
    try {
      if (!spec || !hasText(spec.appKey)) {
        warnings.push('已跳过一个缺少应用标识的数据包。');
        continue;
      }
      if (spec.type === 'metrics_trend') {
        packs.push(await buildMetricsTrendPack(spec));
      } else if (spec.type === 'budget_summary') {
        packs.push(await buildBudgetSummaryPack(spec));
      } else if (spec.type === 'asa_keyword_summary') {
        packs.push(await buildAsaKeywordPack(spec));
      } else {
        warnings.push(`暂不支持的数据包类型：${String((spec as { type?: unknown }).type || 'unknown')}`);
      }
    } catch (error) {
      warnings.push(error instanceof Error ? error.message : '数据包构建失败');
    }
  }

  return { packs, warnings };
}

export function buildAiContextPrompt(packs: AiBuiltContextPack[]): {
  prompt: string;
  warnings: string[];
  packsUsed: AiBuiltContextPack[];
} {
  if (packs.length === 0) {
    return {
      prompt: '',
      warnings: [],
      packsUsed: []
    };
  }
  const intro = '以下是当前工作台自动附带的业务上下文，请优先基于这些数据回答。若上下文不足，请明确说明，不要编造不存在的数据。';
  const sections: string[] = [intro];
  const warnings: string[] = [];
  const packsUsed: AiBuiltContextPack[] = [];
  let usedChars = intro.length;

  for (const pack of packs) {
    const metaLine = buildContextPackMetaLine(pack);
    const sectionHeader = `\n[上下文包 ${packsUsed.length + 1}] ${pack.title}\n${metaLine}\n`;
    const baseSummary = truncateText(pack.summaryMarkdown, MAX_CONTEXT_PACK_SUMMARY_CHARS);
    const remainingChars = MAX_CONTEXT_PACK_PROMPT_CHARS - usedChars - sectionHeader.length;
    if (remainingChars < MIN_CONTEXT_PACK_SUMMARY_CHARS) {
      warnings.push(`上下文包「${pack.title}」因总上下文过长已跳过。`);
      continue;
    }
    const finalSummary = truncateText(baseSummary.text || '暂无可用摘要。', remainingChars);
    const section = `${sectionHeader}${finalSummary.text}`;
    sections.push(section);
    packsUsed.push(pack);
    usedChars += section.length;
    if (baseSummary.truncated || finalSummary.truncated) {
      warnings.push(`上下文包「${pack.title}」内容较长，已自动截短。`);
    }
  }

  return {
    prompt: packsUsed.length > 0 ? sections.join('\n') : '',
    warnings,
    packsUsed
  };
}

async function requestQwenAiChat(input: {
  messages: Array<Record<string, unknown>>;
  packs: AiBuiltContextPack[];
  warnings: string[];
  images: AiChatImageInput[];
  thinkingEnabled: boolean;
}): Promise<AiChatResult> {
  const payload: Record<string, unknown> = {
    model: env.qwen.model,
    temperature: 0.3,
    max_tokens: Math.max(900, env.qwen.maxTokens),
    messages: input.messages,
    extra_body: {
      enable_thinking: input.thinkingEnabled
    }
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), AI_CHAT_REQUEST_TIMEOUT_MS);

  try {
    const res = await fetch(`${env.qwen.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        Authorization: `Bearer ${env.qwen.apiKey}`
      },
      body: JSON.stringify(payload),
      signal: controller.signal
    });

    const responseJson = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      const errorText = extractTextFromMessageContent(
        (responseJson.error as Record<string, unknown> | undefined)?.message ?? responseJson.message
      );
      throw new Error(errorText || `qwen_request_failed_${res.status}`);
    }

    const choices = Array.isArray(responseJson.choices) ? responseJson.choices : [];
    const firstChoice = (choices[0] ?? {}) as Record<string, unknown>;
    const message = (firstChoice.message ?? {}) as Record<string, unknown>;
    const reply = extractTextFromMessageContent(message.content);
    if (!reply) {
      throw new Error('empty_ai_reply');
    }

    return {
      model: env.qwen.model,
      reply,
      usage:
        responseJson.usage && typeof responseJson.usage === 'object'
          ? (responseJson.usage as Record<string, unknown>)
          : null,
      warnings: input.warnings,
      attachments_used: {
        images: input.images.map((image) => ({
          name: image.name,
          mimeType: image.mimeType,
          size: image.size
        })),
        context_packs: input.packs.map((pack) => ({
          type: pack.type,
          templateId: pack.templateId,
          title: pack.title,
          rowCount: pack.rowCount,
          truncated: pack.truncated
        }))
      },
      raw: responseJson
    };
  } catch (error) {
    if (
      error instanceof Error &&
      (error.name === 'AbortError' || /aborted/i.test(error.message) || /timed? ?out/i.test(error.message))
    ) {
      throw new Error(AI_CHAT_TIMEOUT_ERROR);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

export async function runAiChat(input: {
  message: string;
  history: AiChatHistoryMessage[];
  contextPacks: AiContextPackSpec[];
  images: AiChatImageInput[];
}): Promise<AiChatResult> {
  const promptMessage = hasText(input.message) ? String(input.message).trim() : '请结合我附带的上下文和图片，给出中文分析。';
  const normalizedHistory = normalizeHistory(input.history);
  const { packs, warnings } = await buildAiContextPacks(input.contextPacks);
  const contextPromptResult = buildAiContextPrompt(packs);
  const mergedWarnings = [...warnings, ...contextPromptResult.warnings];
  const shouldEnableThinking =
    env.qwen.thinkingEnabled && (input.images.length > 0 || contextPromptResult.packsUsed.length > 0);

  if (!env.qwen.baseUrl || !env.qwen.apiKey) {
    throw new Error('qwen_config_missing');
  }

  const userContent: Array<Record<string, unknown>> = [
    {
      type: 'text',
      text: promptMessage
    }
  ];
  for (const image of input.images) {
    userContent.push({
      type: 'image_url',
      image_url: {
        url: `data:${image.mimeType};base64,${image.base64Data}`
      }
    });
  }

  const messages: Array<Record<string, unknown>> = [
    {
      role: 'system',
      content:
        '你是 Hotspot 控制台的 Guru Ads Agent。默认使用简体中文回答。若用户附带了投放数据、数据库上下文包或图片，请优先基于这些上下文给出克制、可执行的分析结论，不要虚构系统里不存在的事实。若用户没有附带业务上下文，也可以像通用助手一样正常聊天、回答常规问题，不要机械拒答。只有当用户明确要求你基于当前业务数据、截图或工作台上下文做判断，但提供的信息确实不足时，才说明“当前上下文不足”。'
    },
    ...normalizedHistory.map((item) => ({
      role: item.role,
      content: item.content
    }))
  ];

  const contextPrompt = contextPromptResult.prompt;
  if (contextPrompt) {
    messages.push({
      role: 'system',
      content: contextPrompt
    });
  }
  messages.push({
    role: 'user',
    content: userContent
  });

  return requestQwenAiChat({
    messages,
    packs: contextPromptResult.packsUsed,
    warnings: mergedWarnings,
    images: input.images,
    thinkingEnabled: shouldEnableThinking
  });
}
