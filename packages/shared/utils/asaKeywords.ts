import crypto from 'crypto';
import { env } from '../config/env.js';
import { chExec, chInsertJSON, chQuery } from './clickhouse.js';
import { md5Hex } from './hash.js';
import { explainBudgetRecommendationWithLlm } from './llm.js';
import {
  getDailyBriefDispatch,
  ensureAsaKeywordRoasSchema,
  insertLlmAuditLog,
  listApps,
  listEnabledAsaKeywordRoutes,
  listRecommendationPolicyConfigs,
  listProductStageConfigs,
  queryAsaKeywordRecommendations,
  queryAsaKeywordStates,
  releaseJobLock,
  deleteStaleAsaKeywordRecommendations,
  deleteStaleAsaKeywordStates,
  replaceAsaKeywordRecommendationsForDate,
  tryAcquireJobLock,
  upsertAsaKeywordRecommendation,
  upsertAsaKeywordState,
  upsertDailyBriefDispatch
} from './repositories.js';
import { pgQuery } from './postgres.js';
import { sendAlertNotification, sendFeishuInteractiveCardNotification, type AlertChannelConfig } from './notifier.js';
import { resolveProductViewName } from './displayName.js';
import { getDailyBriefDefaultReportDate } from './dailyBrief.js';
import { getPushScheduleTarget } from './runtimeSchedule.js';
import { getTzParts } from './schedule.js';
import { buildPreviousDateList, shiftDateString } from './businessDate.js';
import { buildMatureRoasWindow, isRoasDataUsableStatus, resolveRoasDataStatus } from './roasWindow.js';
import {
  buildRecommendationPolicyKey,
  buildRecommendationPolicyMap,
  defaultRecommendationPolicyRule,
  evaluateSpendScenarios,
  evaluateRelativeCompareMetrics,
  normalizeRecommendationPolicyRule,
  resolveRecommendationTarget
} from './recommendationPolicies.js';
import {
  AppsflyerRequestError,
  fetchAppsflyerText,
  type AppsflyerRequestFailureKind
} from './appsflyerRequest.js';
import type {
  AppConfigRecord,
  AsaKeywordRecommendationRow,
  AsaKeywordRouteRecord,
  AsaKeywordStateRow,
  ProductStage,
  RecommendationPolicyRuleJson,
  RoasDataStatus
} from '../types/models.js';

interface LoggerLike {
  info?: (message: string, meta?: Record<string, unknown>) => void;
  warn?: (message: string, meta?: Record<string, unknown>) => void;
  error?: (message: string, meta?: Record<string, unknown>) => void;
}

interface CsvRow {
  [key: string]: string;
}

interface AsaInstallRow {
  install_date: string;
  install_time: string;
  ingest_time: string;
  app_key: string;
  platform: string;
  keyword: string;
  campaign: string;
  adset: string;
  country: string;
  cost_value: number;
  currency: string;
  snapshot_id: number;
  event_uid: string;
  raw_json: string;
}

interface AsaMasterMetricRow {
  date: string;
  app_key: string;
  platform: string;
  keyword: string;
  campaign: string;
  adset: string;
  installs: number;
  total_cost: number;
  average_ecpi: number;
}

interface AsaInAppEventRow {
  install_date: string;
  install_time: string;
  event_time: string;
  ingest_time: string;
  app_key: string;
  platform: string;
  keyword: string;
  campaign: string;
  adset: string;
  country: string;
  event_name: string;
  event_revenue_usd: number;
  cost_value: number;
  currency: string;
  snapshot_id: number;
  event_uid: string;
  raw_json: string;
}

interface AsaKeywordDailyMetricInsertRow {
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
  snapshot_id: number;
  version: number;
}

interface AsaCohortMetricRow {
  date: string;
  app_key: string;
  platform: string;
  keyword: string;
  campaign: string;
  adset: string;
  purchase_count: number;
  revenue_d7: number;
  d7_roas: number;
  source_complete: boolean;
}

interface AsaKeywordCountryMetricInsertRow {
  date: string;
  app_key: string;
  platform: string;
  country: string;
  keyword: string;
  campaign: string;
  adset: string;
  installs: number;
  total_cost: number;
  ecpi: number;
  snapshot_id: number;
  version: number;
}

interface AsaKeywordAccumulator {
  date: string;
  app_key: string;
  platform: string;
  keyword: string;
  campaign: string;
  adset: string;
  raw_installs: number;
  master_installs: number;
  total_cost: number;
  purchase_count: number;
  revenue_d0: number;
  revenue_d7: number;
  d7_roas: number;
  roas_source_complete: boolean;
  average_ecpi: number;
}

interface AsaKeywordDashboardRow extends AsaKeywordStateRow {
  recommendation_id: number | null;
  recommendation_action: string | null;
  recommendation_status: string | null;
  primary_metric: string | null;
  llm_summary: unknown;
}

interface AsaKeywordSummary {
  keyword_count: number;
  installs: number;
  total_cost: number;
  purchase_count: number;
  revenue_d7: number;
  ecpi: number;
  cpp: number;
  d7_roas: number;
  roas_data_status: RoasDataStatus;
  roas_window_from: string | null;
  roas_window_to: string | null;
}

export interface AsaKeywordQueryFilter {
  appKey?: string;
  platform?: string;
  stage?: ProductStage;
  keyword?: string;
  campaign?: string;
  from?: string;
  to?: string;
  page?: number;
  pageSize?: number;
}

export interface AsaKeywordQueryResult {
  rows: AsaKeywordDashboardRow[];
  summary: AsaKeywordSummary;
  summary_window: { from: string; to: string } | null;
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

interface AsaBriefFilters {
  reportDate: string;
  appKey?: string;
  platform?: string;
}

export interface AsaBriefPreview {
  report_date: string;
  title: string;
  summary: AsaKeywordSummary;
  summary_window: {
    from: string;
    to: string;
  };
  current_stage: ProductStage | 'mixed';
  today_judgment: string;
  rows: AsaKeywordDashboardRow[];
  action_rows: AsaKeywordRecommendationRow[];
  text: string;
  feishu_card_payload: Record<string, unknown>;
}

export interface AsaCycleResult {
  started_at: string;
  ended_at: string;
  duration_ms: number;
  backfill_days: number;
  install_rows: number;
  event_rows: number;
  metric_rows: number;
  state_rows: number;
  recommendation_rows: number;
  app_targets: number;
  failed_slice_count: number;
  retryable_failed_slice_count: number;
  terminal_failed_slice_count: number;
  recovered_slice_count: number;
}

export interface ScheduledAsaKeywordBriefRunSummary {
  completed: boolean;
  report_date: string | null;
  sent_count: number;
  failed_count: number;
  skipped_count: number;
}

function buildAsaSummaryFilter(filter: AsaKeywordQueryFilter): {
  rangeFrom: string;
  rangeTo: string;
  query: string;
  params: Record<string, unknown>;
} {
  const rangeFrom = filter.from ?? '1970-01-01';
  const rangeTo = filter.to ?? '2099-12-31';
  const summaryWhere: string[] = [];
  const summaryParams: Record<string, unknown> = {
    from: rangeFrom,
    to: rangeTo
  };
  if (filter.appKey) {
    summaryWhere.push('m.app_key = {appKey:String}');
    summaryParams.appKey = filter.appKey;
  }
  if (filter.platform) {
    summaryWhere.push('m.platform = {platform:String}');
    summaryParams.platform = filter.platform;
  }
  if (filter.from) {
    summaryWhere.push('m.date >= toDate({from:String})');
  }
  if (filter.to) {
    summaryWhere.push('m.date <= toDate({to:String})');
  }
  if (filter.keyword) {
    summaryWhere.push('positionCaseInsensitive(m.keyword, {keyword:String}) > 0');
    summaryParams.keyword = filter.keyword;
  }
  if (filter.campaign) {
    summaryWhere.push('positionCaseInsensitive(m.campaign, {campaign:String}) > 0');
    summaryParams.campaign = filter.campaign;
  }
  return {
    rangeFrom,
    rangeTo,
    query: summaryWhere.length ? `WHERE ${summaryWhere.join(' AND ')}` : '',
    params: summaryParams
  };
}

async function queryAsaKeywordSummary(filter: AsaKeywordQueryFilter): Promise<AsaKeywordSummary> {
  await ensureAsaKeywordMetricsSchema();
  const summaryFilter = buildAsaSummaryFilter(filter);
  const summaryRows = await chQuery<AsaKeywordSummary>(
    `WITH
      ${buildLatestAsaSliceRangeCtes(ASA_KEYWORD_METRICS_TABLE, 'date')}
      SELECT
        keyword_count,
        installs_sum AS installs,
        total_cost_sum AS total_cost,
        covered_purchase_count_sum AS purchase_count,
        covered_revenue_d7_sum AS revenue_d7,
        if(installs_sum > 0, total_cost_sum / installs_sum, 0) AS ecpi,
        if(covered_purchase_count_sum > 0, covered_roas_cost_sum / covered_purchase_count_sum, 0) AS cpp,
        if(covered_roas_cost_sum > 0, covered_weighted_roas_cost_sum / covered_roas_cost_sum, 0) AS d7_roas,
        spend_row_count,
        covered_roas_cost_sum,
        missing_roas_cost_sum
      FROM (
        SELECT
          countDistinct(keyword, campaign, adset, platform, app_key) AS keyword_count,
          sum(installs) AS installs_sum,
          sum(total_cost) AS total_cost_sum,
          sumIf(total_cost, total_cost > 0 AND roas_source_missing != 1) AS covered_roas_cost_sum,
          sumIf(total_cost, total_cost > 0 AND roas_source_missing = 1) AS missing_roas_cost_sum,
          sumIf(purchase_count, total_cost > 0 AND roas_source_missing != 1) AS covered_purchase_count_sum,
          sumIf(revenue_d7, total_cost > 0 AND roas_source_missing != 1) AS covered_revenue_d7_sum,
          sumIf(d7_roas * total_cost, total_cost > 0 AND roas_source_missing != 1) AS covered_weighted_roas_cost_sum,
          countIf(total_cost > 0) AS spend_row_count,
          countIf(total_cost > 0 AND roas_source_missing = 1) AS missing_roas_row_count
        FROM (
          SELECT *
          FROM ${ASA_KEYWORD_METRICS_TABLE} FINAL
        ) AS m
        INNER JOIN latest_slices AS s
          ON s.app_key = m.app_key
         AND s.platform = m.platform
         AND s.date = m.date
         AND s.snapshot_id = m.snapshot_id
        ${summaryFilter.query}
      )`,
    summaryFilter.params
  );
  const rawSummary = summaryRows[0] as (AsaKeywordSummary & {
    spend_row_count?: number;
    covered_roas_cost_sum?: number;
    missing_roas_cost_sum?: number;
  }) | undefined;
  const fallback: AsaKeywordSummary = {
      keyword_count: 0,
      installs: 0,
      total_cost: 0,
      purchase_count: 0,
      revenue_d7: 0,
      ecpi: 0,
      cpp: 0,
      d7_roas: 0,
      roas_data_status: 'unavailable',
      roas_window_from: filter.from ?? null,
      roas_window_to: filter.to ?? null
    };
  if (!rawSummary) {
    return fallback;
  }
  const roasDataStatus = resolveRoasDataStatus({
    hasWindowRows: Number(rawSummary.keyword_count || 0) > 0,
    hasSpend: Number(rawSummary.total_cost || 0) > 0 || Number(rawSummary.spend_row_count || 0) > 0,
    coveredCost: Number(rawSummary.covered_roas_cost_sum || 0),
    missingCost: Number(rawSummary.missing_roas_cost_sum || 0)
  });
  return {
    keyword_count: Number(rawSummary.keyword_count || 0),
    installs: Number(rawSummary.installs || 0),
    total_cost: Number(rawSummary.total_cost || 0),
    purchase_count: isRoasDataUsableStatus(roasDataStatus) ? Number(rawSummary.purchase_count || 0) : 0,
    revenue_d7: isRoasDataUsableStatus(roasDataStatus) ? Number(rawSummary.revenue_d7 || 0) : 0,
    ecpi: Number(rawSummary.ecpi || 0),
    cpp: isRoasDataUsableStatus(roasDataStatus) ? Number(rawSummary.cpp || 0) : 0,
    d7_roas: isRoasDataUsableStatus(roasDataStatus) ? Number(rawSummary.d7_roas || 0) : 0,
    roas_data_status: roasDataStatus,
    roas_window_from: filter.from ?? null,
    roas_window_to: filter.to ?? null
  };
}

const RAW_MEDIA_SOURCE = 'apple search ads';
const MASTER_MEDIA_SOURCE = 'apple search ads';
const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const ASA_KEYWORD_METRICS_TABLE = 'asa_keyword_daily_metrics_v2';
const ASA_KEYWORD_COUNTRY_METRICS_TABLE = 'asa_keyword_country_daily_metrics';
const ASA_SLICE_SNAPSHOT_TABLE = 'asa_slice_snapshots';
const ASA_KEYWORD_BRIEF_SEND_LOCK_PREFIX = 'asa_keyword_brief:send';
const ASA_KEYWORD_BRIEF_SEND_LOCK_TTL_MS = 30 * 60 * 1000;
const ASA_FETCH_REVIEW_RETRY_DELAY_MS = 30 * 1000;
let ensureAsaKeywordMetricsSchemaPromise: Promise<void> | null = null;

async function ensureAsaKeywordMetricsSchema(): Promise<void> {
  if (!ensureAsaKeywordMetricsSchemaPromise) {
    ensureAsaKeywordMetricsSchemaPromise = chExec(
      `ALTER TABLE ${ASA_KEYWORD_METRICS_TABLE}
        ADD COLUMN IF NOT EXISTS roas_source_missing UInt8 DEFAULT 0`
    ).catch((error) => {
      ensureAsaKeywordMetricsSchemaPromise = null;
      throw error;
    });
  }
  await ensureAsaKeywordMetricsSchemaPromise;
}

function buildAsaCohortUrl(appKey: string, appId: string): string {
  return env.cohortEndpointTemplate
    .replace('{app_key}', appKey)
    .replace('{app_id}', encodeURIComponent(appId));
}

function buildAsaCohortBody(date: string, kpi: 'revenue' | 'roas'): string {
  return JSON.stringify({
    cohort_type: 'user_acquisition',
    from: date,
    to: date,
    aggregation_type: 'cumulative',
    preferred_timezone: true,
    preferred_currency: true,
    groupings: ['date', 'pid', 'c', 'af_adset', 'af_keywords'],
    kpis: [kpi]
  });
}

function buildAsaCohortMetricKey(input: {
  date: string;
  app_key: string;
  platform: string;
  keyword: string;
  campaign: string;
  adset: string;
}): string {
  return [
    input.date,
    input.app_key,
    input.platform,
    input.keyword,
    input.campaign,
    input.adset
  ].join('|');
}

function parseAsaCohortMetricRows(
  appKey: string,
  platform: string,
  rows: CsvRow[],
  kpi: 'revenue' | 'roas'
): AsaCohortMetricRow[] {
  return rows
    .filter((row) => firstNonEmpty(row, ['pid', 'media_source']).trim().toLowerCase() === MASTER_MEDIA_SOURCE)
    .map((row) => ({
      date: String(row.date || '').trim(),
      app_key: appKey,
      platform,
      keyword: String(row.af_keywords || row.keyword || '').trim(),
      campaign: String(firstNonEmpty(row, ['c', 'campaign'], 'unknown')).trim() || 'unknown',
      adset: String(row.af_adset || row.adset || 'unknown').trim() || 'unknown',
      purchase_count: kpi === 'revenue' ? toNumber(row.revenue_count_day_7) : 0,
      revenue_d7: kpi === 'revenue' ? toNumber(row.revenue_sum_day_7) : 0,
      d7_roas: kpi === 'roas' ? toNumber(row.roas_rate_day_7) : 0,
      source_complete: kpi === 'roas'
    }))
    .filter((row) => row.date.length > 0 && row.keyword.length > 0);
}

function mergeAsaCohortMetricRows(rowsList: AsaCohortMetricRow[][]): AsaCohortMetricRow[] {
  const merged = new Map<string, AsaCohortMetricRow>();
  for (const rows of rowsList) {
    for (const row of rows) {
      const key = buildAsaCohortMetricKey(row);
      const existing = merged.get(key);
      if (existing) {
        existing.purchase_count += row.purchase_count;
        existing.revenue_d7 += row.revenue_d7;
        existing.d7_roas = row.source_complete && row.d7_roas > 0 ? row.d7_roas : existing.d7_roas;
        existing.source_complete = existing.source_complete || row.source_complete;
      } else {
        merged.set(key, { ...row });
      }
    }
  }
  return Array.from(merged.values());
}

async function fetchAsaCohortMetrics(appId: string, appKey: string, platform: string, date: string): Promise<AsaCohortMetricRow[]> {
  const url = buildAsaCohortUrl(appKey, appId);
  const baseRequest = {
    headers: {
      Authorization: `Bearer ${env.masterApiToken}`,
      'Content-Type': 'application/json',
      Accept: 'text/csv'
    },
    timeoutMs: env.cohortRequestTimeoutMs,
    label: 'cohort_api',
    method: 'POST' as const
  };
  const revenueCsv = await fetchAppsflyerText(url, {
    ...baseRequest,
    body: buildAsaCohortBody(date, 'revenue')
  });
  await sleep(env.cohortRequestIntervalMs);
  const roasCsv = await fetchAppsflyerText(url, {
    ...baseRequest,
    body: buildAsaCohortBody(date, 'roas')
  });
  return mergeAsaCohortMetricRows([
    parseAsaCohortMetricRows(appKey, platform, parseCsv(revenueCsv), 'revenue'),
    parseAsaCohortMetricRows(appKey, platform, parseCsv(roasCsv), 'roas')
  ]);
}

function buildAsaKeywordBriefSendLockName(
  reportDate: string,
  routeKey: string,
  filters: { appKey?: string; platform?: string }
): string {
  return [
    ASA_KEYWORD_BRIEF_SEND_LOCK_PREFIX,
    reportDate,
    routeKey,
    filters.appKey || 'all',
    filters.platform || 'all'
  ].join(':');
}

function buildLatestAsaSliceRangeCtes(table: string, dateColumn: string): string {
  return `
    latest_ready AS (
      SELECT
        app_key,
        platform,
        date,
        max(snapshot_id) AS snapshot_id
      FROM ${ASA_SLICE_SNAPSHOT_TABLE}
      WHERE status = 'ready'
        AND date >= toDate({from:String})
        AND date <= toDate({to:String})
      GROUP BY app_key, platform, date
    ),
    legacy_slices AS (
      SELECT
        app_key,
        platform,
        ${dateColumn} AS date,
        toUInt64(0) AS snapshot_id
      FROM ${table}
      WHERE snapshot_id = 0
        AND ${dateColumn} >= toDate({from:String})
        AND ${dateColumn} <= toDate({to:String})
        AND (app_key, platform, ${dateColumn}) NOT IN (
          SELECT app_key, platform, date FROM latest_ready
        )
      GROUP BY app_key, platform, ${dateColumn}
    ),
    latest_slices AS (
      SELECT * FROM latest_ready
      UNION ALL
      SELECT * FROM legacy_slices
    )
  `;
}

function buildLatestAsaSliceDateCtes(table: string, dateColumn: string): string {
  return `
    latest_ready AS (
      SELECT
        app_key,
        platform,
        date,
        max(snapshot_id) AS snapshot_id
      FROM ${ASA_SLICE_SNAPSHOT_TABLE}
      WHERE status = 'ready'
        AND date = toDate({reportDate:String})
      GROUP BY app_key, platform, date
    ),
    legacy_slices AS (
      SELECT
        app_key,
        platform,
        ${dateColumn} AS date,
        toUInt64(0) AS snapshot_id
      FROM ${table}
      WHERE snapshot_id = 0
        AND ${dateColumn} = toDate({reportDate:String})
        AND (app_key, platform, ${dateColumn}) NOT IN (
          SELECT app_key, platform, date FROM latest_ready
        )
      GROUP BY app_key, platform, ${dateColumn}
    ),
    latest_slices AS (
      SELECT * FROM latest_ready
      UNION ALL
      SELECT * FROM legacy_slices
    )
  `;
}

function createAsaSnapshotId(): number {
  return Date.now();
}

const RAW_HEADER_ALIASES: Record<string, string> = {
  'media source': 'media_source',
  'media_source': 'media_source',
  'media source (pid)': 'media_source',
  partner: 'media_source',
  pid: 'media_source',
  'campaign': 'campaign',
  'campaign (c)': 'campaign',
  c: 'campaign',
  keywords: 'keyword',
  keyword: 'keyword',
  'keyword id': 'keyword_id',
  'adset': 'adset',
  'ad set': 'adset',
  'adset name': 'adset',
  'ad': 'ad',
  'event time': 'event_time',
  event_time: 'event_time',
  'install time': 'install_time',
  install_time: 'install_time',
  'event name': 'event_name',
  event_name: 'event_name',
  'event revenue usd': 'event_revenue_usd',
  event_revenue_usd: 'event_revenue_usd',
  'event revenue': 'event_revenue',
  event_revenue: 'event_revenue',
  af_revenue: 'event_revenue',
  'cost value': 'cost_value',
  cost_value: 'cost_value',
  cost: 'cost_value',
  'cost currency': 'currency',
  currency: 'currency',
  'country code': 'country',
  country_code: 'country',
  country: 'country',
  platform: 'platform',
  os: 'platform'
};

function logInfo(logger: LoggerLike | undefined, message: string, meta?: Record<string, unknown>): void {
  logger?.info?.(message, meta);
}

function logWarn(logger: LoggerLike | undefined, message: string, meta?: Record<string, unknown>): void {
  logger?.warn?.(message, meta);
}

function logError(logger: LoggerLike | undefined, message: string, meta?: Record<string, unknown>): void {
  logger?.error?.(message, meta);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function mapWithConcurrency<T>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<void>
): Promise<void> {
  if (items.length === 0) {
    return;
  }

  const limit = Math.max(1, Math.min(concurrency, items.length));
  let nextIndex = 0;

  await Promise.all(
    Array.from({ length: limit }, async () => {
      while (true) {
        const currentIndex = nextIndex;
        nextIndex += 1;
        if (currentIndex >= items.length) {
          return;
        }
        await worker(items[currentIndex], currentIndex);
      }
    })
  );
}

function parseCsvRows(csv: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < csv.length; i += 1) {
    const char = csv[i];
    if (char === '"') {
      if (inQuotes && csv[i + 1] === '"') {
        field += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }
    if (char === ',' && !inQuotes) {
      row.push(field);
      field = '';
      continue;
    }
    if ((char === '\n' || char === '\r') && !inQuotes) {
      if (char === '\r' && csv[i + 1] === '\n') {
        i += 1;
      }
      row.push(field);
      field = '';
      if (row.some((item) => item.trim().length > 0)) {
        rows.push(row);
      }
      row = [];
      continue;
    }
    field += char;
  }

  row.push(field);
  if (row.some((item) => item.trim().length > 0)) {
    rows.push(row);
  }
  return rows;
}

function normalizeHeader(header: string): string {
  const normalized = header.replace(/^\uFEFF/, '').trim().toLowerCase().replace(/\s+/g, ' ');
  if (RAW_HEADER_ALIASES[normalized]) {
    return RAW_HEADER_ALIASES[normalized];
  }
  return normalized.replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

function parseCsv(csv: string): CsvRow[] {
  const rows = parseCsvRows(csv);
  if (rows.length <= 1) {
    return [];
  }
  const headers = rows[0].map(normalizeHeader);
  return rows.slice(1).map((cols) => {
    const record: CsvRow = {};
    headers.forEach((header, index) => {
      record[header] = (cols[index] ?? '').trim();
    });
    return record;
  });
}

function toNumber(value: string | undefined): number {
  if (!value) return 0;
  const cleaned = String(value).replace(/[,$\s]/g, '');
  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? parsed : 0;
}

function firstNonEmpty(row: CsvRow, keys: string[], fallback = ''): string {
  for (const key of keys) {
    const value = (row[key] ?? '').trim();
    if (value) {
      return value;
    }
  }
  return fallback;
}

function normalizePlatform(platform: string): string {
  const value = String(platform || '').trim().toLowerCase();
  if (value === 'ios' || value === 'android') {
    return value;
  }
  return 'unknown';
}

function dateOnly(raw: string): string {
  if (!raw) return '';
  const value = new Date(raw);
  if (Number.isNaN(value.getTime())) {
    return raw.slice(0, 10);
  }
  return value.toISOString().slice(0, 10);
}

function toClickHouseDateTime(raw: string, fallback?: string): string {
  const value = new Date(raw);
  const resolved = Number.isNaN(value.getTime()) ? new Date(fallback ?? Date.now()) : value;
  const year = resolved.getUTCFullYear();
  const month = String(resolved.getUTCMonth() + 1).padStart(2, '0');
  const day = String(resolved.getUTCDate()).padStart(2, '0');
  const hours = String(resolved.getUTCHours()).padStart(2, '0');
  const minutes = String(resolved.getUTCMinutes()).padStart(2, '0');
  const seconds = String(resolved.getUTCSeconds()).padStart(2, '0');
  return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
}

function asaTargets(apps: AppConfigRecord[]): Array<{ app: AppConfigRecord; platform: string; appId: string }> {
  const targets: Array<{ app: AppConfigRecord; platform: string; appId: string }> = [];
  for (const app of apps) {
    if (app.ios_pull_app_id) {
      targets.push({ app, platform: 'ios', appId: app.ios_pull_app_id });
    } else if (app.pull_app_id) {
      targets.push({ app, platform: 'ios', appId: app.pull_app_id });
    }
  }
  return targets;
}

interface AsaSliceFetchFailure {
  app_key: string;
  platform: string;
  date: string;
  error: string;
  failure_kind: AppsflyerRequestFailureKind;
  retryable: boolean;
}

function normalizeAsaRequestError(error: unknown): AppsflyerRequestError {
  if (error instanceof AppsflyerRequestError) {
    return error;
  }
  const message = error instanceof Error ? error.message : String(error);
  return new AppsflyerRequestError({
    message,
    kind: 'unknown',
    immediateRetryable: true,
    scheduledRetryable: true
  });
}

async function fetchRawCsv(appId: string, report: 'installs' | 'events', date: string): Promise<CsvRow[]> {
  const template = report === 'installs' ? env.rawInstallsEndpointTemplate : env.rawEventsEndpointTemplate;
  const url = template.replace('{app_id}', encodeURIComponent(appId));
  const body = await fetchAppsflyerText(`${url}?from=${encodeURIComponent(date)}&to=${encodeURIComponent(date)}`, {
    headers: {
      Authorization: `Bearer ${env.rawDataToken}`
    },
    timeoutMs: env.asaKeywordRequestTimeoutMs,
    label: 'raw_api'
  });
  return parseCsv(body);
}

function firstNonEmptyObject(
  row: Record<string, unknown>,
  keys: string[],
  fallback = ''
): string {
  for (const key of keys) {
    const value = row[key];
    if (value == null) continue;
    const normalized = String(value).trim();
    if (normalized) {
      return normalized;
    }
  }
  return fallback;
}

async function fetchMasterKeywordMetrics(appId: string, appKey: string, platform: string, date: string): Promise<AsaMasterMetricRow[]> {
  const params = new URLSearchParams({
    from: date,
    to: date,
    groupings: 'pid,c,af_adset,af_keywords',
    kpis: 'cost,installs,average_ecpi',
    pid: 'Apple Search Ads',
    timezone: 'preferred',
    currency: 'preferred',
    format: 'json'
  });
  const body = await fetchAppsflyerText(
    `https://hq1.appsflyer.com/api/master-agg-data/v4/app/${encodeURIComponent(appId)}?${params.toString()}`,
    {
    headers: {
      Authorization: `Bearer ${env.masterApiToken}`
    },
      timeoutMs: env.asaMasterApiTimeoutMs,
      label: 'master_api'
    }
  );
  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch (error) {
    throw new Error(`master_api_parse_failed ${(error as Error).message}`);
  }
  const rows = Array.isArray(payload)
    ? payload
    : Array.isArray((payload as { data?: unknown[] })?.data)
      ? (payload as { data: unknown[] }).data
      : [];
  return rows
    .filter((row): row is Record<string, unknown> => !!row && typeof row === 'object')
    .filter((row) => firstNonEmptyObject(row, ['Media Source', 'media_source', 'pid']).toLowerCase() === MASTER_MEDIA_SOURCE)
    .map((row) => ({
      date,
      app_key: appKey,
      platform,
      keyword: firstNonEmptyObject(row, ['Keywords', 'af_keywords', 'keyword']).trim(),
      campaign: firstNonEmptyObject(row, ['Campaign', 'c', 'campaign'], 'unknown'),
      adset: firstNonEmptyObject(row, ['Adset', 'af_adset', 'adset'], 'unknown'),
      installs: toNumber(firstNonEmptyObject(row, ['Installs', 'installs'])),
      total_cost: toNumber(firstNonEmptyObject(row, ['Cost', 'cost'])),
      average_ecpi: toNumber(firstNonEmptyObject(row, ['Average eCPI', 'average_ecpi']))
    }))
    .filter((row) => row.keyword.length > 0);
}

async function fetchAsaSliceInputsWithRetry(
  target: { app: AppConfigRecord; platform: string; appId: string },
  date: string,
  logger?: LoggerLike
): Promise<{
  installsCsv: CsvRow[];
  eventsCsv: CsvRow[];
  masterMetrics: AsaMasterMetricRow[];
  cohortMetrics: AsaCohortMetricRow[];
  recoveredByRetry: boolean;
}> {
  const runAttempt = async () =>
    Promise.all([
      fetchRawCsv(target.appId, 'installs', date),
      fetchRawCsv(target.appId, 'events', date),
      fetchMasterKeywordMetrics(target.appId, target.app.app_key, target.platform, date),
      fetchAsaCohortMetrics(target.appId, target.app.app_key, target.platform, date)
    ]);

  try {
    const [installsCsv, eventsCsv, masterMetrics, cohortMetrics] = await runAttempt();
    return { installsCsv, eventsCsv, masterMetrics, cohortMetrics, recoveredByRetry: false };
  } catch (error) {
    const requestError = normalizeAsaRequestError(error);
    if (!requestError.immediateRetryable) {
      throw requestError;
    }

    logWarn(logger, 'asa_keyword_slice_retry_scheduled', {
      app_key: target.app.app_key,
      date,
      platform: target.platform,
      failure_kind: requestError.kind,
      wait_ms: ASA_FETCH_REVIEW_RETRY_DELAY_MS
    });
    await sleep(ASA_FETCH_REVIEW_RETRY_DELAY_MS);

    const [installsCsv, eventsCsv, masterMetrics, cohortMetrics] = await runAttempt();
    logInfo(logger, 'asa_keyword_slice_retry_recovered', {
      app_key: target.app.app_key,
      date,
      platform: target.platform,
      failure_kind: requestError.kind
    });
    return { installsCsv, eventsCsv, masterMetrics, cohortMetrics, recoveredByRetry: true };
  }
}

function isAsaRow(row: CsvRow): boolean {
  const mediaSource = firstNonEmpty(row, ['media_source', 'partner', 'pid']).trim().toLowerCase();
  return mediaSource === RAW_MEDIA_SOURCE;
}

function installSignature(appKey: string, platform: string, row: CsvRow): string {
  return md5Hex(
    [
      appKey,
      platform,
      firstNonEmpty(row, ['install_time']),
      firstNonEmpty(row, ['keyword']),
      firstNonEmpty(row, ['campaign']),
      firstNonEmpty(row, ['country']),
      firstNonEmpty(row, ['cost_value', 'cost']),
      JSON.stringify(row)
    ].join('|')
  );
}

function eventSignature(appKey: string, platform: string, row: CsvRow): string {
  return md5Hex(
    [
      appKey,
      platform,
      firstNonEmpty(row, ['install_time']),
      firstNonEmpty(row, ['event_time']),
      firstNonEmpty(row, ['keyword']),
      firstNonEmpty(row, ['campaign']),
      firstNonEmpty(row, ['event_name']),
      firstNonEmpty(row, ['event_revenue_usd', 'event_revenue']),
      JSON.stringify(row)
    ].join('|')
  );
}

function toAsaInstallRows(app: AppConfigRecord, platformHint: string, rows: CsvRow[]): AsaInstallRow[] {
  const ingestTime = toClickHouseDateTime(new Date().toISOString());
  return rows
    .filter((row) => isAsaRow(row))
    .map((row) => {
      const rawInstallTime = firstNonEmpty(row, ['install_time']);
      return {
        install_date: dateOnly(rawInstallTime),
        install_time: toClickHouseDateTime(rawInstallTime),
        ingest_time: ingestTime,
        app_key: app.app_key,
        platform: normalizePlatform(firstNonEmpty(row, ['platform'], platformHint)),
        keyword: firstNonEmpty(row, ['keyword']).trim(),
        campaign: firstNonEmpty(row, ['campaign'], 'unknown'),
        adset: firstNonEmpty(row, ['adset'], 'unknown'),
        country: firstNonEmpty(row, ['country'], 'unknown'),
        cost_value: toNumber(firstNonEmpty(row, ['cost_value', 'cost'])),
        currency: firstNonEmpty(row, ['currency'], 'USD'),
        snapshot_id: 0,
        event_uid: installSignature(app.app_key, platformHint, row).padEnd(32, '0').slice(0, 32),
        raw_json: JSON.stringify(row)
      };
    })
    .filter((row) => row.keyword.length > 0 && row.install_date.length > 0);
}

function toAsaEventRows(app: AppConfigRecord, platformHint: string, rows: CsvRow[]): AsaInAppEventRow[] {
  const ingestTime = toClickHouseDateTime(new Date().toISOString());
  return rows
    .filter((row) => isAsaRow(row))
    .map((row) => {
      const rawInstallTime = firstNonEmpty(row, ['install_time']);
      const rawEventTime = firstNonEmpty(row, ['event_time']);
      return {
        install_date: dateOnly(rawInstallTime),
        install_time: toClickHouseDateTime(rawInstallTime),
        event_time: toClickHouseDateTime(rawEventTime, rawInstallTime),
        ingest_time: ingestTime,
        app_key: app.app_key,
        platform: normalizePlatform(firstNonEmpty(row, ['platform'], platformHint)),
        keyword: firstNonEmpty(row, ['keyword']).trim(),
        campaign: firstNonEmpty(row, ['campaign'], 'unknown'),
        adset: firstNonEmpty(row, ['adset'], 'unknown'),
        country: firstNonEmpty(row, ['country'], 'unknown'),
        event_name: firstNonEmpty(row, ['event_name'], 'purchase'),
        event_revenue_usd: toNumber(firstNonEmpty(row, ['event_revenue_usd', 'event_revenue'])),
        cost_value: toNumber(firstNonEmpty(row, ['cost_value', 'cost'])),
        currency: firstNonEmpty(row, ['currency'], 'USD'),
        snapshot_id: 0,
        event_uid: eventSignature(app.app_key, platformHint, row).padEnd(32, '0').slice(0, 32),
        raw_json: JSON.stringify(row)
      };
    })
    .filter((row) => row.keyword.length > 0 && row.install_date.length > 0);
}

function buildDateList(backfillDays: number): string[] {
  return buildPreviousDateList(backfillDays);
}

function percentile(values: number[], ratio: number): number {
  const items = values.filter((item) => Number.isFinite(item)).sort((a, b) => a - b);
  if (items.length === 0) return 0;
  if (items.length === 1) return items[0];
  const index = (items.length - 1) * ratio;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return items[lower];
  const weight = index - lower;
  return items[lower] * (1 - weight) + items[upper] * weight;
}

function median(values: number[]): number {
  return percentile(values, 0.5);
}

function buildTrendJson(rows: AsaKeywordDailyMetricInsertRow[]): Record<string, unknown> {
  return {
    dates: rows.map((row) => row.date),
    installs: rows.map((row) => row.installs),
    total_cost: rows.map((row) => row.total_cost),
    purchase_count: rows.map((row) => row.purchase_count),
    revenue_d7: rows.map((row) => row.revenue_d7),
    ecpi: rows.map((row) => row.ecpi),
    cpp: rows.map((row) => row.cpp),
    d7_roas: rows.map((row) => row.d7_roas)
  };
}

function recommendationSummary(
  action: string,
  stage: ProductStage,
  currentEcpi: number,
  currentCpp: number,
  currentD7Roas: number,
  extra: { actionItems?: string[]; scenarioTags?: string[] } = {}
): {
  summary_cn: string;
  risk_level: 'low' | 'medium' | 'high';
  checklist: string[];
  explanation_points: string[];
  action_items: string[];
  scenario_tags: string[];
} {
  const actionItems = Array.isArray(extra.actionItems) ? extra.actionItems.filter(Boolean).slice(0, 8) : [];
  const scenarioTags = Array.isArray(extra.scenarioTags) ? extra.scenarioTags.filter(Boolean).slice(0, 8) : [];
  if (stage === 'stable') {
    return {
      summary_cn:
        action === 'decrease'
          ? `稳定期回收偏弱或 CPP 偏高，建议先下调 20% 控制无效成本。`
          : action === 'increase'
            ? `稳定期 D7 ROAS 与 CPP 表现健康，可上调 20% 放量。`
            : `稳定期指标处于可接受区间，当前建议保持预算。`,
      risk_level: action === 'decrease' ? 'medium' : 'low',
      checklist: ['复核最近 7 天 purchase 事件是否完整', '确认 D7 ROAS 与投放后台口径一致'],
      explanation_points: [
        `d7_roas=${currentD7Roas.toFixed(2)}`,
        `cpp=${currentCpp.toFixed(2)}`,
        `stage=${stage}`
      ],
      action_items:
        actionItems.length > 0 ? actionItems : ['先确认回收窗口已经成熟，再执行调价。', '执行动作后继续观察 3-7 天。'],
      scenario_tags: scenarioTags
    };
  }

  return {
    summary_cn:
      action === 'decrease'
        ? `上升期 eCPI 偏高，建议下调 20% 控制放量成本。`
        : action === 'increase'
          ? `上升期 eCPI 表现较优，可上调 20% 继续放量验证。`
          : `上升期当前 eCPI 接近目标线，建议先保持预算。`,
    risk_level: action === 'decrease' ? 'medium' : 'low',
    checklist: ['确认最近 3 天安装量是否稳定', '检查关键词与 campaign 命名是否一致'],
    explanation_points: [`ecpi=${currentEcpi.toFixed(2)}`, `stage=${stage}`],
    action_items:
      actionItems.length > 0 ? actionItems : ['先验证素材与关键词匹配度，再决定是否继续放量。', '执行动作后至少跟踪 2-3 天成本变化。'],
    scenario_tags: scenarioTags
  };
}

async function queryAsaMetricWindow(from: string, to: string): Promise<AsaKeywordDailyMetricInsertRow[]> {
  await ensureAsaKeywordMetricsSchema();
  return chQuery<AsaKeywordDailyMetricInsertRow>(
    `WITH
      ${buildLatestAsaSliceRangeCtes(ASA_KEYWORD_METRICS_TABLE, 'date')}
      SELECT
        toString(m.date) AS date,
        m.app_key AS app_key,
        m.platform AS platform,
        m.keyword AS keyword,
        m.campaign AS campaign,
        m.adset AS adset,
        m.installs AS installs,
        m.total_cost AS total_cost,
        m.purchase_count AS purchase_count,
        m.revenue_d0 AS revenue_d0,
        m.revenue_d7 AS revenue_d7,
        m.ecpi AS ecpi,
        m.average_ecpi AS average_ecpi,
        m.cpp AS cpp,
        m.d7_roas AS d7_roas,
        m.roas_source_missing AS roas_source_missing,
        m.snapshot_id AS snapshot_id,
        m.version AS version
      FROM (
        SELECT *
        FROM ${ASA_KEYWORD_METRICS_TABLE} FINAL
      ) AS m
      INNER JOIN latest_slices AS s
        ON s.app_key = m.app_key
       AND s.platform = m.platform
       AND s.date = m.date
       AND s.snapshot_id = m.snapshot_id`,
    { from, to }
  );
}

async function queryAsaCountryMetricWindow(from: string, to: string): Promise<AsaKeywordCountryMetricInsertRow[]> {
  try {
    return chQuery<AsaKeywordCountryMetricInsertRow>(
      `WITH
        ${buildLatestAsaSliceRangeCtes(ASA_KEYWORD_COUNTRY_METRICS_TABLE, 'date')}
        SELECT
          toString(m.date) AS date,
          m.app_key AS app_key,
          m.platform AS platform,
          m.country AS country,
          m.keyword AS keyword,
          m.campaign AS campaign,
          m.adset AS adset,
          m.installs AS installs,
          m.total_cost AS total_cost,
          m.ecpi AS ecpi,
          m.snapshot_id AS snapshot_id,
          m.version AS version
        FROM (
          SELECT *
          FROM ${ASA_KEYWORD_COUNTRY_METRICS_TABLE} FINAL
        ) AS m
        INNER JOIN latest_slices AS s
          ON s.app_key = m.app_key
         AND s.platform = m.platform
         AND s.date = m.date
         AND s.snapshot_id = m.snapshot_id`,
      { from, to }
    );
  } catch {
    return [];
  }
}

function average(values: number[]): number {
  const filtered = values.filter((value) => Number.isFinite(value) && value >= 0);
  if (filtered.length === 0) return 0;
  return filtered.reduce((sum, value) => sum + value, 0) / filtered.length;
}

function weightedAsaRoas(rows: Array<Pick<AsaKeywordDailyMetricInsertRow, 'total_cost' | 'd7_roas'>>): number {
  const eligibleRows = rows.filter((row) => Number(row.total_cost || 0) > 0 && Number.isFinite(Number(row.d7_roas || 0)));
  if (eligibleRows.length === 0) {
    return 0;
  }
  const totalCost = eligibleRows.reduce((sum, row) => sum + Number(row.total_cost || 0), 0);
  if (totalCost <= 0) {
    return 0;
  }
  return (
    eligibleRows.reduce((sum, row) => sum + Number(row.d7_roas || 0) * Number(row.total_cost || 0), 0) / totalCost
  );
}

export function buildAsaDecisionWindow(
  reportDate: string,
  policy: RecommendationPolicyRuleJson | null
): { from: string; to: string } {
  const maturityWindow = policy?.maturity_window ?? defaultRecommendationPolicyRule().maturity_window;
  const excludeRecentDays = Math.max(0, Math.floor(maturityWindow.exclude_recent_days || 0));
  const decisionWindowDays = Math.max(1, Math.floor(maturityWindow.decision_window_days || 7));
  const to = shiftDateString(reportDate, -excludeRecentDays);
  const from = shiftDateString(to, -(decisionWindowDays - 1));
  return { from, to };
}

export function buildAsaRoasWindow(
  reportDate: string,
  policy: RecommendationPolicyRuleJson | null
): { from: string; to: string } {
  return buildMatureRoasWindow(reportDate, policy, { excludeRecentDays: 7, decisionWindowDays: 14 });
}

export function buildAsaContextWindow(
  reportDate: string,
  policy: RecommendationPolicyRuleJson | null
): { from: string; to: string } {
  const maturityWindow = policy?.maturity_window ?? defaultRecommendationPolicyRule().maturity_window;
  const maxContextDays = Math.max(...(maturityWindow.context_window_days || [14]), 14);
  return {
    from: shiftDateString(reportDate, -(maxContextDays - 1)),
    to: reportDate
  };
}

export function buildAsaRelativeCompareDecision(input: {
  stage: ProductStage;
  currentEcpi: number;
  currentD7Roas: number;
  peerEcpi: number[];
  peerRoas: number[];
  policy: RecommendationPolicyRuleJson;
}): {
  action: 'increase' | 'decrease' | 'hold';
  reasonCode: string;
  failedMetrics: string[];
  strongMetrics: string[];
  targetEcpi: number;
  targetD7Roas: number;
} {
  const relativeSamples: Array<{ metric: 'cpi' | 'roas'; current: number; peers: number[] }> = [];
  for (const metric of input.policy.relative_compare.metrics || []) {
    if (metric === 'cpi') {
      relativeSamples.push({ metric, current: input.currentEcpi, peers: input.peerEcpi });
      continue;
    }
    if (metric === 'roas') {
      relativeSamples.push({ metric, current: input.currentD7Roas, peers: input.peerRoas });
    }
  }
  const relativeResult = evaluateRelativeCompareMetrics(relativeSamples, {
    minPeerCount: input.policy.relative_compare.min_peer_count,
    underperformRatio: input.policy.relative_compare.underperform_ratio
  });

  const targetEcpi = Math.max(0.01, median(input.peerEcpi) || input.currentEcpi || 0.01);
  const targetD7Roas = Math.max(0.01, median(input.peerRoas) || input.currentD7Roas || 0.01);
  if (relativeResult.availableMetrics.length < input.policy.relative_compare.min_failed_metrics) {
    return {
      action: 'hold',
      reasonCode: 'relative_compare_peer_insufficient',
      failedMetrics: relativeResult.failedMetrics,
      strongMetrics: relativeResult.strongMetrics,
      targetEcpi,
      targetD7Roas
    };
  }
  if (relativeResult.failedMetrics.length >= input.policy.relative_compare.min_failed_metrics) {
    return {
      action: 'decrease',
      reasonCode: 'relative_compare_underperform',
      failedMetrics: relativeResult.failedMetrics,
      strongMetrics: relativeResult.strongMetrics,
      targetEcpi,
      targetD7Roas
    };
  }
  if (relativeResult.strongMetrics.length >= input.policy.relative_compare.min_failed_metrics) {
    return {
      action: 'increase',
      reasonCode: 'relative_compare_outperform',
      failedMetrics: relativeResult.failedMetrics,
      strongMetrics: relativeResult.strongMetrics,
      targetEcpi,
      targetD7Roas
    };
  }
  return {
    action: 'hold',
    reasonCode: 'relative_compare_neutral_hold',
    failedMetrics: relativeResult.failedMetrics,
    strongMetrics: relativeResult.strongMetrics,
    targetEcpi,
    targetD7Roas
  };
}

async function rebuildAsaKeywordStatesAndRecommendations(backfillDays: number, logger?: LoggerLike): Promise<{
  stateRows: number;
  recommendationRows: number;
}> {
  const dates = buildDateList(Math.max(backfillDays, 14));
  const from = dates[dates.length - 1];
  const to = dates[0];
  const [metrics, countryMetrics, stageConfigs, policyRows, apps] = await Promise.all([
    queryAsaMetricWindow(from, to),
    queryAsaCountryMetricWindow(from, to),
    listProductStageConfigs(),
    listRecommendationPolicyConfigs({ engine: 'asa', enabled: true }),
    listApps()
  ]);
  const appByKey = new Map(apps.map((app) => [app.app_key, app]));
  const stageMap = new Map(stageConfigs.filter((item) => item.enabled).map((item) => [`${item.app_key}|${item.platform}`, item.stage]));
  const policyMap = buildRecommendationPolicyMap(
    policyRows.map((row) => ({
      ...row,
      rule_json: normalizeRecommendationPolicyRule(row.rule_json)
    }))
  );
  const peerStatsByDate = new Map<string, { ecpi: number[]; cpp: number[]; roas: number[] }>();
  const countryStatsByKeyword = new Map<string, AsaKeywordCountryMetricInsertRow[]>();

  const grouped = new Map<string, AsaKeywordDailyMetricInsertRow[]>();
  for (const row of metrics) {
    const key = [row.app_key, row.platform, row.keyword, row.campaign, row.adset].join('|');
    const bucket = grouped.get(key) ?? [];
    bucket.push(row);
    grouped.set(key, bucket);

    if (Number(row.installs || 0) >= 1) {
      const peerKey = `${row.app_key}|${row.platform}|${row.date}`;
      const peerStats = peerStatsByDate.get(peerKey) ?? { ecpi: [], cpp: [], roas: [] };
      const ecpi = Number(row.ecpi || 0);
      const cpp = Number(row.cpp || 0);
      const roas = Number(row.d7_roas || 0);
      if (ecpi > 0) peerStats.ecpi.push(ecpi);
      if (cpp > 0) peerStats.cpp.push(cpp);
      if (roas > 0) peerStats.roas.push(roas);
      peerStatsByDate.set(peerKey, peerStats);
    }
  }
  for (const row of countryMetrics) {
    const key = [row.app_key, row.platform, row.keyword, row.campaign, row.adset].join('|');
    const bucket = countryStatsByKeyword.get(key) ?? [];
    bucket.push(row);
    countryStatsByKeyword.set(key, bucket);
  }

  const scopesByApp = new Map<string, Array<{ keyword: string; campaign: string; adset: string }>>();
  for (const rows of grouped.values()) {
    const current = rows[rows.length - 1];
    if (!current) continue;
    const scopeKey = `${current.app_key}|${current.platform}`;
    const scopes = scopesByApp.get(scopeKey) ?? [];
    scopes.push({
      keyword: current.keyword,
      campaign: current.campaign,
      adset: current.adset
    });
    scopesByApp.set(scopeKey, scopes);
  }
  for (const [scopeKey, scopes] of scopesByApp) {
    const [appKey, platform] = scopeKey.split('|');
    if (!appKey || !platform) continue;
    await deleteStaleAsaKeywordStates(appKey, platform, scopes);
    await deleteStaleAsaKeywordRecommendations(appKey, platform, from, to, scopes);
  }
  for (const target of asaTargets(Array.from(appByKey.values()))) {
    const scopeKey = `${target.app.app_key}|${target.platform}`;
    if (scopesByApp.has(scopeKey)) {
      continue;
    }
    await deleteStaleAsaKeywordStates(target.app.app_key, target.platform, []);
    await deleteStaleAsaKeywordRecommendations(target.app.app_key, target.platform, from, to, []);
  }

  let stateRows = 0;
  let recommendationRows = 0;
  const recommendationScopes = new Set<string>();
  const pendingLlmUpdates: Array<{
    current: AsaKeywordDailyMetricInsertRow;
    action: 'increase' | 'decrease' | 'hold';
    stage: ProductStage;
    policy: RecommendationPolicyRuleJson | null;
    manualPromptMarkdown: string | null;
    reasonCode: string;
    currentEcpi: number;
    currentCpp: number;
    currentD7Roas: number;
    roasWindow: { from: string; to: string };
    roasDataStatus: RoasDataStatus;
    targetEcpi: number;
    targetCpp: number;
    targetD7Roas: number;
    totalCost7d: number;
    installs7d: number;
    last3Installs: number;
    spendSeries: number[];
    scenarioTags: string[];
    presetActionItems: string[];
    failedMetrics: string[];
    strongMetrics: string[];
  }> = [];
  for (const rows of grouped.values()) {
    rows.sort((a, b) => a.date.localeCompare(b.date));
    const current = rows[rows.length - 1];
    if (!current) continue;
    const scopeKey = `${current.app_key}|${current.platform}|${current.date}`;
    if (!recommendationScopes.has(scopeKey)) {
      await replaceAsaKeywordRecommendationsForDate(current.app_key, current.platform, current.date);
      recommendationScopes.add(scopeKey);
    }
    const policyRecord = policyMap.get(buildRecommendationPolicyKey(current.app_key, current.platform, 'asa')) ?? null;
    const policy = policyRecord ? normalizeRecommendationPolicyRule(policyRecord.rule_json) : null;
    const stage = policy
      ? policy.metric_family === 'd7_roas_cpp'
        ? 'stable'
        : 'rising'
      : stageMap.get(`${current.app_key}|${current.platform}`) ?? 'rising';
    const decisionWindow = buildAsaDecisionWindow(current.date, policy);
    const roasWindow = buildAsaRoasWindow(current.date, policy);
    const contextWindow = buildAsaContextWindow(current.date, policy);
    const decisionRows = rows.filter((row) => row.date >= decisionWindow.from && row.date <= decisionWindow.to);
    const roasRows = rows.filter((row) => row.date >= roasWindow.from && row.date <= roasWindow.to);
    const contextRows = rows.filter((row) => row.date >= contextWindow.from && row.date <= contextWindow.to);
    const effectiveDecisionRows = decisionRows.length > 0 ? decisionRows : rows.slice(-7);
    const effectiveRoasRows = roasRows.length > 0 ? roasRows : [];
    const coveredRoasRows = effectiveRoasRows.filter(
      (row) => !(Number(row.total_cost || 0) > 0 && Number(row.roas_source_missing || 0) === 1)
    );
    const installs7d = effectiveDecisionRows.reduce((sum, row) => sum + Number(row.installs || 0), 0);
    const totalCost7d = effectiveDecisionRows.reduce((sum, row) => sum + Number(row.total_cost || 0), 0);
    const roasHasSpend = effectiveRoasRows.some((row) => Number(row.total_cost || 0) > 0);
    const coveredRoasCost = coveredRoasRows.reduce((sum, row) => sum + Number(row.total_cost || 0), 0);
    const missingRoasCost = effectiveRoasRows
      .filter((row) => Number(row.total_cost || 0) > 0 && Number(row.roas_source_missing || 0) === 1)
      .reduce((sum, row) => sum + Number(row.total_cost || 0), 0);
    const roasDataStatus = resolveRoasDataStatus({
      hasWindowRows: effectiveRoasRows.length > 0,
      hasSpend: roasHasSpend,
      coveredCost: coveredRoasCost,
      missingCost: missingRoasCost
    });
    const purchaseCount7d =
      isRoasDataUsableStatus(roasDataStatus)
        ? coveredRoasRows.reduce((sum, row) => sum + Number(row.purchase_count || 0), 0)
        : 0;
    const revenueD7Window =
      isRoasDataUsableStatus(roasDataStatus)
        ? coveredRoasRows.reduce((sum, row) => sum + Number(row.revenue_d7 || 0), 0)
        : 0;
    const currentEcpi = installs7d > 0 ? totalCost7d / installs7d : Number(current.ecpi || 0);
    const matureRoasCost =
      isRoasDataUsableStatus(roasDataStatus)
        ? coveredRoasCost
        : 0;
    const currentCpp = purchaseCount7d > 0 ? matureRoasCost / purchaseCount7d : 0;
    const currentD7Roas = isRoasDataUsableStatus(roasDataStatus) ? weightedAsaRoas(coveredRoasRows) : 0;

    const peerStats = peerStatsByDate.get(`${current.app_key}|${current.platform}|${current.date}`) ?? {
      ecpi: [],
      cpp: [],
      roas: []
    };
    const peerEcpi = peerStats.ecpi;
    const peerCpp = peerStats.cpp;
    const peerRoas = Array.from(grouped.values())
      .map((peerRows) => {
        const peerCurrent = peerRows[peerRows.length - 1];
        if (!peerCurrent) return null;
        if (
          peerCurrent.app_key !== current.app_key ||
          peerCurrent.platform !== current.platform ||
          peerCurrent.date !== current.date ||
          (peerCurrent.keyword === current.keyword &&
            peerCurrent.campaign === current.campaign &&
            peerCurrent.adset === current.adset)
        ) {
          return null;
        }
        const peerWindowRows = peerRows.filter((row) => row.date >= roasWindow.from && row.date <= roasWindow.to);
        const peerCoveredRows = peerWindowRows.filter(
          (row) => !(Number(row.total_cost || 0) > 0 && Number(row.roas_source_missing || 0) === 1)
        );
        const peerStatus = resolveRoasDataStatus({
          hasWindowRows: peerWindowRows.length > 0,
          hasSpend: peerWindowRows.some((row) => Number(row.total_cost || 0) > 0),
          coveredCost: peerCoveredRows.reduce((sum, row) => sum + Number(row.total_cost || 0), 0),
          missingCost: peerWindowRows
            .filter((row) => Number(row.total_cost || 0) > 0 && Number(row.roas_source_missing || 0) === 1)
            .reduce((sum, row) => sum + Number(row.total_cost || 0), 0)
        });
        return isRoasDataUsableStatus(peerStatus) ? weightedAsaRoas(peerCoveredRows) : null;
      })
      .filter((value) => value != null && Number.isFinite(value) && value > 0) as number[];
    const thresholdTargets = resolveRecommendationTarget(policy, { mediaSource: 'Apple Search Ads' });
    let targetEcpi = Math.max(
      0.01,
      thresholdTargets.ecpi_max ?? (percentile(peerEcpi, 0.4) || median(peerEcpi) || currentEcpi || 0.01)
    );
    const targetCpp = Math.max(
      0.01,
      thresholdTargets.cpp_max ?? (percentile(peerCpp, 0.4) || median(peerCpp) || currentCpp || 0.01)
    );
    const targetD7Roas = Math.max(
      0.01,
      thresholdTargets.roas_min ?? (percentile(peerRoas, 0.6) || median(peerRoas) || currentD7Roas || 0.01)
    );
    const spendSeries = contextRows.map((row) => Number(row.total_cost || 0));
    const scenarioEvaluation = evaluateSpendScenarios({
      avgDailySpend: average(spendSeries),
      spendSeries,
      spendPolicy: policy?.spend_policy ?? defaultRecommendationPolicyRule().spend_policy,
      actionPlaybook: policy?.action_playbook ?? defaultRecommendationPolicyRule().action_playbook
    });
    const countryRows = (
      countryStatsByKeyword.get([current.app_key, current.platform, current.keyword, current.campaign, current.adset].join('|')) ?? []
    ).filter((row) => effectiveDecisionRows.some((metricRow) => metricRow.date === row.date));
    const countryBreaches = Object.entries(policy?.targets.country_targets ?? {}).flatMap(([country, target]) => {
      const relevantRows = countryRows.filter((row) => row.country === country);
      const installs = relevantRows.reduce((sum, row) => sum + Number(row.installs || 0), 0);
      const totalCost = relevantRows.reduce((sum, row) => sum + Number(row.total_cost || 0), 0);
      const ecpi = installs > 0 ? totalCost / installs : 0;
      return target.ecpi_max != null && ecpi > target.ecpi_max ? [{ country, ecpi, targetEcpi: target.ecpi_max }] : [];
    });
    if (countryBreaches.length > 0) {
      const worstBreach = countryBreaches.sort((a, b) => b.ecpi / b.targetEcpi - a.ecpi / a.targetEcpi)[0];
      targetEcpi = worstBreach.targetEcpi;
    }
    const relativeDecision =
      policy?.metric_family === 'relative_compare'
        ? buildAsaRelativeCompareDecision({
            stage,
            currentEcpi,
            currentD7Roas,
            peerEcpi,
            peerRoas,
            policy
          })
        : null;
    const effectiveTargetEcpi = relativeDecision?.targetEcpi ?? targetEcpi;
    const effectiveTargetD7Roas = relativeDecision?.targetD7Roas ?? targetD7Roas;
    const usesRoasPrimaryMetric = isAsaRoasPrimaryMetric(policy, effectiveTargetD7Roas);

    await upsertAsaKeywordState({
      app_key: current.app_key,
      platform: current.platform,
      keyword: current.keyword,
      campaign: current.campaign,
      adset: current.adset,
      current_stage: stage,
      stage_score: stage === 'stable' ? currentD7Roas * 100 : Math.max(0, 100 - currentEcpi * 10),
      first_seen_date: rows[0].date,
      last_seen_date: current.date,
      current_ecpi: currentEcpi,
      current_cpp: currentCpp,
      current_d7_roas: currentD7Roas,
      roas_window_from: roasWindow.from,
      roas_window_to: roasWindow.to,
      roas_data_status: roasDataStatus,
      target_ecpi: effectiveTargetEcpi,
      target_cpp: targetCpp,
      target_d7_roas: effectiveTargetD7Roas,
      installs_7d: installs7d,
      total_cost_7d: totalCost7d,
      purchase_count_7d: purchaseCount7d,
      revenue_d7_7d: revenueD7Window,
      trend_json: buildTrendJson(contextRows.length > 0 ? contextRows : rows.slice(-14))
    });
    stateRows += 1;
    const action =
      usesRoasPrimaryMetric && !isRoasDataUsableStatus(roasDataStatus)
        ? 'hold'
        : relativeDecision
        ? relativeDecision.action
        : 
      stage === 'stable'
        ? currentD7Roas < effectiveTargetD7Roas * 0.85 || (currentCpp > 0 && currentCpp > (thresholdTargets.cpp_pause_threshold ?? targetCpp * 1.15))
          ? 'decrease'
          : currentD7Roas >= (thresholdTargets.roas_good ?? effectiveTargetD7Roas) && (currentCpp === 0 || currentCpp <= targetCpp)
            ? 'increase'
            : 'hold'
        : countryBreaches.length > 0 || currentEcpi > targetEcpi * 1.15
          ? 'decrease'
          : currentEcpi <= targetEcpi * 0.9
            ? 'increase'
            : 'hold';

    const reasonCode =
      usesRoasPrimaryMetric && !isRoasDataUsableStatus(roasDataStatus)
        ? roasDataStatus === 'unavailable'
          ? 'roas_window_unavailable'
          : 'roas_pending_revenue'
        : relativeDecision?.reasonCode ??
      stage === 'stable'
        ? 'stable_dual_metric'
        : countryBreaches.length > 0
          ? 'policy_country_ecpi_breach'
          : 'rising_ecpi';
    const llmResult = recommendationSummary(action, stage, currentEcpi, currentCpp, currentD7Roas, {
      actionItems: scenarioEvaluation.actionItems,
      scenarioTags: scenarioEvaluation.scenarioTags
    });
    await upsertAsaKeywordRecommendation({
      app_key: current.app_key,
      platform: current.platform,
      keyword: current.keyword,
      campaign: current.campaign,
      adset: current.adset,
      date: current.date,
      action,
      change_ratio: action === 'hold' ? 0 : 0.2,
      primary_metric:
        policy?.metric_family === 'd7_roas_cpp'
          ? 'd7_roas_cpp'
          : policy?.metric_family === 'relative_compare' && effectiveTargetD7Roas > 0
            ? 'd7_roas_cpp'
            : 'ecpi',
      current_ecpi: currentEcpi,
      current_cpp: currentCpp,
      current_d7_roas: currentD7Roas,
      roas_window_from: roasWindow.from,
      roas_window_to: roasWindow.to,
      roas_data_status: roasDataStatus,
      target_ecpi: effectiveTargetEcpi,
      target_cpp: targetCpp,
      target_d7_roas: effectiveTargetD7Roas,
      reason_code: reasonCode,
      llm_summary: llmResult,
      status: 'pending'
    });
    recommendationRows += 1;
    pendingLlmUpdates.push({
      current,
      action,
      stage,
      policy,
      manualPromptMarkdown: policyRecord?.manual_prompt_markdown ?? null,
      reasonCode,
      currentEcpi,
      currentCpp,
      currentD7Roas,
      roasWindow,
      roasDataStatus,
      targetEcpi: effectiveTargetEcpi,
      targetCpp,
      targetD7Roas: effectiveTargetD7Roas,
      totalCost7d,
      installs7d,
      last3Installs: effectiveDecisionRows.slice(-3).reduce((sum, row) => sum + Number(row.installs || 0), 0),
      spendSeries,
      scenarioTags: scenarioEvaluation.scenarioTags,
      presetActionItems: scenarioEvaluation.actionItems,
      failedMetrics: relativeDecision?.failedMetrics ?? [],
      strongMetrics: relativeDecision?.strongMetrics ?? []
    });
  }

  logInfo(logger, 'asa_keyword_llm_enrichment_start', {
    recommendation_count: pendingLlmUpdates.length,
    concurrency: env.asaRecommendationLlmConcurrency,
    thinking_enabled: false
  });

  await mapWithConcurrency(pendingLlmUpdates, env.asaRecommendationLlmConcurrency, async (item) => {
    const primaryMetric =
      item.policy?.metric_family === 'd7_roas_cpp'
        ? 'roas'
        : item.policy?.metric_family === 'relative_compare' && item.targetD7Roas > 0
          ? 'roas'
          : 'ecpi';
    const llmCall = await explainBudgetRecommendationWithLlm({
      appKey: item.current.app_key,
      platform: item.current.platform,
      mediaSource: 'Apple Search Ads',
      primaryMetric,
      metricMode: item.roasDataStatus === 'pending' ? 'roas_pending_revenue' : 'active',
      keyword: item.current.keyword,
      matchType: 'asa',
      action: item.action,
      changeRatio: item.action === 'hold' ? 0 : 0.2,
      currentCost: item.totalCost7d,
      suggestedBudget:
        item.action === 'increase'
          ? item.totalCost7d * 1.2
          : item.action === 'decrease'
            ? item.totalCost7d * 0.8
            : item.totalCost7d,
      confidence: item.stage === 'stable' ? 0.88 : 0.82,
      reasonCode: item.reasonCode,
      stage: item.stage,
      lastCpi: item.currentEcpi,
      lastInstalls: item.installs7d,
      lastClicks: item.installs7d,
      currentEcpi: item.currentEcpi,
      targetEcpi: item.targetEcpi,
      volumeTier: item.installs7d >= 30 ? 'high' : item.installs7d >= 15 ? 'medium' : 'low',
      last3Installs: item.last3Installs,
      last7Installs: item.installs7d,
      currentRoas: item.currentD7Roas,
      targetRoas: item.targetD7Roas,
      currentCpp: item.currentCpp,
      targetCpp: item.targetCpp,
      scenarioTags: item.scenarioTags,
      presetActionItems: item.presetActionItems,
      structuredPolicy: item.policy ? (item.policy as unknown as Record<string, unknown>) : undefined,
      computedContext: {
        spend_series: item.spendSeries,
        current_cpp: item.currentCpp,
        target_cpp: item.targetCpp,
        current_roas: item.currentD7Roas,
        target_roas: item.targetD7Roas,
        roas_data_status: item.roasDataStatus,
        roas_window_from: item.roasWindow.from,
        roas_window_to: item.roasWindow.to,
        failed_metrics: item.failedMetrics,
        strong_metrics: item.strongMetrics
      },
      manualPromptMarkdown: item.manualPromptMarkdown,
      feedbackScope: 'asa',
      enableThinking: false
    });
    await insertLlmAuditLog({
      biz_type: 'asa_keyword_recommendation',
      biz_id: `${item.current.app_key}|${item.current.platform}|${item.current.keyword}|${item.current.campaign}|${item.current.adset}|${item.current.date}`,
      model: llmCall.model,
      prompt_hash: llmCall.promptHash,
      response_json: llmCall.raw,
      latency_ms: llmCall.latencyMs,
      success: llmCall.ok
    });
    await upsertAsaKeywordRecommendation({
      app_key: item.current.app_key,
      platform: item.current.platform,
      keyword: item.current.keyword,
      campaign: item.current.campaign,
      adset: item.current.adset,
      date: item.current.date,
      action: item.action,
      change_ratio: item.action === 'hold' ? 0 : 0.2,
      primary_metric:
        item.policy?.metric_family === 'd7_roas_cpp'
          ? 'd7_roas_cpp'
          : item.policy?.metric_family === 'relative_compare' && item.targetD7Roas > 0
            ? 'd7_roas_cpp'
            : 'ecpi',
      current_ecpi: item.currentEcpi,
      current_cpp: item.currentCpp,
      current_d7_roas: item.currentD7Roas,
      roas_window_from: item.roasWindow.from,
      roas_window_to: item.roasWindow.to,
      roas_data_status: item.roasDataStatus,
      target_ecpi: item.targetEcpi,
      target_cpp: item.targetCpp,
      target_d7_roas: item.targetD7Roas,
      reason_code: item.reasonCode,
      llm_summary: llmCall.output,
      status: 'pending'
    });
  });

  logInfo(logger, 'asa_keyword_state_cycle_done', { state_rows: stateRows, recommendation_rows: recommendationRows });
  return { stateRows, recommendationRows };
}

function aggregateDailyMetrics(
  installRows: AsaInstallRow[],
  eventRows: AsaInAppEventRow[],
  masterRows: AsaMasterMetricRow[],
  cohortRows: AsaCohortMetricRow[]
): AsaKeywordDailyMetricInsertRow[] {
  const aggregate = new Map<string, AsaKeywordAccumulator>();

  function ensureAccumulator(
    date: string,
    appKey: string,
    platform: string,
    keyword: string,
    campaign: string,
    adset: string
  ): AsaKeywordAccumulator {
    const key = [date, appKey, platform, keyword, campaign, adset].join('|');
    const existing = aggregate.get(key);
    if (existing) {
      return existing;
    }
    const created: AsaKeywordAccumulator = {
      date,
      app_key: appKey,
      platform,
      keyword,
      campaign,
      adset,
      raw_installs: 0,
      master_installs: 0,
      total_cost: 0,
      purchase_count: 0,
      revenue_d0: 0,
      revenue_d7: 0,
      d7_roas: 0,
      roas_source_complete: false,
      average_ecpi: 0
    };
    aggregate.set(key, created);
    return created;
  }

  for (const row of masterRows) {
    const current = ensureAccumulator(row.date, row.app_key, row.platform, row.keyword, row.campaign, row.adset);
    current.master_installs += Number(row.installs || 0);
    current.total_cost += Number(row.total_cost || 0);
    current.average_ecpi = Number(row.average_ecpi || 0);
  }

  for (const row of installRows) {
    const current = ensureAccumulator(row.install_date, row.app_key, row.platform, row.keyword, row.campaign, row.adset);
    current.raw_installs += 1;
  }

  for (const row of cohortRows) {
    const current = ensureAccumulator(row.date, row.app_key, row.platform, row.keyword, row.campaign, row.adset);
    current.purchase_count += Number(row.purchase_count || 0);
    current.revenue_d7 += Number(row.revenue_d7 || 0);
    current.d7_roas = row.source_complete ? Number(row.d7_roas || 0) : current.d7_roas;
    current.roas_source_complete = current.roas_source_complete || row.source_complete;
  }

  for (const row of eventRows) {
    const current = ensureAccumulator(row.install_date, row.app_key, row.platform, row.keyword, row.campaign, row.adset);
    const installTime = new Date(row.install_time).getTime();
    const eventTime = new Date(row.event_time).getTime();
    const deltaMs = Number.isFinite(installTime) && Number.isFinite(eventTime) ? eventTime - installTime : Number.POSITIVE_INFINITY;
    if (row.event_revenue_usd > 0) {
      if (deltaMs <= ONE_DAY_MS) {
        current.revenue_d0 += row.event_revenue_usd;
      }
    }
  }

  return Array.from(aggregate.values()).map((row) => {
    const installs = row.master_installs > 0 ? row.master_installs : row.raw_installs;
    return {
      date: row.date,
      app_key: row.app_key,
      platform: row.platform,
      keyword: row.keyword,
      campaign: row.campaign,
      adset: row.adset,
      installs,
      total_cost: row.total_cost,
      purchase_count: row.purchase_count,
      revenue_d0: row.revenue_d0,
      revenue_d7: row.revenue_d7,
      ecpi: installs > 0 ? row.total_cost / installs : 0,
      average_ecpi: row.average_ecpi,
      cpp: row.purchase_count > 0 ? row.total_cost / row.purchase_count : 0,
      d7_roas: row.roas_source_complete ? row.d7_roas : 0,
      roas_source_missing: row.total_cost > 0 && !row.roas_source_complete ? 1 : 0,
      snapshot_id: 0,
      version: Date.now()
    };
  });
}

function aggregateAsaCountryMetrics(installRows: AsaInstallRow[]): AsaKeywordCountryMetricInsertRow[] {
  const aggregate = new Map<
    string,
    {
      date: string;
      app_key: string;
      platform: string;
      country: string;
      keyword: string;
      campaign: string;
      adset: string;
      installs: number;
      total_cost: number;
    }
  >();

  for (const row of installRows) {
    const key = [row.install_date, row.app_key, row.platform, row.country, row.keyword, row.campaign, row.adset].join(
      '|'
    );
    const bucket =
      aggregate.get(key) ??
      {
        date: row.install_date,
        app_key: row.app_key,
        platform: row.platform,
        country: row.country,
        keyword: row.keyword,
        campaign: row.campaign,
        adset: row.adset,
        installs: 0,
        total_cost: 0
      };
    bucket.installs += 1;
    bucket.total_cost += Number(row.cost_value || 0);
    aggregate.set(key, bucket);
  }

  return Array.from(aggregate.values()).map((row) => ({
    ...row,
    ecpi: row.installs > 0 ? row.total_cost / row.installs : 0,
    snapshot_id: 0,
    version: Date.now()
  }));
}

async function replaceAsaSlice(params: {
  appKey: string;
  platform: string;
  date: string;
  snapshotId: number;
  installRows: AsaInstallRow[];
  eventRows: AsaInAppEventRow[];
  metricRows: AsaKeywordDailyMetricInsertRow[];
  countryMetricRows: AsaKeywordCountryMetricInsertRow[];
  logger?: LoggerLike;
}): Promise<void> {
  const queryParams = {
    app_key: params.appKey,
    platform: params.platform,
    date: params.date,
    snapshot_id: params.snapshotId
  };

  const installRows = params.installRows.map((row) => ({ ...row, snapshot_id: params.snapshotId }));
  const eventRows = params.eventRows.map((row) => ({ ...row, snapshot_id: params.snapshotId }));
  const metricRows = params.metricRows.map((row) => ({
    ...row,
    snapshot_id: params.snapshotId,
    version: params.snapshotId
  }));
  const countryMetricRows = params.countryMetricRows.map((row) => ({
    ...row,
    snapshot_id: params.snapshotId,
    version: params.snapshotId
  }));

  await chInsertJSON('asa_raw_installs', installRows);
  await chInsertJSON('asa_raw_in_app_events', eventRows);
  await chInsertJSON(ASA_KEYWORD_METRICS_TABLE, metricRows);
  await chInsertJSON(ASA_KEYWORD_COUNTRY_METRICS_TABLE, countryMetricRows);
  await chInsertJSON(ASA_SLICE_SNAPSHOT_TABLE, [
    {
      app_key: params.appKey,
      platform: params.platform,
      date: params.date,
      snapshot_id: params.snapshotId,
      status: 'ready',
      created_at: toClickHouseDateTime(new Date().toISOString())
    }
  ]);

  try {
    await chExec(
      `ALTER TABLE asa_raw_installs
        DELETE WHERE app_key = {app_key:String}
          AND platform = {platform:String}
          AND install_date = toDate({date:String})
          AND snapshot_id != {snapshot_id:UInt64}
        SETTINGS mutations_sync = 2`,
      queryParams
    );
    await chExec(
      `ALTER TABLE asa_raw_in_app_events
        DELETE WHERE app_key = {app_key:String}
          AND platform = {platform:String}
          AND install_date = toDate({date:String})
          AND snapshot_id != {snapshot_id:UInt64}
        SETTINGS mutations_sync = 2`,
      queryParams
    );
    await chExec(
      `ALTER TABLE ${ASA_KEYWORD_METRICS_TABLE}
        DELETE WHERE app_key = {app_key:String}
          AND platform = {platform:String}
          AND date = toDate({date:String})
          AND snapshot_id != {snapshot_id:UInt64}
        SETTINGS mutations_sync = 2`,
      queryParams
    );
    await chExec(
      `ALTER TABLE ${ASA_KEYWORD_COUNTRY_METRICS_TABLE}
        DELETE WHERE app_key = {app_key:String}
          AND platform = {platform:String}
          AND date = toDate({date:String})
          AND snapshot_id != {snapshot_id:UInt64}
        SETTINGS mutations_sync = 2`,
      queryParams
    );
    await chExec(
      `ALTER TABLE ${ASA_SLICE_SNAPSHOT_TABLE}
        DELETE WHERE app_key = {app_key:String}
          AND platform = {platform:String}
          AND date = toDate({date:String})
          AND snapshot_id != {snapshot_id:UInt64}
        SETTINGS mutations_sync = 2`,
      queryParams
    );
  } catch (error) {
    params.logger?.warn?.('asa_snapshot_cleanup_incomplete', {
      app_key: params.appKey,
      platform: params.platform,
      date: params.date,
      snapshot_id: params.snapshotId,
      error: error instanceof Error ? error.message : String(error)
    });
  }
}

export async function runAsaKeywordCycle(backfillDays: number, logger?: LoggerLike): Promise<AsaCycleResult> {
  await ensureAsaKeywordMetricsSchema();
  const startedAt = new Date();
  const dates = buildDateList(backfillDays);
  const apps = await listApps();
  const targets = asaTargets(apps);
  let installRowCount = 0;
  let eventRowCount = 0;
  let metricRowCount = 0;
  let recoveredSliceCount = 0;
  const sliceFailures: AsaSliceFetchFailure[] = [];

  for (const target of targets) {
    for (const date of dates) {
      let installsCsv: CsvRow[] = [];
      let eventsCsv: CsvRow[] = [];
      let masterMetrics: AsaMasterMetricRow[] = [];
      let cohortMetrics: AsaCohortMetricRow[] = [];
      try {
        const payload = await fetchAsaSliceInputsWithRetry(target, date, logger);
        installsCsv = payload.installsCsv;
        eventsCsv = payload.eventsCsv;
        masterMetrics = payload.masterMetrics;
        cohortMetrics = payload.cohortMetrics;
        if (payload.recoveredByRetry) {
          recoveredSliceCount += 1;
        }
      } catch (error) {
        const requestError = normalizeAsaRequestError(error);
        sliceFailures.push({
          app_key: target.app.app_key,
          platform: target.platform,
          date,
          error: requestError.message,
          failure_kind: requestError.kind,
          retryable: requestError.scheduledRetryable
        });
        logError(logger, 'asa_keyword_slice_failed', {
          app_key: target.app.app_key,
          date,
          platform: target.platform,
          failure_kind: requestError.kind,
          retryable: requestError.scheduledRetryable,
          error: requestError.message
        });
        continue;
      }

      const installRows = toAsaInstallRows(target.app, target.platform, installsCsv);
      const eventRows = toAsaEventRows(target.app, target.platform, eventsCsv);
      const metricRows = aggregateDailyMetrics(installRows, eventRows, masterMetrics, cohortMetrics);
      const countryMetricRows = aggregateAsaCountryMetrics(installRows);
      const snapshotId = createAsaSnapshotId();

      await replaceAsaSlice({
        appKey: target.app.app_key,
        platform: target.platform,
        date,
        snapshotId,
        installRows,
        eventRows,
        metricRows,
        countryMetricRows,
        logger
      });

      installRowCount += installRows.length;
      eventRowCount += eventRows.length;
      metricRowCount += metricRows.length;
      if (env.asaKeywordRequestIntervalMs > 0 || env.asaMasterApiRequestIntervalMs > 0) {
        await sleep(Math.max(env.asaKeywordRequestIntervalMs, env.asaMasterApiRequestIntervalMs));
      }
    }
  }

  const { stateRows, recommendationRows } = await rebuildAsaKeywordStatesAndRecommendations(backfillDays, logger);

  const endedAt = new Date();
  const retryableFailedSliceCount = sliceFailures.filter((item) => item.retryable).length;
  const terminalFailedSliceCount = sliceFailures.filter((item) => !item.retryable).length;
  return {
    started_at: startedAt.toISOString(),
    ended_at: endedAt.toISOString(),
    duration_ms: endedAt.getTime() - startedAt.getTime(),
    backfill_days: backfillDays,
    install_rows: installRowCount,
    event_rows: eventRowCount,
    metric_rows: metricRowCount,
    state_rows: stateRows,
    recommendation_rows: recommendationRows,
    app_targets: targets.length,
    failed_slice_count: sliceFailures.length,
    retryable_failed_slice_count: retryableFailedSliceCount,
    terminal_failed_slice_count: terminalFailedSliceCount,
    recovered_slice_count: recoveredSliceCount
  };
}

export async function queryAsaKeywordDashboard(filter: AsaKeywordQueryFilter): Promise<AsaKeywordQueryResult> {
  await ensureAsaKeywordRoasSchema();
  const page = Math.max(1, Math.floor(filter.page ?? 1));
  const pageSize = Math.min(100, Math.max(1, Math.floor(filter.pageSize ?? 20)));
  const policyRows =
    filter.appKey && filter.platform
      ? await listRecommendationPolicyConfigs({ engine: 'asa', enabled: true })
      : [];
  const policyRecord =
    filter.appKey && filter.platform
      ? policyRows.find(
          (row) => row.app_key === filter.appKey && String(row.platform || '').toLowerCase() === String(filter.platform || '').toLowerCase()
        ) ?? null
      : null;
  const roasReferenceDate = filter.to || shiftDateString(getDailyBriefDefaultReportDate(), 0);
  const roasWindow = buildAsaRoasWindow(
    roasReferenceDate,
    policyRecord ? normalizeRecommendationPolicyRule(policyRecord.rule_json) : null
  );
  const stateResult = await queryAsaKeywordStates({
    appKey: filter.appKey,
    platform: filter.platform,
    stage: filter.stage,
    keyword: filter.keyword || filter.campaign,
    from: filter.from,
    to: filter.to,
    page,
    pageSize
  });
  const stateRows = stateResult.rows;
  const keySet = new Set(stateRows.map((row) => `${row.app_key}|${row.platform}|${row.keyword}|${row.campaign}|${row.adset}`));
  const recoRows = keySet.size
    ? await pgQuery<AsaKeywordRecommendationRow>(
        `SELECT DISTINCT ON (app_key, platform, keyword, campaign, adset)
            id, app_key, platform, keyword, campaign, adset, date, action, change_ratio, primary_metric,
            current_ecpi, current_cpp, current_d7_roas, roas_window_from, roas_window_to, roas_data_status, target_ecpi, target_cpp, target_d7_roas,
            reason_code, llm_summary, status, created_at, updated_at
           FROM asa_keyword_recommendations
          ORDER BY app_key, platform, keyword, campaign, adset, date DESC, updated_at DESC, id DESC`
      )
    : { rows: [] as AsaKeywordRecommendationRow[] };
  const recoMap = new Map(
    recoRows.rows
      .filter((row) => keySet.has(`${row.app_key}|${row.platform}|${row.keyword}|${row.campaign}|${row.adset}`))
      .map((row) => [`${row.app_key}|${row.platform}|${row.keyword}|${row.campaign}|${row.adset}`, row])
  );
  const baseSummary = await queryAsaKeywordSummary(filter);
  const matureSummary = await queryAsaKeywordSummary({
    ...filter,
    from: roasWindow.from,
    to: roasWindow.to
  });
  const summary: AsaKeywordSummary = {
    ...baseSummary,
    purchase_count: matureSummary.purchase_count,
    revenue_d7: matureSummary.revenue_d7,
    cpp: matureSummary.cpp,
    d7_roas: matureSummary.d7_roas,
    roas_data_status: matureSummary.roas_data_status,
    roas_window_from: roasWindow.from,
    roas_window_to: roasWindow.to
  };

  const rows: AsaKeywordDashboardRow[] = stateRows.map((row) => {
    const reco = recoMap.get(`${row.app_key}|${row.platform}|${row.keyword}|${row.campaign}|${row.adset}`);
    return {
      ...row,
      recommendation_id: reco?.id ?? null,
      recommendation_action: reco?.action ?? null,
      recommendation_status: reco?.status ?? null,
      primary_metric: reco?.primary_metric ?? null,
      llm_summary: reco?.llm_summary ?? {}
    };
  });

  return {
    rows,
    summary,
    summary_window: roasWindow,
    total: stateResult.total,
    page: stateResult.page,
    pageSize,
    totalPages: stateResult.totalPages
  };
}

export async function queryAsaKeywordTrend(
  appKey: string,
  platform: string,
  keyword: string,
  campaign: string,
  adset: string
): Promise<AsaKeywordDailyMetricInsertRow[]> {
  await ensureAsaKeywordMetricsSchema();
  return chQuery<AsaKeywordDailyMetricInsertRow>(
    `WITH
      ${buildLatestAsaSliceRangeCtes(ASA_KEYWORD_METRICS_TABLE, 'date')}
      SELECT
        toString(date) AS date,
        app_key,
        platform,
        keyword,
        campaign,
        adset,
        installs,
        total_cost,
        purchase_count,
        revenue_d0,
        revenue_d7,
        ecpi,
        average_ecpi,
        cpp,
        d7_roas,
        roas_source_missing,
        version
      FROM (
        SELECT *
        FROM ${ASA_KEYWORD_METRICS_TABLE} FINAL
      ) AS m
      INNER JOIN latest_slices AS s
        ON s.app_key = m.app_key
       AND s.platform = m.platform
       AND s.date = m.date
       AND s.snapshot_id = m.snapshot_id
      WHERE m.app_key = {appKey:String}
        AND m.platform = {platform:String}
        AND m.keyword = {keyword:String}
        AND m.campaign = {campaign:String}
        AND m.adset = {adset:String}
      ORDER BY date ASC`,
    { appKey, platform, keyword, campaign, adset, from: '1970-01-01', to: '2099-12-31' }
  );
}

function statusLabel(status: string | null | undefined): string {
  if (status === 'pending') return '本次新增建议';
  if (status === 'sent') return '历史已发建议';
  if (status === 'applied') return '已执行';
  if (status === 'rejected') return '已拒绝';
  if (status === 'expired') return '已过期';
  return '本次新增建议';
}

function stageTitle(stage: ProductStage | 'mixed'): string {
  if (stage === 'stable') return '稳定期';
  if (stage === 'rising') return '上升期';
  return '混合阶段';
}

function hasSpendWithoutInstalls(input: { total_cost?: number | null; installs?: number | null }): boolean {
  return Number(input.total_cost || 0) > 0 && Number(input.installs || 0) <= 0;
}

function hasCostWithoutD7Revenue(input: { total_cost?: number | null; revenue_d7?: number | null }): boolean {
  return Number(input.total_cost || 0) > 0 && Number(input.revenue_d7 || 0) <= 0;
}

function isAsaRoasPrimaryMetric(policy: RecommendationPolicyRuleJson | null, targetD7Roas: number): boolean {
  if (policy?.metric_family === 'd7_roas_cpp') {
    return true;
  }
  if (policy?.metric_family === 'relative_compare') {
    return targetD7Roas > 0 || (policy.relative_compare.metrics || []).includes('roas');
  }
  return false;
}

function formatAsaSummaryEcpi(input: { total_cost?: number | null; installs?: number | null; ecpi?: number | null }): string {
  return hasSpendWithoutInstalls(input) ? '—（有花费无安装）' : Number(input.ecpi || 0).toFixed(2);
}

function formatAsaSummaryCpp(input: {
  total_cost?: number | null;
  purchase_count?: number | null;
  cpp?: number | null;
  roas_data_status?: string | null;
}): string {
  const status = String(input.roas_data_status || 'unavailable');
  if (status === 'pending') {
    return '待补齐（源数据缺失）';
  }
  if (status === 'partial') {
    return Number(input.purchase_count || 0) > 0
      ? `$${Number(input.cpp || 0).toFixed(2)}（覆盖率达阈值，按已覆盖成本计算）`
      : Number(input.total_cost || 0) > 0
        ? '—（覆盖率达阈值，但成熟窗口无购买）'
        : '-';
  }
  if (status === 'partial_low') {
    return Number(input.purchase_count || 0) > 0
      ? `$${Number(input.cpp || 0).toFixed(2)}（覆盖率偏低，仅供参考）`
      : Number(input.total_cost || 0) > 0
        ? '—（覆盖率偏低，成熟窗口无购买）'
        : '-';
  }
  if (status === 'unavailable') {
    return Number(input.total_cost || 0) > 0 ? '暂无成熟数据' : '-';
  }
  if (Number(input.purchase_count || 0) <= 0) {
    return Number(input.total_cost || 0) > 0 ? '—（成熟窗口无购买）' : '-';
  }
  return `$${Number(input.cpp || 0).toFixed(2)}`;
}

function formatAsaSummaryRoas(input: {
  total_cost?: number | null;
  revenue_d7?: number | null;
  d7_roas?: number | null;
  roas_data_status?: string | null;
}): string {
  const status = String(input.roas_data_status || 'unavailable');
  if (status === 'pending') {
    return '待补齐（源数据缺失）';
  }
  if (status === 'partial') {
    if (Number(input.total_cost || 0) <= 0) return '-';
    const value = `${Number(input.d7_roas || 0).toFixed(2)}`;
    return hasCostWithoutD7Revenue(input)
      ? `${value}（覆盖率达阈值，按已覆盖成本计算；成熟窗口未观察到 D7 收入）`
      : `${value}（覆盖率达阈值，按已覆盖成本计算）`;
  }
  if (status === 'partial_low') {
    if (Number(input.total_cost || 0) <= 0) return '-';
    const value = `${Number(input.d7_roas || 0).toFixed(2)}`;
    return hasCostWithoutD7Revenue(input)
      ? `${value}（覆盖率偏低，仅供参考；成熟窗口未观察到 D7 收入）`
      : `${value}（覆盖率偏低，仅供参考）`;
  }
  if (status === 'unavailable') {
    return Number(input.total_cost || 0) > 0 ? '暂无成熟数据' : '-';
  }
  if (input.total_cost == null) {
    return `${Number(input.d7_roas || 0).toFixed(2)}`;
  }
  if (Number(input.total_cost || 0) <= 0) return '-';
  const value = `${Number(input.d7_roas || 0).toFixed(2)}`;
  return hasCostWithoutD7Revenue(input) ? `${value}（成熟窗口未观察到 D7 收入）` : value;
}

function metricSummaryLine(
  row: AsaKeywordRecommendationRow,
  context?: { total_cost?: number | null; installs?: number | null; revenue_d7?: number | null; purchase_count?: number | null }
): string {
  return row.primary_metric === 'd7_roas_cpp'
    ? `D7 ROAS ${formatAsaSummaryRoas({
        total_cost: context?.total_cost,
        revenue_d7: context?.revenue_d7,
        d7_roas: row.current_d7_roas,
        roas_data_status: row.roas_data_status
      })} / 目标 ${row.target_d7_roas.toFixed(2)} ｜ CPP ${formatAsaSummaryCpp({
        total_cost: context?.total_cost,
        purchase_count: context?.purchase_count,
        cpp: row.current_cpp,
        roas_data_status: row.roas_data_status
      })} / 目标 ${row.target_cpp.toFixed(2)}`
    : `eCPI ${formatAsaSummaryEcpi({
        total_cost: context?.total_cost,
        installs: context?.installs,
        ecpi: row.current_ecpi
      })} / 目标 ${row.target_ecpi.toFixed(2)}`;
}

function buildAsaTodayJudgment(
  currentStage: ProductStage | 'mixed',
  summary: AsaKeywordSummary,
  actionRows: AsaKeywordRecommendationRow[]
): string {
  const actionCount = actionRows.length;
  if (summary.total_cost <= 0) {
    return '当前未观察到有效成本，先核对 ASA 拉取日期与 AppsFlyer Master API 同步状态。';
  }
  if (summary.roas_data_status === 'pending') {
    return actionCount > 0
      ? `当前成熟窗口的 Cohort 回收数据仍在补齐，先优先处理 ${actionCount} 条建议操作，并避免把未成熟 D7 误判成真实差表现。`
      : '当前成熟窗口的 Cohort 回收数据仍在补齐，先观察 eCPI 与安装变化，待 D7 数据补齐后再做 ROAS 判断。';
  }
  if (summary.roas_data_status === 'partial') {
    return actionCount > 0
      ? `当前成熟窗口的 Cohort 覆盖率已达可采纳阈值，ROAS/CPP 按已覆盖成本计算，先处理 ${actionCount} 条建议操作并继续观察缺口补齐。`
      : '当前成熟窗口的 Cohort 覆盖率已达可采纳阈值，ROAS/CPP 按已覆盖成本计算，后续继续观察缺口是否补齐。';
  }
  if (summary.roas_data_status === 'unavailable') {
    return actionCount > 0
      ? `当前还没有可用于 ROAS 判断的成熟窗口数据，先处理 ${actionCount} 条即时建议，并继续观察后续回收。`
      : '当前还没有可用于 ROAS 判断的成熟窗口数据，先观察成本与安装表现，等待成熟窗口补齐。';
  }
  if (currentStage === 'stable') {
    return actionCount > 0
      ? `当前按稳定期口径观察 D7 ROAS 与 CPP，优先处理 ${actionCount} 条建议操作。`
      : '当前按稳定期口径观察 D7 ROAS 与 CPP，暂未发现需要执行的建议操作。';
  }
  if (currentStage === 'rising') {
    return actionCount > 0
      ? `当前按上升期口径观察 eCPI 与安装扩张效率，优先处理 ${actionCount} 条建议操作。`
      : '当前按上升期口径观察 eCPI 与安装扩张效率，暂未发现需要执行的建议操作。';
  }
  return actionCount > 0
    ? `当前存在混合阶段关键词，优先处理 ${actionCount} 条建议操作并观察成本扩张效率。`
    : '当前存在混合阶段关键词，先观察成本、安装与 D7 回收是否同步改善。';
}

function asaRouteForFilters(routes: AsaKeywordRouteRecord[], filters: { appKey?: string; platform?: string }): AsaKeywordRouteRecord | null {
  const platform = String(filters.platform || '').trim().toLowerCase();
  const appKey = String(filters.appKey || '').trim();
  const byAppPlatform = routes.find((item) => item.app_key === appKey && item.platform === platform);
  if (byAppPlatform) return byAppPlatform;
  const byApp = routes.find((item) => item.app_key === appKey && !item.platform);
  if (byApp) return byApp;
  return routes.find((item) => !item.app_key && !item.platform) ?? null;
}

function asaRouteFilters(route: AsaKeywordRouteRecord): { appKey?: string; platform?: string } {
  return {
    appKey: route.app_key ?? undefined,
    platform: route.platform ?? undefined
  };
}

function resolveAsaDispatchRouteKey(
  filters: { appKey?: string; platform?: string; routeKey?: string },
  matchedRoute: AsaKeywordRouteRecord | null
): string {
  if (filters.routeKey) {
    return filters.routeKey;
  }
  if (matchedRoute) {
    return `route:${matchedRoute.id}`;
  }
  const appKey = String(filters.appKey || '').trim();
  const platform = String(filters.platform || '').trim().toLowerCase();
  if (!appKey && !platform) {
    return 'all';
  }
  return ['scope', appKey || 'all', platform || 'all'].join(':');
}

export async function buildAsaKeywordBriefPreview(filters: AsaBriefFilters): Promise<AsaBriefPreview> {
  const result = await queryAsaKeywordDashboard({
    appKey: filters.appKey,
    platform: filters.platform,
    from: filters.reportDate,
    to: filters.reportDate,
    page: 1,
    pageSize: 100
  });
  const summaryWindow = result.summary_window ?? buildAsaRoasWindow(filters.reportDate, null);
  const briefSummary: AsaKeywordSummary = result.summary;
  const appByKey = new Map((await listApps()).map((app) => [app.app_key, app]));
  const rows = result.rows;
  const rowContextMap = new Map(rows.map((row) => [[row.app_key, row.platform, row.keyword, row.campaign, row.adset].join('|'), row] as const));
  const actionRows = (
    await queryAsaKeywordRecommendations({
      appKey: filters.appKey,
      platform: filters.platform,
      from: filters.reportDate,
      to: filters.reportDate,
      page: 1,
      pageSize: 50
    })
  ).rows
    .filter((row) => row.status === 'pending' || row.status === 'sent')
    .sort((a, b) => {
      const rank = (status: string) => (status === 'pending' ? 0 : 1);
      return rank(a.status) - rank(b.status) || b.change_ratio - a.change_ratio;
    });
  const uniqueStages = Array.from(new Set(rows.map((row) => row.current_stage)));
  const currentStage = uniqueStages.length === 1 ? uniqueStages[0] : 'mixed';
  const todayJudgment = buildAsaTodayJudgment(currentStage, result.summary, actionRows);
  const keywordOverviewRows = [...rows]
    .sort((a, b) => (b.total_cost_7d || 0) - (a.total_cost_7d || 0) || (b.installs_7d || 0) - (a.installs_7d || 0))
    .slice(0, 8);
  const title = `ASA 关键词简报｜${filters.reportDate}`;
  const lines = [
    `报告日期：${filters.reportDate}`,
    `D7 / CPP 成熟窗口：${summaryWindow.from} 至 ${summaryWindow.to}`,
    '',
    '【核心概览】',
    `- 当前阶段：${stageTitle(currentStage)}`,
    `- 关键词数：${result.summary.keyword_count}`,
    `- 核心指标：安装 ${result.summary.installs.toFixed(0)} ｜ 成本 $${result.summary.total_cost.toFixed(2)} ｜ eCPI ${formatAsaSummaryEcpi(result.summary)} ｜ CPP（成熟窗口） ${formatAsaSummaryCpp(briefSummary)} ｜ D7 ROAS（成熟窗口） ${formatAsaSummaryRoas(briefSummary)}`,
    '',
    '【今日判断】',
    `- ${todayJudgment}`,
    '',
    '【关键词概览】',
    ...(keywordOverviewRows.length > 0
      ? keywordOverviewRows.map((row) => {
          const appName = resolveProductViewName(appByKey.get(row.app_key), row.platform);
          return `- ${appName}：关键词 ${row.keyword} ｜ 广告系列 ${row.campaign} ｜ 广告组 ${row.adset} ｜ 安装 ${row.installs_7d.toFixed(0)} ｜ 成本 $${row.total_cost_7d.toFixed(2)} ｜ eCPI ${formatAsaSummaryEcpi({
            total_cost: row.total_cost_7d,
            installs: row.installs_7d,
            ecpi: row.current_ecpi
          })} ｜ D7 ROAS ${formatAsaSummaryRoas({
            total_cost: row.total_cost_7d,
            revenue_d7: row.revenue_d7_7d,
            d7_roas: row.current_d7_roas,
            roas_data_status: row.roas_data_status
          })}`;
        })
      : ['- 当前日期暂无 ASA 关键词汇总数据。']),
    '',
    '【建议操作】',
    ...(actionRows.length > 0
      ? actionRows.slice(0, 12).map((row, index) => {
          const appName = resolveProductViewName(appByKey.get(row.app_key), row.platform);
          const context = rowContextMap.get([row.app_key, row.platform, row.keyword, row.campaign, row.adset].join('|'));
          return `${index + 1}. [${statusLabel(row.status)}] ${appName} / ${row.keyword}\n   - 广告系列：${row.campaign} ｜ 广告组：${row.adset}\n   - ${metricSummaryLine(row, {
            total_cost: context?.total_cost_7d,
            installs: context?.installs_7d,
            revenue_d7: context?.revenue_d7_7d,
            purchase_count: context?.purchase_count_7d
          })}`;
        })
      : ['- 当前没有可纳入简报的建议操作。']),
    '',
    '【口径说明】',
    '- ASA 关键词成本直接来自 AppsFlyer Master API（关键词 + 广告系列 + 广告组）。',
    '- 建议操作已并入 ASA 简报，不再单独发送。',
    `- CPP 与 D7 ROAS 按成熟窗口（${summaryWindow.from} 至 ${summaryWindow.to}）汇总。`,
    '- eCPI 显示为 “—” 表示有花费无安装；D7 ROAS 显示“待补齐/暂无成熟数据”表示 Cohort 源数据尚未完整。'
  ];

  const headerTitle = filters.appKey
    ? `${title} · ${resolveProductViewName(appByKey.get(filters.appKey), filters.platform)}`
    : title;
  const card = {
    config: { wide_screen_mode: true, enable_forward: true },
    header: {
      template: currentStage === 'stable' ? 'blue' : 'orange',
      title: { tag: 'plain_text', content: headerTitle }
    },
    elements: [
      {
        tag: 'div',
        text: {
          tag: 'lark_md',
          content: `📅 **报告日期**\n${filters.reportDate}\n当前阶段：${stageTitle(currentStage)}\nD7 / CPP 成熟窗口：${summaryWindow.from} 至 ${summaryWindow.to}`
        }
      },
      {
        tag: 'div',
        fields: [
          { is_short: true, text: { tag: 'lark_md', content: `**关键词数**\n${result.summary.keyword_count}` } },
          { is_short: true, text: { tag: 'lark_md', content: `**安装量**\n${result.summary.installs.toFixed(0)}` } },
          { is_short: true, text: { tag: 'lark_md', content: `**成本**\n$${result.summary.total_cost.toFixed(2)}` } },
          { is_short: true, text: { tag: 'lark_md', content: `**eCPI**\n${formatAsaSummaryEcpi(result.summary)}` } },
          { is_short: true, text: { tag: 'lark_md', content: `**CPP（成熟窗口）**\n${formatAsaSummaryCpp(briefSummary)}` } },
          { is_short: true, text: { tag: 'lark_md', content: `**D7 ROAS（成熟窗口）**\n${formatAsaSummaryRoas(briefSummary)}` } }
        ]
      },
      { tag: 'hr' },
      { tag: 'div', text: { tag: 'lark_md', content: `🧭 **今日判断**\n${todayJudgment}` } },
      { tag: 'hr' },
      {
        tag: 'div',
        text: {
          tag: 'lark_md',
          content:
            keywordOverviewRows.length > 0
              ? `📦 **关键词概览**\n${keywordOverviewRows
                  .map((row) => {
                    const appName = resolveProductViewName(appByKey.get(row.app_key), row.platform);
                    return `- **${appName} / ${row.keyword}**\n  广告系列：${row.campaign}\n  广告组：${row.adset}\n  安装 ${row.installs_7d.toFixed(0)} ｜ 成本 $${row.total_cost_7d.toFixed(2)} ｜ eCPI ${formatAsaSummaryEcpi({
                      total_cost: row.total_cost_7d,
                      installs: row.installs_7d,
                      ecpi: row.current_ecpi
                    })} ｜ D7 ROAS ${formatAsaSummaryRoas({
                      total_cost: row.total_cost_7d,
                      revenue_d7: row.revenue_d7_7d,
                      d7_roas: row.current_d7_roas,
                      roas_data_status: row.roas_data_status
                    })}`;
                  })
                  .join('\n\n')}`
              : '📦 **关键词概览**\n当前日期暂无 ASA 关键词汇总数据。'
        }
      },
      { tag: 'hr' },
      {
        tag: 'div',
        text: {
          tag: 'lark_md',
          content:
            actionRows.length > 0
              ? `🛠️ **建议操作**\n${actionRows
                  .slice(0, 12)
                  .map((row, index) => {
                    const context = rowContextMap.get([row.app_key, row.platform, row.keyword, row.campaign, row.adset].join('|'));
                    return `${index + 1}. **[${statusLabel(row.status)}] ${resolveProductViewName(appByKey.get(row.app_key), row.platform)} / ${row.keyword}**\n   广告系列：${row.campaign}\n   广告组：${row.adset}\n   ${metricSummaryLine(row, {
                     total_cost: context?.total_cost_7d,
                     installs: context?.installs_7d,
                     revenue_d7: context?.revenue_d7_7d
                   })}`;
                  })
                  .join('\n\n')}`
              : '🛠️ **建议操作**\n当前没有可纳入简报的建议操作。'
        }
      },
      {
        tag: 'note',
        elements: [
          {
            tag: 'plain_text',
            content: `口径说明：ASA 关键词成本直接来自 AppsFlyer Master API（关键词 + 广告系列 + 广告组）。建议操作已并入 ASA 简报，不再单独发送。CPP 与 D7 ROAS 按成熟窗口（${summaryWindow.from} 至 ${summaryWindow.to}）汇总。eCPI 显示为“—”表示有花费无安装；D7 ROAS 显示“待补齐/暂无成熟数据”表示 Cohort 源数据尚未完整。`
          }
        ]
      }
    ]
  };

  return {
    report_date: filters.reportDate,
    title,
    summary: briefSummary,
    summary_window: summaryWindow,
    current_stage: currentStage,
    today_judgment: todayJudgment,
    rows,
    action_rows: actionRows,
    text: lines.join('\n'),
    feishu_card_payload: card
  };
}

export async function sendAsaKeywordBrief(
  reportDate: string,
  filters: {
    appKey?: string;
    platform?: string;
    force?: boolean;
    manualTriggered?: boolean;
    routeKey?: string;
    channelOverride?: AlertChannelConfig;
  }
): Promise<{
  ok: boolean;
  skipped: boolean;
  report: AsaBriefPreview;
  notify: { ok: boolean; status?: number; error?: string; render_mode?: 'interactive' | 'post' | 'text' | 'text_fallback' };
}> {
  const report = await buildAsaKeywordBriefPreview({ reportDate, appKey: filters.appKey, platform: filters.platform });
  const routes = await listEnabledAsaKeywordRoutes();
  const matchedRoute = asaRouteForFilters(routes, filters);
  const routeKey = resolveAsaDispatchRouteKey(filters, matchedRoute);
  const lockOwnerId = crypto.randomUUID();
  const lockName = buildAsaKeywordBriefSendLockName(reportDate, routeKey, filters);
  const lockAcquired = await tryAcquireJobLock(lockName, lockOwnerId, ASA_KEYWORD_BRIEF_SEND_LOCK_TTL_MS);
  if (!lockAcquired) {
    return { ok: true, skipped: true, report, notify: { ok: true, render_mode: 'interactive' } };
  }
  try {
    const dispatch = await getDailyBriefDispatch(reportDate, 'asa_keyword_daily', 'feishu', routeKey);
    if (dispatch?.status === 'sent' && !filters.force) {
      return { ok: true, skipped: true, report, notify: { ok: true, render_mode: 'interactive' } };
    }
    const override: AlertChannelConfig | undefined = filters.channelOverride ?? (matchedRoute
      ? {
          notify_feishu_app_id: matchedRoute.notify_feishu_app_id,
          notify_feishu_app_secret: matchedRoute.notify_feishu_app_secret,
          notify_feishu_chat_id: matchedRoute.notify_feishu_chat_id
        }
      : undefined);
    let notify = await sendFeishuInteractiveCardNotification(
      { title: report.title, text: report.text, feishuCardPayload: report.feishu_card_payload },
      override
    );
    if (!notify.ok) {
      notify = await sendAlertNotification({ title: report.title, text: report.text }, override);
    }
    await upsertDailyBriefDispatch({
      report_date: reportDate,
      kind: 'asa_keyword_daily',
      channel: 'feishu',
      route_key: routeKey,
      title: report.title,
      content: report.text,
      payload_json: {
        ...report,
        render_mode: notify.render_mode || 'text_fallback'
      },
      status: notify.ok ? 'sent' : 'failed',
      manual_triggered: filters.manualTriggered ?? false,
      last_error: notify.ok ? null : notify.error ?? null,
      sent_at: notify.ok ? new Date().toISOString() : null
    });
    if (notify.ok && report.action_rows.length > 0) {
      const rowIds = report.action_rows.filter((row) => row.status === 'pending').map((row) => row.id);
      if (rowIds.length > 0) {
        await pgQuery(`UPDATE asa_keyword_recommendations SET status = 'sent', updated_at = NOW() WHERE id = ANY($1::bigint[])`, [rowIds]);
      }
    }
    return { ok: notify.ok, skipped: false, report, notify };
  } finally {
    await releaseJobLock(lockName, lockOwnerId);
  }
}

export async function runScheduledAsaKeywordBrief(logger: LoggerLike): Promise<ScheduledAsaKeywordBriefRunSummary> {
  if (!env.asaDailyBriefEnabled) {
    logger.info?.('asa_daily_brief_disabled');
    return {
      completed: true,
      report_date: null,
      sent_count: 0,
      failed_count: 0,
      skipped_count: 1
    };
  }

  const schedule = await getPushScheduleTarget();
  const parts = getTzParts(new Date(), env.timezone);
  const currentHour = parts.hour;
  const currentMinute = parts.minute;

  if (currentHour < schedule.hour || (currentHour === schedule.hour && currentMinute < schedule.minute)) {
    logger.info?.('asa_daily_brief_skip_before_window', {
      current_hour: currentHour,
      current_minute: currentMinute,
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
  const routes = await listEnabledAsaKeywordRoutes();
  let sentCount = 0;
  let failedCount = 0;
  let skippedCount = 0;

  if (routes.length === 0) {
    const briefResult = await sendAsaKeywordBrief(reportDate, {
      force: false,
      manualTriggered: false,
      routeKey: 'all'
    });
    if (briefResult.ok && !briefResult.skipped) {
      sentCount += 1;
      logger.info?.('asa_daily_brief_sent', {
        report_date: reportDate,
        route_key: 'all',
        render_mode: briefResult.notify.render_mode || 'interactive'
      });
    } else if (briefResult.skipped) {
      skippedCount += 1;
    } else {
      failedCount += 1;
    }
    return {
      completed: failedCount === 0,
      report_date: reportDate,
      sent_count: sentCount,
      failed_count: failedCount,
      skipped_count: skippedCount
    };
  }

  for (const route of routes) {
    const override: AlertChannelConfig = {
      notify_feishu_app_id: route.notify_feishu_app_id,
      notify_feishu_app_secret: route.notify_feishu_app_secret,
      notify_feishu_chat_id: route.notify_feishu_chat_id
    };
    const routeFilters = asaRouteFilters(route);
    const briefResult = await sendAsaKeywordBrief(reportDate, {
      ...routeFilters,
      force: false,
      manualTriggered: false,
      routeKey: `route:${route.id}`,
      channelOverride: override
    });
    if (briefResult.ok && !briefResult.skipped) {
      sentCount += 1;
      logger.info?.('asa_daily_brief_route_sent', {
        report_date: reportDate,
        route_key: `route:${route.id}`,
        route_name: route.route_name
      });
    } else if (briefResult.skipped) {
      skippedCount += 1;
    } else {
      failedCount += 1;
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
