import crypto from 'crypto';
import { env } from '../config/env.js';
import { md5Hex } from './hash.js';
import { chQuery } from './clickhouse.js';
import { pgQuery } from './postgres.js';
import { getPushScheduleTarget } from './runtimeSchedule.js';
import {
  ensureBudgetRecommendationsSchema,
  getDailyBriefDispatch,
  listAlerts,
  listApps,
  listEnabledDailyBriefRoutes,
  releaseJobLock,
  tryAcquireJobLock,
  upsertDailyBriefDispatch
} from './repositories.js';
import { sendAlertNotification, sendFeishuInteractiveCardNotification, type NotificationResult } from './notifier.js';
import { resolveDisplayName, resolveProductViewName } from './displayName.js';
import { getTzParts } from './schedule.js';
import { buildAfMetricScopeMeta, type AfMetricScopeMeta } from './afMetricScopes.js';
import { buildAfOfficialBatchSnapshot, type AfOfficialBatchSnapshot } from './appsflyerOfficialSnapshots.js';
import { buildDailyReportExpectedComponents } from './appsflyerExpectedComponents.js';
import {
  afDashboardCampaignKey,
  queryAfDashboardDailyCampaignMetrics,
  type AfDashboardCampaignMetric
} from './afDashboardMetrics.js';
import type { AppConfigRecord, DailyBriefRouteRecord, RoasPrimarySource, RoasWarningCode } from '../types/models.js';

interface LoggerLike {
  info: (message: string, meta?: Record<string, unknown>) => void;
  warn: (message: string, meta?: Record<string, unknown>) => void;
  error: (message: string, meta?: Record<string, unknown>) => void;
}

interface DailyBriefFilters {
  appKey?: string;
  platform?: string;
  mediaSources?: string[];
}

interface DailyBriefAppMetrics {
  app_key: string;
  platform: string;
  installs: number;
  clicks: number;
  total_cost: number;
  blended_ecpi: number;
}

interface DailyBriefBudgetHighlight {
  app_key: string;
  platform: string;
  media_source: string;
  keyword: string;
  action: string;
  change_ratio: number;
  current_ecpi: number;
  target_ecpi: number;
  primary_metric: 'ecpi' | 'roas';
  metric_mode: 'active' | 'roas_pending_revenue';
  current_roas: number | null;
  af_cohort_roas: number | null;
  local_derived_roas: number | null;
  roas_primary_source: RoasPrimarySource;
  roas_warning_code: RoasWarningCode;
  roas_deviation_ratio: number | null;
  target_roas: number | null;
  roas_window_from: string | null;
  roas_window_to: string | null;
  roas_data_status: 'complete' | 'partial' | 'partial_low' | 'pending' | 'unavailable';
  confidence: number;
  reason_code: string;
  execution_actions?: Array<{ label?: string; code?: string }> | null;
  scenario_tags?: string[] | null;
  llm_summary?: {
    summary_cn?: string;
    action_items?: string[];
    scenario_tags?: string[];
  } | null;
  reason_summary?: string;
  official_dashboard?: AfDashboardCampaignMetric | null;
}

interface DailyBriefAlertHighlight {
  app_key: string;
  platform: string;
  severity: string;
  metric: string;
  delta_value: number;
  status: string;
  explanation: string;
}

interface DailyBriefActionItem {
  priority: 'P0' | 'P1' | 'P2';
  category: 'alert' | 'budget' | 'data';
  title: string;
  detail: string;
}

export interface DailyBriefFocusProduct {
  app_key: string;
  platform: string;
  display_name: string;
  signal: '风险提示' | '表现亮点';
  headline: string;
  detail: string;
  sort_rank: number;
  total_cost: number;
}

interface FeishuCardPayload {
  config: {
    wide_screen_mode: boolean;
    enable_forward: boolean;
  };
  header: {
    template: 'blue' | 'green' | 'orange' | 'red' | 'grey';
    title: {
      tag: 'plain_text';
      content: string;
    };
  };
  elements: Array<Record<string, unknown>>;
}

export interface DailyBriefPreview {
  report_date: string;
  title: string;
  text: string;
  metric_scope: AfMetricScopeMeta;
  official_snapshot: AfOfficialBatchSnapshot;
  today_judgment: string;
  anomaly_reminder: string;
  render_mode: 'interactive' | 'text_fallback';
  feishu_card_payload: FeishuCardPayload;
  summary: {
    app_count: number;
    apps_with_data: number;
    total_installs: number;
    total_clicks: number;
    total_cost: number;
    blended_ecpi: number;
    open_alerts: number;
    pending_budget_actions: number;
  };
  filters: {
    app_key: string | null;
    platform: string | null;
    media_sources: string[];
  };
  media_sources_applied: string[];
  app_rows: Array<
    DailyBriefAppMetrics & {
      display_name: string;
      open_alerts: number;
      pending_budget_actions: number;
    }
  >;
  apps: Array<
    DailyBriefAppMetrics & {
      display_name: string;
      open_alerts: number;
      pending_budget_actions: number;
    }
  >;
  budget_highlights: DailyBriefBudgetHighlight[];
  alert_highlights: DailyBriefAlertHighlight[];
  action_items: DailyBriefActionItem[];
  focus_products: DailyBriefFocusProduct[];
}

export interface DailyBriefSendResult {
  ok: boolean;
  skipped: boolean;
  report: DailyBriefPreview;
  notify: NotificationResult;
  dispatch?: Awaited<ReturnType<typeof upsertDailyBriefDispatch>>;
}

export interface ScheduledDailyBriefRunSummary {
  completed: boolean;
  report_date: string | null;
  sent_count: number;
  failed_count: number;
  skipped_count: number;
}

const DAILY_BRIEF_BUDGET_MAX_ITEMS = 30;
const DAILY_BRIEF_SEND_LOCK_PREFIX = 'daily_brief:send';
const DAILY_BRIEF_SEND_LOCK_TTL_MS = 30 * 60 * 1000;
const DAILY_BRIEF_BUDGET_MIN_CONFIDENCE = 0.8;
const DAILY_BRIEF_BUDGET_MIN_DELTA_RATIO = 0.25;
const ASA_MEDIA_SOURCE = 'apple search ads';

function numberValue(raw: unknown): number {
  const value = Number(raw);
  return Number.isFinite(value) ? value : 0;
}

function cleanText(value: string | null | undefined): string {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizePlatformValue(platform: string | null | undefined): string {
  const value = cleanText(platform).toLowerCase();
  if (value === 'ios' || value === 'android') {
    return value;
  }
  return '';
}

function normalizeMediaSources(mediaSources?: string[]): string[] {
  return Array.from(
    new Set(
      (Array.isArray(mediaSources) ? mediaSources : [])
        .map((item) => cleanText(item))
        .filter((item) => item.length > 0)
        .sort((a, b) => a.localeCompare(b))
    )
  );
}

function isAsaMediaSource(mediaSource: string | null | undefined): boolean {
  return cleanText(mediaSource).toLowerCase() === ASA_MEDIA_SOURCE;
}

function buildDailyBriefRoutePayload(filters: DailyBriefFilters): {
  app_key: string | null;
  platform: string | null;
  media_sources: string[];
} {
  return {
    app_key: cleanText(filters.appKey) || null,
    platform: normalizePlatformValue(filters.platform) || null,
    media_sources: normalizeMediaSources(filters.mediaSources)
  };
}

function hasDailyBriefRouteScope(filters: DailyBriefFilters): boolean {
  const payload = buildDailyBriefRoutePayload(filters);
  return Boolean(payload.app_key || payload.platform || payload.media_sources.length > 0);
}

function filtersToRouteKey(filters: DailyBriefFilters, prefix = 'scope'): string {
  const payload = JSON.stringify(buildDailyBriefRoutePayload(filters));
  return `${prefix}:${md5Hex(payload)}`;
}

function dailyBriefRouteForFilters(routes: DailyBriefRouteRecord[], filters: DailyBriefFilters): DailyBriefRouteRecord | null {
  const target = buildDailyBriefRoutePayload(filters);
  return routes.find((route) => {
    const candidate = buildDailyBriefRoutePayload(buildRouteFilters(route));
    return candidate.app_key === target.app_key
      && candidate.platform === target.platform
      && JSON.stringify(candidate.media_sources) === JSON.stringify(target.media_sources);
  }) ?? null;
}

function resolveDailyBriefDispatchRouteKey(
  filters: DailyBriefFilters,
  routes: DailyBriefRouteRecord[],
  explicitRouteKey?: string
): string {
  if (explicitRouteKey) {
    return explicitRouteKey;
  }
  const matchedRoute = dailyBriefRouteForFilters(routes, filters);
  if (matchedRoute) {
    return `route:${matchedRoute.id}`;
  }
  return hasDailyBriefRouteScope(filters) ? filtersToRouteKey(filters) : 'all';
}

function buildDailyBriefSendLockName(
  reportDate: string,
  routeKey: string,
  filters: DailyBriefFilters
): string {
  const mediaKey = Array.isArray(filters.mediaSources) && filters.mediaSources.length > 0
    ? filters.mediaSources.map((item) => String(item || '').trim()).filter(Boolean).sort().join(',')
    : 'all';
  return [
    DAILY_BRIEF_SEND_LOCK_PREFIX,
    reportDate,
    routeKey,
    filters.appKey || 'all',
    filters.platform || 'all',
    mediaKey || 'all'
  ].join(':');
}

function toDateString(year: number, month: number, day: number): string {
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function shiftDateString(dateString: string, days: number): string {
  const [year, month, day] = dateString.split('-').map(Number);
  const value = new Date(Date.UTC(year, month - 1, day));
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

export function getDailyBriefDefaultReportDate(now = new Date(), timeZone = env.timezone): string {
  const parts = getTzParts(now, timeZone);
  const today = toDateString(parts.year, parts.month, parts.day);
  return shiftDateString(today, -1);
}

export function getCurrentHourInTimezone(now = new Date(), timeZone = env.timezone): number {
  return getTzParts(now, timeZone).hour;
}

function formatUsd(value: number): string {
  return `$${value.toFixed(2)}`;
}

function actionLabel(action: string): string {
  if (action === 'increase') return '上调';
  if (action === 'decrease') return '下调';
  if (action === 'pause') return '暂停';
  return '保持';
}

function actionEmoji(action: string): string {
  if (action === 'increase') return '✅';
  if (action === 'decrease') return '🔻';
  if (action === 'pause') return '⏸️';
  return '➖';
}

function priorityEmoji(priority: DailyBriefActionItem['priority']): string {
  if (priority === 'P0') return '🚨';
  if (priority === 'P1') return '⚠️';
  return '💡';
}

function metricLabel(metric: string): string {
  if (metric === 'revenue') return '收入';
  if (metric === 'event_count') return '事件数';
  if (metric === 'purchase_count') return '购买数';
  return metric || '-';
}

function severityRank(severity: string): number {
  if (severity === 'P0') return 0;
  if (severity === 'P1') return 1;
  if (severity === 'P2') return 2;
  return 3;
}

function budgetDeltaRatio(row: Pick<DailyBriefBudgetHighlight, 'current_ecpi' | 'target_ecpi'>): number {
  const base = Math.max(Math.abs(Number(row.target_ecpi) || 0), 0.01);
  return Math.abs((Number(row.current_ecpi) || 0) - (Number(row.target_ecpi) || 0)) / base;
}

function isSignificantBudgetHighlight(row: DailyBriefBudgetHighlight): boolean {
  const executionActions = Array.isArray(row.execution_actions) ? row.execution_actions : [];
  if (executionActions.length > 0) {
    return Number(row.confidence) >= DAILY_BRIEF_BUDGET_MIN_CONFIDENCE;
  }
  return (
    Number(row.confidence) >= DAILY_BRIEF_BUDGET_MIN_CONFIDENCE &&
    budgetDeltaRatio(row) >= DAILY_BRIEF_BUDGET_MIN_DELTA_RATIO
  );
}

function formatExecutionActionSummary(row: DailyBriefBudgetHighlight): string {
  const executionActions = Array.isArray(row.execution_actions)
    ? row.execution_actions.map((item) => String(item?.label || '').trim()).filter(Boolean)
    : [];
  if (executionActions.length > 0) {
    return executionActions.join(' / ');
  }
  const actionItems = Array.isArray(row.llm_summary?.action_items)
    ? row.llm_summary.action_items.map((item) => String(item).trim()).filter(Boolean)
    : [];
  return actionItems.slice(0, 2).join(' / ');
}

function formatBudgetActionSummary(row: DailyBriefBudgetHighlight): string {
  if (row.action === 'hold') {
    return '保持预算';
  }
  return `${actionLabel(row.action)} ${Math.abs(row.change_ratio * 100).toFixed(0)}%`;
}

function formatRoasWindowSummary(row: Pick<DailyBriefBudgetHighlight, 'roas_window_from' | 'roas_window_to'>): string {
  const from = cleanText(row.roas_window_from);
  const to = cleanText(row.roas_window_to);
  if (from && to) {
    return `${from} 至 ${to}`;
  }
  return '官方 D7 窗口';
}

function formatRoasPercent(value: number | null | undefined): string {
  return `${(Math.max(0, Number(value || 0)) * 100).toFixed(2)}%`;
}

function formatDecisionMetricStatus(row: DailyBriefBudgetHighlight): string {
  if (row.primary_metric !== 'roas') {
    return `决策 eCPI ${formatUsd(row.current_ecpi)} ｜ 目标 ${formatUsd(row.target_ecpi)}`;
  }
  const windowLabel = formatRoasWindowSummary(row);
  const missingLabel = `AF Cohort ROAS 暂无官方快照（${windowLabel}）`;
  if (row.roas_data_status === 'pending' || row.metric_mode === 'roas_pending_revenue') {
    return `${missingLabel}｜Metabase / AF Dashboard 口径`;
  }
  if (row.roas_data_status === 'partial') {
    return row.current_roas != null
      ? `AF面板 D7 ROAS ${formatRoasPercent(row.current_roas)}（${windowLabel} / Metabase / AF Dashboard 口径，部分覆盖）`
      : `${missingLabel}｜Metabase / AF Dashboard 口径`;
  }
  if (row.roas_data_status === 'partial_low') {
    return row.current_roas != null
      ? `AF面板 D7 ROAS ${formatRoasPercent(row.current_roas)}（${windowLabel} / Metabase / AF Dashboard 口径，覆盖率偏低）`
      : `${missingLabel}｜Metabase / AF Dashboard 口径`;
  }
  if (row.roas_data_status === 'unavailable') {
    return `${missingLabel}｜Metabase / AF Dashboard 口径`;
  }
  if (row.current_roas != null && row.target_roas != null) {
    return `AF面板 D7 ROAS ${formatRoasPercent(row.current_roas)}（${windowLabel} / Metabase / AF Dashboard 口径）｜目标 ${formatRoasPercent(row.target_roas)}`;
  }
  if (row.current_roas != null) {
    return `AF面板 D7 ROAS ${formatRoasPercent(row.current_roas)}（${windowLabel} / Metabase / AF Dashboard 口径）`;
  }
  return `${missingLabel}｜Metabase / AF Dashboard 口径`;
}

function formatBudgetMetricStatus(row: DailyBriefBudgetHighlight): string {
  const official = row.official_dashboard;
  const decisionStatus = formatDecisionMetricStatus(row);
  if (!official) {
    return `AF面板 ${row.primary_metric === 'roas' ? 'ROAS-Tool ' : ''}暂无官方快照 ｜ ${decisionStatus}`;
  }

  // eCPI follows AppsFlyer's User Acquisition dashboard: Cost / Attributions.
  // ROAS follows the dashboard D7 column via Metabase / AF Dashboard D7 ROI over D-6..D.
  const dashboardStatus = [
    `AF面板 ${official.window_from} 至 ${official.window_to}`,
    `Cost ${formatUsd(official.cost)}`,
    `Attributions ${official.attributions.toFixed(0)}`,
    `eCPI ${formatUsd(official.ecpi)}`
  ].join(' ｜ ');
  return `${dashboardStatus} ｜ ${decisionStatus}`;
}

function trimSentence(value: string, limit = 72): string {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  return text.length > limit ? `${text.slice(0, limit)}...` : text;
}

function normalizeBudgetReasonText(value: string): string {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .replace(/^建议(提高|降低|暂停|保持)预算[，,、]?\s*/u, '')
    .replace(/^建议(提高|降低|暂停|保持)[，,、]?\s*/u, '')
    .trim()
    .replace(/[。；;，,]\s*$/u, '');
}

function buildBudgetAdjustmentReason(row: DailyBriefBudgetHighlight): string {
  const llmSummary = normalizeBudgetReasonText(String(row.llm_summary?.summary_cn || ''));
  if (llmSummary) {
    return llmSummary;
  }

  if (row.primary_metric === 'roas') {
    const windowLabel = formatRoasWindowSummary(row);
    if (row.roas_warning_code === 'af_missing' || row.roas_warning_code === 'af_grain_unavailable') {
      return `官方 D7 窗口（${windowLabel}）暂无 AF Cohort ROAS 快照，当前不使用非官方 ROAS 替代。`;
    }
    if (row.roas_warning_code === 'af_vs_local_mismatch') {
      return `官方 D7 窗口（${windowLabel}）以 AF Cohort ROAS 为准，其他诊断值不进入主展示。`;
    }
    if (row.roas_data_status === 'pending' || row.metric_mode === 'roas_pending_revenue') {
      return `官方 D7 窗口（${windowLabel}）Cohort ROAS 仍在回流，先保持预算并继续观察 eCPI 与执行动作结果。`;
    }
    if (row.roas_data_status === 'partial') {
      return `官方 D7 窗口（${windowLabel}）已有 AF Cohort ROAS，建议结合执行动作继续观察后续修正。`;
    }
    if (row.roas_data_status === 'partial_low') {
      return `官方 D7 窗口（${windowLabel}）AF Cohort ROAS 覆盖率偏低，建议谨慎解读并等待回刷。`;
    }
    if (row.roas_data_status === 'unavailable') {
      return `官方 D7 窗口（${windowLabel}）暂无 AF Cohort ROAS，先观察 Cost、Attributions 与 eCPI。`;
    }
    if (row.current_roas != null && row.target_roas != null) {
      if (row.action === 'increase') {
        return `官方 D7 ROAS（${windowLabel}）高于目标，可在维持回收约束下继续小步放量。`;
      }
      if (row.action === 'decrease') {
        return `官方 D7 ROAS（${windowLabel}）低于目标，继续维持当前预算会拖累整体回收效率。`;
      }
      if (row.action === 'pause') {
        return `官方 D7 ROAS（${windowLabel}）明显不达标，继续投放的边际回收偏弱，建议先暂停观察。`;
      }
      return `官方 D7 ROAS（${windowLabel}）暂未形成明确方向，建议继续观察下一轮回刷。`;
    }
  }

  const executionSummary = formatExecutionActionSummary(row);
  if (executionSummary) {
    return `执行动作：${executionSummary}。`;
  }

  const current = Number(row.current_ecpi) || 0;
  const target = Math.max(Number(row.target_ecpi) || 0, 0.01);
  const deltaRatio = ((current - target) / target) * 100;

  if (row.action === 'increase') {
    return `当前 eCPI 低于目标约 ${Math.abs(deltaRatio).toFixed(0)}%，当前媒体源下获量效率更优，可按 20% 小步放量。`;
  }
  if (row.action === 'decrease') {
    return `当前 eCPI 高于目标约 ${Math.abs(deltaRatio).toFixed(0)}%，继续维持现预算会抬高该媒体源整体获客成本。`;
  }
  if (row.action === 'pause') {
    return '当前成本明显偏高且转化支撑不足，继续投放的边际收益偏低，建议先暂停观察。';
  }
  return '当前信号尚不明确，建议继续观察并在下一日复核。';
}

function cardMarkdown(content: string): { tag: 'lark_md'; content: string } {
  return { tag: 'lark_md', content };
}

function buildWhereClause(filters: DailyBriefFilters): {
  whereSql: string;
  params: Record<string, unknown>;
} {
  const clauses: string[] = [`date = toDate({report_date:String})`];
  const params: Record<string, unknown> = {};

  const appKey = cleanText(filters.appKey);
  const platform = normalizePlatformValue(filters.platform);
  const mediaSources = normalizeMediaSources(filters.mediaSources);

  if (appKey) {
    clauses.push(`app_key = {app_key:String}`);
    params.app_key = appKey;
  }
  if (platform) {
    clauses.push(`platform = {platform:String}`);
    params.platform = platform;
  }
  if (mediaSources.length > 0) {
    clauses.push(`has({media_sources:Array(String)}, media_source)`);
    params.media_sources = mediaSources;
  }

  return {
    whereSql: clauses.join(' AND '),
    params
  };
}

async function queryDistinctMediaSources(reportDate: string, filters: Omit<DailyBriefFilters, 'mediaSources'> = {}): Promise<string[]> {
  const clauses: string[] = [`date = toDate({report_date:String})`];
  const params: Record<string, unknown> = { report_date: reportDate };

  const appKey = cleanText(filters.appKey);
  const platform = normalizePlatformValue(filters.platform);
  if (appKey) {
    clauses.push(`app_key = {app_key:String}`);
    params.app_key = appKey;
  }
  if (platform) {
    clauses.push(`platform = {platform:String}`);
    params.platform = platform;
  }

  const rows = await chQuery<Record<string, unknown>>(
    `SELECT DISTINCT media_source
       FROM pull_aggregate_daily
      WHERE ${clauses.join(' AND ')}
      ORDER BY media_source ASC`,
    params
  );

  return rows.map((row) => String(row.media_source || '').trim()).filter((item) => item.length > 0);
}

async function queryAppMetrics(reportDate: string, filters: DailyBriefFilters): Promise<DailyBriefAppMetrics[]> {
  const where = buildWhereClause(filters);
  const rows = await chQuery<Record<string, unknown>>(
    `SELECT
        app_key,
        platform,
        sum(installs_latest) AS installs,
        sum(clicks_latest) AS clicks,
        sum(total_cost_latest) AS total_cost,
        if(sum(installs_latest) > 0, sum(total_cost_latest) / sum(installs_latest), 0) AS blended_ecpi
      FROM (
        SELECT
          app_key,
          platform,
          country,
          media_source,
          campaign,
          argMax(toFloat64(installs), ingest_time) AS installs_latest,
          argMax(toFloat64(clicks), ingest_time) AS clicks_latest,
          argMax(toFloat64(total_cost), ingest_time) AS total_cost_latest
        FROM pull_aggregate_daily
        WHERE ${where.whereSql}
        GROUP BY app_key, platform, country, media_source, campaign
      )
      GROUP BY app_key, platform
      ORDER BY total_cost DESC, installs DESC, app_key ASC, platform ASC`,
    {
      report_date: reportDate,
      ...where.params
    }
  );

  return rows.map((row) => ({
    app_key: String(row.app_key || ''),
    platform: normalizePlatformValue(String(row.platform || '')) || 'unknown',
    installs: numberValue(row.installs),
    clicks: numberValue(row.clicks),
    total_cost: numberValue(row.total_cost),
    blended_ecpi: numberValue(row.blended_ecpi)
  }));
}

async function queryPendingBudgetHighlights(reportDate: string, filters: DailyBriefFilters): Promise<DailyBriefBudgetHighlight[]> {
  await ensureBudgetRecommendationsSchema();
  const clauses = [`date = $1::date`, `status = 'pending'`, `(action <> 'hold' OR jsonb_array_length(execution_actions) > 0)`];
  const values: unknown[] = [reportDate];

  const appKey = cleanText(filters.appKey);
  const platform = normalizePlatformValue(filters.platform);
  const mediaSources = normalizeMediaSources(filters.mediaSources);

  if (appKey) {
    values.push(appKey);
    clauses.push(`app_key = $${values.length}`);
  }
  if (platform) {
    values.push(platform);
    clauses.push(`platform = $${values.length}`);
  }
  if (mediaSources.length > 0) {
    values.push(mediaSources);
    clauses.push(`media_source = ANY($${values.length}::text[])`);
  } else {
    values.push(ASA_MEDIA_SOURCE);
    clauses.push(`LOWER(TRIM(media_source)) <> $${values.length}`);
  }

  const result = await pgQuery<DailyBriefBudgetHighlight>(
    `SELECT app_key, platform, media_source, keyword, action, change_ratio, current_ecpi, target_ecpi,
            primary_metric, metric_mode, current_roas, af_cohort_roas, local_derived_roas, roas_primary_source, roas_warning_code, roas_deviation_ratio, target_roas, roas_window_from, roas_window_to, roas_data_status,
            confidence, reason_code, llm_summary, execution_actions, scenario_tags
       FROM budget_recommendations
      WHERE ${clauses.join(' AND ')}
      ORDER BY ABS(current_ecpi - target_ecpi) DESC, confidence DESC, updated_at DESC
      LIMIT 60`,
    values
  );
  return result.rows
    .filter((row) => mediaSources.length > 0 || !isAsaMediaSource(row.media_source))
    .filter(isSignificantBudgetHighlight)
    .slice(0, DAILY_BRIEF_BUDGET_MAX_ITEMS);
}

async function queryPendingBudgetCounts(reportDate: string, filters: DailyBriefFilters): Promise<Map<string, number>> {
  const clauses = [`date = $1::date`, `status = 'pending'`];
  const values: unknown[] = [reportDate];

  const appKey = cleanText(filters.appKey);
  const platform = normalizePlatformValue(filters.platform);
  const mediaSources = normalizeMediaSources(filters.mediaSources);
  if (appKey) {
    values.push(appKey);
    clauses.push(`app_key = $${values.length}`);
  }
  if (platform) {
    values.push(platform);
    clauses.push(`platform = $${values.length}`);
  }
  if (mediaSources.length > 0) {
    values.push(mediaSources);
    clauses.push(`media_source = ANY($${values.length}::text[])`);
  } else {
    values.push(ASA_MEDIA_SOURCE);
    clauses.push(`LOWER(TRIM(media_source)) <> $${values.length}`);
  }

  const result = await pgQuery<{ app_key: string; platform: string; total: string }>(
    `SELECT app_key, platform, to_char(count(*), 'FM999999999999999') AS total
       FROM budget_recommendations
      WHERE ${clauses.join(' AND ')}
      GROUP BY app_key, platform`,
    values
  );
  return new Map(result.rows.map((row) => [`${row.app_key}|${normalizePlatformValue(row.platform) || 'unknown'}`, Number(row.total || 0)]));
}

async function queryOpenAlertCounts(filters: DailyBriefFilters): Promise<Map<string, number>> {
  const appKey = cleanText(filters.appKey);
  const platform = normalizePlatformValue(filters.platform);
  if (normalizeMediaSources(filters.mediaSources).length > 0) {
    return new Map();
  }

  const values: unknown[] = [];
  const clauses = [`status = 'open'`];
  if (appKey) {
    values.push(appKey);
    clauses.push(`app_key = $${values.length}`);
  }
  if (platform) {
    values.push(platform);
    clauses.push(`platform = $${values.length}`);
  }
  const result = await pgQuery<{ app_key: string; platform: string; total: string }>(
    `SELECT app_key, platform, to_char(count(*), 'FM999999999999999') AS total
       FROM alerts
      WHERE ${clauses.join(' AND ')}
      GROUP BY app_key, platform`,
    values
  );
  return new Map(
    result.rows.map((row) => [
      `${row.app_key}|${normalizePlatformValue(row.platform) || '__all__'}`,
      Number(row.total || 0)
    ])
  );
}

function resolveRowOpenAlertCount(params: {
  row: Pick<DailyBriefAppMetrics, 'app_key' | 'platform'>;
  openAlertCounts: Map<string, number>;
  platformFiltered: boolean;
}): number {
  const rowPlatform = normalizePlatformValue(params.row.platform) || 'unknown';
  const platformCount = params.openAlertCounts.get(`${params.row.app_key}|${rowPlatform}`) ?? 0;

  if (params.platformFiltered) {
    return platformCount;
  }

  const appWideCount = params.openAlertCounts.get(`${params.row.app_key}|__all__`) ?? 0;
  return rowPlatform === 'unknown' ? platformCount + appWideCount : platformCount;
}

function buildDisplayMaps(apps: AppConfigRecord[]): {
  appByKey: Map<string, AppConfigRecord>;
} {
  return {
    appByKey: new Map(apps.map((app) => [app.app_key, app]))
  };
}

function resolveVisibleProductCount(apps: AppConfigRecord[], filters: DailyBriefFilters): number {
  const appKey = cleanText(filters.appKey);
  const platform = normalizePlatformValue(filters.platform);
  const scopedApps = appKey ? apps.filter((app) => app.app_key === appKey) : apps;
  let total = 0;
  for (const app of scopedApps) {
    if (platform) {
      total += 1;
      continue;
    }

    const hasIos = cleanText(app.ios_pull_app_id).length > 0;
    const hasAndroid = cleanText(app.android_pull_app_id).length > 0;
    total += hasIos && hasAndroid ? 2 : 1;
  }
  return total;
}

function buildFocusProducts(params: {
  appRows: Array<DailyBriefAppMetrics & { display_name: string; open_alerts: number; pending_budget_actions: number }>;
  alertRows: DailyBriefAlertHighlight[];
  summary: DailyBriefPreview['summary'];
}): DailyBriefFocusProduct[] {
  const focusByKey = new Map<string, DailyBriefFocusProduct>();
  const alertByProduct = new Map<string, DailyBriefAlertHighlight[]>();

  for (const alert of params.alertRows) {
    const key = `${alert.app_key}|${normalizePlatformValue(alert.platform) || 'unknown'}`;
    const list = alertByProduct.get(key) || [];
    list.push(alert);
    alertByProduct.set(key, list);
  }

  for (const row of params.appRows) {
    const key = `${row.app_key}|${row.platform}`;
    const productAlerts = (alertByProduct.get(key) || []).sort((left, right) => severityRank(left.severity) - severityRank(right.severity));
    const topAlert = productAlerts[0];
    const overallEcpi = params.summary.blended_ecpi > 0 ? params.summary.blended_ecpi : 0;

    let focus: DailyBriefFocusProduct | null = null;
    if (topAlert) {
      focus = {
        app_key: row.app_key,
        platform: row.platform,
        display_name: row.display_name,
        signal: '风险提示',
        headline: `${topAlert.severity} 异常未恢复`,
        detail: `${metricLabel(topAlert.metric)} 出现明显波动，当前告警 ${row.open_alerts} 条 ｜ 成本 ${formatUsd(row.total_cost)} ｜ eCPI ${formatUsd(row.blended_ecpi)}`,
        sort_rank: topAlert.severity === 'P0' ? 0 : 1,
        total_cost: row.total_cost
      };
    } else if (row.total_cost >= 50 && row.installs <= 0) {
      focus = {
        app_key: row.app_key,
        platform: row.platform,
        display_name: row.display_name,
        signal: '风险提示',
        headline: '有成本无安装',
        detail: `当日成本 ${formatUsd(row.total_cost)}，安装 0，建议优先核对归因链路和投放流量质量。`,
        sort_rank: 2,
        total_cost: row.total_cost
      };
    } else if (overallEcpi > 0 && row.total_cost >= 80 && row.blended_ecpi >= overallEcpi * 1.5) {
      focus = {
        app_key: row.app_key,
        platform: row.platform,
        display_name: row.display_name,
        signal: '风险提示',
        headline: 'eCPI 明显高于整体均线',
        detail: `当前 eCPI ${formatUsd(row.blended_ecpi)}，整体均线 ${formatUsd(overallEcpi)} ｜ 安装 ${row.installs.toFixed(0)} ｜ 成本 ${formatUsd(row.total_cost)}`,
        sort_rank: 3,
        total_cost: row.total_cost
      };
    } else if (overallEcpi > 0 && row.total_cost >= 80 && row.installs >= 5 && row.blended_ecpi <= overallEcpi * 0.65) {
      focus = {
        app_key: row.app_key,
        platform: row.platform,
        display_name: row.display_name,
        signal: '表现亮点',
        headline: 'eCPI 明显优于整体均线',
        detail: `当前 eCPI ${formatUsd(row.blended_ecpi)}，整体均线 ${formatUsd(overallEcpi)} ｜ 安装 ${row.installs.toFixed(0)} ｜ 成本 ${formatUsd(row.total_cost)}`,
        sort_rank: 4,
        total_cost: row.total_cost
      };
    } else if (row.pending_budget_actions >= 3 && row.total_cost >= 50) {
      focus = {
        app_key: row.app_key,
        platform: row.platform,
        display_name: row.display_name,
        signal: '风险提示',
        headline: '待处理执行项较多',
        detail: `当前待处理执行项 ${row.pending_budget_actions} 条 ｜ 成本 ${formatUsd(row.total_cost)} ｜ 安装 ${row.installs.toFixed(0)}`,
        sort_rank: 5,
        total_cost: row.total_cost
      };
    }

    if (focus && !focusByKey.has(key)) {
      focusByKey.set(key, focus);
    }
  }

  return Array.from(focusByKey.values())
    .sort((left, right) => left.sort_rank - right.sort_rank || right.total_cost - left.total_cost || left.display_name.localeCompare(right.display_name))
    .slice(0, 6);
}

function buildAnomalyReminder(params: {
  summary: DailyBriefPreview['summary'];
  alertRows: DailyBriefAlertHighlight[];
  appRows: Array<DailyBriefAppMetrics & { display_name: string; open_alerts: number; pending_budget_actions: number }>;
  focusProducts: DailyBriefFocusProduct[];
  appByKey: Map<string, AppConfigRecord>;
}): string {
  if (params.summary.apps_with_data === 0) {
    return '当日暂无可用 Pull 汇总数据，建议先核对 Pull 链路与 AppsFlyer 返回状态。';
  }
  const topAlert = [...params.alertRows].sort((left, right) => severityRank(left.severity) - severityRank(right.severity))[0];
  if (topAlert) {
    return `${resolveDisplayName(topAlert.app_key, params.appByKey.get(topAlert.app_key)?.display_name)} 出现 ${topAlert.severity} 级 ${metricLabel(topAlert.metric)} 异常，建议优先排查，详细执行项请转到多维表格处理。`;
  }
  const zeroInstallHighSpend = [...params.appRows]
    .filter((row) => row.total_cost >= 50 && row.installs <= 0)
    .sort((left, right) => right.total_cost - left.total_cost)[0];
  if (zeroInstallHighSpend) {
    return `${zeroInstallHighSpend.display_name} 出现“有成本无安装”，优先核对归因与投放流量质量，详细动作请在多维表格查看。`;
  }
  const riskProductCount = params.focusProducts.filter((row) => row.signal === '风险提示').length;
  if (riskProductCount > 0) {
    return `当前有 ${riskProductCount} 个重点关注产品，建议优先处理 ${params.focusProducts[0]?.display_name || '异常产品'}，详细执行信息已下沉到多维表格。`;
  }
  if (params.summary.pending_budget_actions > 0) {
    return `当前没有产品级严重异常，但仍有 ${params.summary.pending_budget_actions} 条待处理执行项，详细动作请在多维表格查看。`;
  }
  return '当前未发现产品级严重异常，建议快速浏览产品概览；详细执行信息请在多维表格处理。';
}

function buildActionItems(params: {
  appRows: Array<DailyBriefAppMetrics & { display_name: string; open_alerts: number; pending_budget_actions: number }>;
  budgetHighlights: DailyBriefBudgetHighlight[];
  alertRows: DailyBriefAlertHighlight[];
  appByKey: Map<string, AppConfigRecord>;
  summary: DailyBriefPreview['summary'];
}): DailyBriefActionItem[] {
  const items: DailyBriefActionItem[] = [];

  const alertCandidates = [...params.alertRows].sort((a, b) => severityRank(a.severity) - severityRank(b.severity));
  for (const row of alertCandidates.slice(0, 3)) {
    const app = params.appByKey.get(row.app_key);
    const appName = resolveDisplayName(row.app_key, app?.display_name);
    items.push({
      priority: row.severity === 'P0' ? 'P0' : 'P1',
      category: 'alert',
      title: `${appName} 存在 ${row.severity} 异常，优先排查 ${metricLabel(row.metric)}`,
      detail: `先检查 AppsFlyer 归因、投放变更和事件上报链路；当前偏差 ${row.delta_value.toFixed(2)}，原因摘要：${trimSentence(row.explanation, 72) || '暂无解释'}`
    });
  }

  for (const row of params.budgetHighlights.slice(0, 4)) {
    const app = params.appByKey.get(row.app_key);
    const appName = resolveProductViewName(app, row.platform);
    const action = actionLabel(row.action);
    const actionSummary = formatBudgetActionSummary(row);
    const executionSummary = formatExecutionActionSummary(row);
    const metricSummary = formatBudgetMetricStatus(row);
    items.push({
      priority: row.action === 'pause' ? 'P0' : 'P2',
      category: 'budget',
      title: executionSummary
        ? `${appName} / ${row.media_source} 建议${action}预算并执行「${executionSummary}」`
        : `${appName} / ${row.media_source} 建议${actionSummary}`,
      detail: `广告系列 ${row.keyword} ${metricSummary}，置信度 ${(row.confidence * 100).toFixed(0)}%。${row.reason_summary || buildBudgetAdjustmentReason(row)}`
    });
  }

  const zeroInstallHighSpend = params.appRows
    .filter((row) => row.total_cost >= 50 && row.installs <= 0)
    .sort((a, b) => b.total_cost - a.total_cost)
    .slice(0, 2);
  for (const row of zeroInstallHighSpend) {
    items.push({
      priority: 'P1',
      category: 'data',
      title: `${row.display_name} 出现“有成本无安装”`,
      detail: `当日成本 ${formatUsd(row.total_cost)}，安装 0。建议核对 Pull 回传、AppsFlyer 数据窗口和投放侧是否存在未归因或上报延迟。`
    });
  }

  if (items.length === 0) {
    items.push({
      priority: 'P2',
      category: 'data',
      title: '当前未发现需要立即处理的异常动作',
      detail: `当日未恢复告警 ${params.summary.open_alerts} 条，待处理预算建议 ${params.summary.pending_budget_actions} 条。建议按常规节奏复核高花费产品与新增广告系列表现。`
    });
  }

  return items.slice(0, 6);
}

function buildTodayJudgment(summary: DailyBriefPreview['summary']): string {
  if (summary.open_alerts > 0) {
    return '当前仍有未恢复异常，建议先处理高优先级告警，再执行预算动作。';
  }
  if (summary.pending_budget_actions > 0) {
    return '数据链路整体稳定，今日重点放在预算建议执行与效果复核。';
  }
  if (summary.apps_with_data === 0) {
    return '当日暂无可用 Pull 汇总数据，建议先核对 Pull 链路与 AppsFlyer 返回状态。';
  }
  return '当日未发现高优先级异常，建议继续观察高花费产品与新增广告系列表现。';
}

function buildDailyBriefInteractiveCard(params: {
  reportDate: string;
  title: string;
  summary: DailyBriefPreview['summary'];
  appRows: Array<DailyBriefAppMetrics & { display_name: string; open_alerts: number; pending_budget_actions: number }>;
  focusProducts: DailyBriefFocusProduct[];
	  anomalyReminder: string;
	  existingSentAt?: string | null;
	  filters: DailyBriefPreview['filters'];
	  officialSnapshot: AfOfficialBatchSnapshot;
	}): FeishuCardPayload {
  const appOverview =
    params.appRows.length > 0
      ? params.appRows
          .slice(0, 8)
          .map(
            (row) =>
              `• **${row.display_name}**\n安装 ${row.installs.toFixed(0)} ｜ 成本 ${formatUsd(row.total_cost)} ｜ eCPI ${formatUsd(row.blended_ecpi)} ｜ 异常 ${row.open_alerts} ｜ 待处理 ${row.pending_budget_actions}`
          )
          .join('\n')
      : '• 当前日期暂无 Pull 汇总数据。';

  const focusOverview =
    params.focusProducts.length > 0
      ? params.focusProducts
          .map((row) => `• **${row.display_name}｜${row.signal}**\n${row.headline}\n${row.detail}`)
          .join('\n\n')
      : '当前没有需要额外标记的重点关注产品。';

  const filterNote =
    params.filters.media_sources.length > 0
      ? `媒体源过滤：${params.filters.media_sources.join('、')}`
      : '媒体源过滤：全部';

	  const elements: Array<Record<string, unknown>> = [
	    {
	      tag: 'div',
	      text: cardMarkdown(`📅 **报告日期**\n${params.reportDate}\n官方快照：${params.officialSnapshot.snapshot_id}（${params.officialSnapshot.status}，组件 ${params.officialSnapshot.snapshot_count} 个）\n${filterNote}\n详细执行信息请查看非 ASA / ASA 专属多维表格。`)
	    },
    { tag: 'hr' },
    { tag: 'div', text: cardMarkdown(`⚠️ **异常提醒**\n${params.anomalyReminder}`) },
    { tag: 'hr' },
    { tag: 'div', text: cardMarkdown(`📦 **产品概览**\n${appOverview}`) },
    { tag: 'hr' },
    { tag: 'div', text: cardMarkdown(`🎯 **重点关注产品**\n${focusOverview}`) }
  ];

  if (params.existingSentAt) {
    elements.push({ tag: 'hr' });
    elements.push({
      tag: 'note',
      elements: [cardMarkdown(`📝 已于 ${new Date(params.existingSentAt).toLocaleString()} 发送过一次`)]
    });
  }

  return {
    config: {
      wide_screen_mode: true,
      enable_forward: true
    },
    header: {
      template: params.summary.open_alerts > 0 ? 'orange' : 'blue',
      title: {
        tag: 'plain_text',
        content: `📊 ${params.title}`
      }
    },
    elements
  };
}

export async function buildDailyBriefPreview(
  reportDate = getDailyBriefDefaultReportDate(),
  filters: DailyBriefFilters = {},
  options?: { routeKey?: string }
): Promise<DailyBriefPreview> {
  const mediaSourcesApplied = normalizeMediaSources(filters.mediaSources);
  const routes = await listEnabledDailyBriefRoutes();
  const routeKey = resolveDailyBriefDispatchRouteKey(filters, routes, options?.routeKey);
  const [apps, appMetrics, openAlertCounts, pendingBudgetCounts, budgetHighlights, existingDispatch, availableMediaSources] =
    await Promise.all([
      listApps(),
      queryAppMetrics(reportDate, filters),
      queryOpenAlertCounts(filters),
      queryPendingBudgetCounts(reportDate, filters),
      queryPendingBudgetHighlights(reportDate, filters),
      getDailyBriefDispatch(reportDate, 'ops_daily', 'feishu', routeKey),
      queryDistinctMediaSources(reportDate, {
        appKey: filters.appKey,
        platform: filters.platform
      })
    ]);

  const normalizedPlatform = normalizePlatformValue(filters.platform);
  const alertHighlights =
    mediaSourcesApplied.length > 0
      ? []
      : await listAlerts({
          status: 'open',
          limit: 5,
          appKey: cleanText(filters.appKey) || undefined,
          platform: normalizedPlatform || undefined
        }).then((rows) =>
          rows.map((row) => ({
            app_key: row.app_key,
            platform: row.platform,
            severity: row.severity,
            metric: row.metric,
            delta_value: row.delta_value,
            status: row.status,
            explanation: row.explanation
          }))
        );

  const { appByKey } = buildDisplayMaps(apps);
  const appRows = appMetrics.map((row) => ({
    ...row,
    display_name: resolveProductViewName(appByKey.get(row.app_key), row.platform),
    open_alerts:
      mediaSourcesApplied.length > 0
        ? 0
        : resolveRowOpenAlertCount({
            row,
            openAlertCounts,
            platformFiltered: Boolean(normalizedPlatform)
          }),
    pending_budget_actions: pendingBudgetCounts.get(`${row.app_key}|${row.platform}`) ?? 0
  }));

  const summary = {
    app_count: resolveVisibleProductCount(apps, filters),
    apps_with_data: appRows.length,
    total_installs: appRows.reduce((sum, row) => sum + row.installs, 0),
    total_clicks: appRows.reduce((sum, row) => sum + row.clicks, 0),
    total_cost: appRows.reduce((sum, row) => sum + row.total_cost, 0),
    blended_ecpi: 0,
    open_alerts:
      mediaSourcesApplied.length > 0
        ? 0
        : Array.from(openAlertCounts.values()).reduce((sum, value) => sum + value, 0),
    pending_budget_actions: Array.from(pendingBudgetCounts.values()).reduce((sum, value) => sum + value, 0)
  };
  summary.blended_ecpi = summary.total_installs > 0 ? summary.total_cost / summary.total_installs : 0;

  const officialBudgetMetrics = await queryAfDashboardDailyCampaignMetrics({
    reportDate,
    appKey: filters.appKey,
    platform: filters.platform,
    campaigns: budgetHighlights.map((row) => row.keyword)
  });

  const normalizedBudgetHighlights = budgetHighlights.map((row) => ({
    ...row,
    official_dashboard:
      officialBudgetMetrics.get(
        afDashboardCampaignKey({
          appKey: row.app_key,
          platform: row.platform,
          campaign: row.keyword
        })
      ) || null,
    reason_summary: buildBudgetAdjustmentReason(row)
  }));

  const actionItems = buildActionItems({
    appRows,
    budgetHighlights: normalizedBudgetHighlights,
    alertRows: alertHighlights,
    appByKey,
    summary
  });
  const focusProducts = buildFocusProducts({
    appRows,
    alertRows: alertHighlights,
    summary
  });
	  const todayJudgment = buildAnomalyReminder({
	    summary,
	    alertRows: alertHighlights,
	    appRows,
	    focusProducts,
	    appByKey
	  });
	  const metricScope = buildAfMetricScopeMeta({
	    metricScope: 'daily_push_d1',
	    sourceSurface: 'daily_report',
	    windowFrom: reportDate,
	    windowTo: reportDate,
	    timezone: env.timezone,
	    currency: 'preferred'
	  });
	  const officialSnapshot = await buildAfOfficialBatchSnapshot({
	    metricScope: 'daily_push_d1',
	    sourceSurface: 'daily_report',
	    windowFrom: reportDate,
	    windowTo: reportDate,
	    timezone: env.timezone,
	    currency: 'preferred',
	    appKey: filters.appKey,
	    platform: filters.platform,
	    expectedComponents: buildDailyReportExpectedComponents(apps, {
	      from: reportDate,
	      to: reportDate,
	      appKey: filters.appKey,
	      platform: filters.platform
	    })
	  });
	  const title = `${env.dailyBriefTitlePrefix}｜${reportDate}`;
	  const cardPayload = buildDailyBriefInteractiveCard({
	    reportDate,
	    title,
    summary,
    appRows,
    focusProducts,
    anomalyReminder: todayJudgment,
    existingSentAt: existingDispatch?.status === 'sent' ? existingDispatch.sent_at : null,
	    filters: {
	      app_key: cleanText(filters.appKey) || null,
	      platform: normalizePlatformValue(filters.platform) || null,
	      media_sources: mediaSourcesApplied
	    },
	    officialSnapshot
	  });

	  const lines: string[] = [];
	  lines.push(`报告日期：${reportDate}`);
	  lines.push(`官方快照：${officialSnapshot.snapshot_id}（${officialSnapshot.status}，组件 ${officialSnapshot.snapshot_count} 个）`);
	  if (mediaSourcesApplied.length > 0) {
	    lines.push(`媒体源过滤：${mediaSourcesApplied.join('、')}`);
	  }
  lines.push('');
  lines.push('【异常提醒】');
  lines.push(`- ${todayJudgment}`);

  lines.push('');
  lines.push('【产品概览】');
  if (appRows.length > 0) {
    for (const row of appRows.slice(0, 8)) {
      lines.push(
        `- ${row.display_name}：媒体源 ${mediaSourcesApplied.length > 0 ? mediaSourcesApplied.join('、') : '全部'}；安装 ${row.installs.toFixed(0)}，点击 ${row.clicks.toFixed(0)}，成本 ${formatUsd(row.total_cost)}，eCPI ${formatUsd(row.blended_ecpi)}，未恢复告警 ${row.open_alerts}，待处理预算 ${row.pending_budget_actions}`
      );
    }
  } else {
    lines.push('- 当前日期暂无 Pull 汇总数据。');
  }

  lines.push('');
  lines.push('【重点关注产品】');
  if (focusProducts.length > 0) {
    for (const row of focusProducts) {
      lines.push(`- ${row.display_name}｜${row.signal}：${row.headline}。${row.detail}`);
    }
  } else {
    lines.push('- 当前没有需要额外标记的重点关注产品。');
  }

  lines.push('');
  lines.push('【执行信息】');
  lines.push('- 详细执行动作、关键词级建议、执行状态与人工反馈已统一下沉到非 ASA / ASA 专属多维表格。');

  if (existingDispatch?.status === 'sent' && existingDispatch.sent_at) {
    lines.push('');
    lines.push('【发送记录】');
    lines.push(`- 该口径日报已在 ${new Date(existingDispatch.sent_at).toLocaleString()} 发送过一次。`);
  }

  return {
	    report_date: reportDate,
	    title,
	    text: lines.join('\n'),
	    metric_scope: metricScope,
	    official_snapshot: officialSnapshot,
	    today_judgment: todayJudgment,
    anomaly_reminder: todayJudgment,
    render_mode: 'interactive',
    feishu_card_payload: cardPayload,
    summary,
    filters: {
      app_key: cleanText(filters.appKey) || null,
      platform: normalizePlatformValue(filters.platform) || null,
      media_sources: mediaSourcesApplied
    },
    media_sources_applied: mediaSourcesApplied.length > 0 ? mediaSourcesApplied : availableMediaSources,
    app_rows: appRows,
    apps: appRows,
    budget_highlights: normalizedBudgetHighlights,
    alert_highlights: alertHighlights,
    action_items: actionItems,
    focus_products: focusProducts
  };
}

async function sendSingleDailyBrief(
  reportDate: string,
  filters: DailyBriefFilters,
  routeKey: string,
  channelOverride?: {
    notify_feishu_app_id?: string | null;
    notify_feishu_app_secret?: string | null;
    notify_feishu_chat_id?: string | null;
  },
  options?: { force?: boolean; manualTriggered?: boolean }
): Promise<DailyBriefSendResult> {
  const preview = await buildDailyBriefPreview(reportDate, filters, { routeKey });
  const lockOwnerId = crypto.randomUUID();
  const lockName = buildDailyBriefSendLockName(reportDate, routeKey, filters);
  const lockAcquired = await tryAcquireJobLock(lockName, lockOwnerId, DAILY_BRIEF_SEND_LOCK_TTL_MS);
  if (!lockAcquired) {
    return {
      ok: true,
      skipped: true,
      report: preview,
      notify: { ok: true, status: 200, render_mode: 'interactive' }
    };
  }
  try {
    const existing = await getDailyBriefDispatch(reportDate, 'ops_daily', 'feishu', routeKey);
    if (existing?.status === 'sent' && !options?.force) {
      return {
        ok: true,
        skipped: true,
        report: preview,
        notify: { ok: true, status: 200, render_mode: 'interactive' },
        dispatch: existing
      };
    }

    const cardNotify = await sendFeishuInteractiveCardNotification(
      {
        title: preview.title,
        text: preview.text,
        feishuCardPayload: preview.feishu_card_payload,
	        extra: {
	          report_date: preview.report_date,
	          report_type: 'daily_brief',
	          route_key: routeKey,
	          snapshot_id: preview.official_snapshot.snapshot_id,
	          metric_scope: preview.metric_scope.metric_scope
	        }
      },
      channelOverride
    );
    const notify = cardNotify.ok
      ? cardNotify
      : await sendAlertNotification(
          {
            title: preview.title,
            text: preview.text,
	            extra: {
	              report_date: preview.report_date,
	              report_type: 'daily_brief',
	              route_key: routeKey,
	              snapshot_id: preview.official_snapshot.snapshot_id,
	              metric_scope: preview.metric_scope.metric_scope
	            }
          },
          channelOverride
        );
    if (!cardNotify.ok && notify.ok) {
      notify.render_mode = 'text_fallback';
    }

    const dispatch = await upsertDailyBriefDispatch({
      report_date: reportDate,
      route_key: routeKey,
      title: preview.title,
      content: preview.text,
      payload_json: preview,
      status: notify.ok ? 'sent' : 'failed',
      manual_triggered: options?.manualTriggered ?? false,
      last_error: notify.ok ? null : notify.error ?? `status_${String(notify.status ?? 'unknown')}`,
      sent_at: notify.ok ? new Date().toISOString() : null
    });

    return {
      ok: notify.ok,
      skipped: false,
      report: preview,
      notify,
      dispatch
    };
  } finally {
    await releaseJobLock(lockName, lockOwnerId);
  }
}

export async function sendDailyBrief(
  reportDate = getDailyBriefDefaultReportDate(),
  options?: {
    force?: boolean;
    manualTriggered?: boolean;
    filters?: DailyBriefFilters;
    routeKey?: string;
    channelOverride?: {
      notify_feishu_app_id?: string | null;
      notify_feishu_app_secret?: string | null;
      notify_feishu_chat_id?: string | null;
    };
  }
): Promise<DailyBriefSendResult> {
  const filters = options?.filters ?? {};
  const routes = await listEnabledDailyBriefRoutes();
  const routeKey = resolveDailyBriefDispatchRouteKey(filters, routes, options?.routeKey);
  return sendSingleDailyBrief(reportDate, filters, routeKey, options?.channelOverride, options);
}

export async function listDailyBriefMediaSources(
  reportDate = getDailyBriefDefaultReportDate(),
  filters: Omit<DailyBriefFilters, 'mediaSources'> = {}
): Promise<string[]> {
  return queryDistinctMediaSources(reportDate, filters);
}

function buildRouteFilters(route: DailyBriefRouteRecord): DailyBriefFilters {
  return {
    appKey: route.app_key ?? undefined,
    platform: route.platform ?? undefined,
    mediaSources: Array.isArray(route.media_sources) ? route.media_sources : []
  };
}

export async function runScheduledDailyBrief(logger: LoggerLike): Promise<ScheduledDailyBriefRunSummary> {
  if (!env.dailyBriefEnabled) {
    logger.info('daily_brief_disabled');
    return {
      completed: true,
      report_date: null,
      sent_count: 0,
      failed_count: 0,
      skipped_count: 1
    };
  }

  const schedule = await getPushScheduleTarget();
  const currentParts = getTzParts(new Date(), env.timezone);
  const beforeWindow =
    currentParts.hour < schedule.hour ||
    (currentParts.hour === schedule.hour && currentParts.minute < schedule.minute);

  if (beforeWindow) {
    logger.info('daily_brief_skip_before_window', {
      current_hour: currentParts.hour,
      current_minute: currentParts.minute,
      report_time: schedule.time
    });
    return {
      completed: true,
      report_date: null,
      sent_count: 0,
      failed_count: 0,
      skipped_count: 1
    };
  }

  const reportDate = getDailyBriefDefaultReportDate(new Date(), env.timezone);
  const routes = await listEnabledDailyBriefRoutes();
  let sentCount = 0;
  let failedCount = 0;
  let skippedCount = 0;

  if (routes.length === 0) {
    const preview = await buildDailyBriefPreview(reportDate);
    if (preview.summary.apps_with_data === 0) {
      logger.info('daily_brief_skip_no_data', {
        report_date: reportDate,
        route_key: 'all'
      });
      return {
        completed: true,
        report_date: reportDate,
        sent_count: 0,
        failed_count: 0,
        skipped_count: 1
      };
    }

    const existing = await getDailyBriefDispatch(reportDate, 'ops_daily', 'feishu', 'all');
    if (existing?.status === 'sent') {
      logger.info('daily_brief_skip_already_sent', {
        report_date: reportDate,
        route_key: 'all',
        sent_at: existing.sent_at
      });
      return {
        completed: true,
        report_date: reportDate,
        sent_count: 0,
        failed_count: 0,
        skipped_count: 1
      };
    }

    const result = await sendDailyBrief(reportDate, {
      force: false,
      manualTriggered: false,
      routeKey: 'all'
    });
    if (result.ok) {
      logger.info('daily_brief_sent', {
        report_date: reportDate,
        route_key: 'all',
        render_mode: result.notify.render_mode || result.report.render_mode
      });
      return {
        completed: true,
        report_date: reportDate,
        sent_count: 1,
        failed_count: 0,
        skipped_count: 0
      };
    }
    logger.error('daily_brief_send_failed', {
      report_date: reportDate,
      route_key: 'all',
      error: result.notify.error ?? `status_${String(result.notify.status ?? 'unknown')}`
    });
    return {
      completed: false,
      report_date: reportDate,
      sent_count: 0,
      failed_count: 1,
      skipped_count: 0
    };
  }

  for (const route of routes) {
    const routeKey = `route:${route.id}`;
    const filters = buildRouteFilters(route);
    const preview = await buildDailyBriefPreview(reportDate, filters, { routeKey });
    if (preview.summary.apps_with_data === 0) {
      logger.info('daily_brief_route_skip_no_data', {
        report_date: reportDate,
        route_key: routeKey,
        route_name: route.route_name
      });
      skippedCount += 1;
      continue;
    }

    const existing = await getDailyBriefDispatch(reportDate, 'ops_daily', 'feishu', routeKey);
    if (existing?.status === 'sent') {
      logger.info('daily_brief_route_skip_already_sent', {
        report_date: reportDate,
        route_key: routeKey,
        route_name: route.route_name
      });
      skippedCount += 1;
      continue;
    }

    const result = await sendDailyBrief(reportDate, {
      force: false,
      manualTriggered: false,
      filters,
      routeKey,
      channelOverride: {
        notify_feishu_app_id: route.notify_feishu_app_id,
        notify_feishu_app_secret: route.notify_feishu_app_secret,
        notify_feishu_chat_id: route.notify_feishu_chat_id
      }
    });

    if (result.ok) {
      sentCount += 1;
      logger.info('daily_brief_route_sent', {
        report_date: reportDate,
        route_key: routeKey,
        route_name: route.route_name,
        media_sources: route.media_sources
      });
    } else {
      failedCount += 1;
      logger.error('daily_brief_route_send_failed', {
        report_date: reportDate,
        route_key: routeKey,
        route_name: route.route_name,
        error: result.notify.error ?? `status_${String(result.notify.status ?? 'unknown')}`
      });
    }
  }

  return {
    completed: failedCount === 0,
    report_date: reportDate,
    sent_count: sentCount,
    failed_count: failedCount,
    skipped_count: skippedCount
  };
}
