import { env } from '../config/env.js';
import { chExec, chInsertJSON, chQuery } from './clickhouse.js';
import { md5Hex } from './hash.js';
import { explainBudgetRecommendationWithLlm } from './llm.js';
import {
  getDailyBriefDispatch,
  insertLlmAuditLog,
  listApps,
  listEnabledAsaKeywordRoutes,
  listProductStageConfigs,
  queryAsaKeywordRecommendations,
  queryAsaKeywordStates,
  deleteStaleAsaKeywordRecommendations,
  deleteStaleAsaKeywordStates,
  replaceAsaKeywordRecommendationsForDate,
  upsertAsaKeywordRecommendation,
  upsertAsaKeywordState,
  upsertDailyBriefDispatch
} from './repositories.js';
import { pgQuery } from './postgres.js';
import { sendAlertNotification, sendFeishuInteractiveCardNotification, type AlertChannelConfig } from './notifier.js';
import { resolveProductViewName } from './displayName.js';
import { getDailyBriefDefaultReportDate } from './dailyBrief.js';
import { getPushScheduleTarget } from './runtimeSchedule.js';
import { buildPreviousDateList } from './businessDate.js';
import type {
  AppConfigRecord,
  AsaKeywordRecommendationRow,
  AsaKeywordRouteRecord,
  AsaKeywordStateRow,
  ProductStage
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
  ecpi: number;
  cpp: number;
  d7_roas: number;
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
}

const RAW_MEDIA_SOURCE = 'apple search ads';
const MASTER_MEDIA_SOURCE = 'apple search ads';
const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const ASA_KEYWORD_METRICS_TABLE = 'asa_keyword_daily_metrics_v2';
const ASA_SLICE_SNAPSHOT_TABLE = 'asa_slice_snapshots';

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

async function fetchRawCsv(appId: string, report: 'installs' | 'events', date: string): Promise<CsvRow[]> {
  const template = report === 'installs' ? env.rawInstallsEndpointTemplate : env.rawEventsEndpointTemplate;
  const url = template.replace('{app_id}', encodeURIComponent(appId));
  const response = await fetch(`${url}?from=${encodeURIComponent(date)}&to=${encodeURIComponent(date)}`, {
    headers: {
      Authorization: `Bearer ${env.rawDataToken}`
    }
  });
  const body = await response.text();
  if (!response.ok) {
    throw new Error(`raw_api_failed status=${response.status} body=${body.slice(0, 200)}`);
  }
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
  const response = await fetch(`https://hq1.appsflyer.com/api/master-agg-data/v4/app/${encodeURIComponent(appId)}?${params.toString()}`, {
    headers: {
      Authorization: `Bearer ${env.masterApiToken}`
    }
  });
  const body = await response.text();
  if (!response.ok) {
    throw new Error(`master_api_failed status=${response.status} body=${body.slice(0, 200)}`);
  }
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

function recommendationSummary(action: string, stage: ProductStage, currentEcpi: number, currentCpp: number, currentD7Roas: number): {
  summary_cn: string;
  risk_level: 'low' | 'medium' | 'high';
  checklist: string[];
  explanation_points: string[];
} {
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
      ]
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
    explanation_points: [`ecpi=${currentEcpi.toFixed(2)}`, `stage=${stage}`]
  };
}

async function queryAsaMetricWindow(from: string, to: string): Promise<AsaKeywordDailyMetricInsertRow[]> {
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
        m.snapshot_id AS snapshot_id,
        m.version AS version
      FROM ${ASA_KEYWORD_METRICS_TABLE} AS m FINAL
      INNER JOIN latest_slices AS s
        ON s.app_key = m.app_key
       AND s.platform = m.platform
       AND s.date = m.date
       AND s.snapshot_id = m.snapshot_id`,
    { from, to }
  );
}

async function rebuildAsaKeywordStatesAndRecommendations(backfillDays: number, logger?: LoggerLike): Promise<{
  stateRows: number;
  recommendationRows: number;
}> {
  const dates = buildDateList(Math.max(backfillDays, 14));
  const from = dates[dates.length - 1];
  const to = dates[0];
  const metrics = await queryAsaMetricWindow(from, to);
  const stageConfigs = await listProductStageConfigs();
  const appByKey = new Map((await listApps()).map((app) => [app.app_key, app]));
  const stageMap = new Map(stageConfigs.filter((item) => item.enabled).map((item) => [`${item.app_key}|${item.platform}`, item.stage]));

  const grouped = new Map<string, AsaKeywordDailyMetricInsertRow[]>();
  for (const row of metrics) {
    const key = [row.app_key, row.platform, row.keyword, row.campaign, row.adset].join('|');
    const bucket = grouped.get(key) ?? [];
    bucket.push(row);
    grouped.set(key, bucket);
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
  for (const rows of grouped.values()) {
    rows.sort((a, b) => a.date.localeCompare(b.date));
    const current = rows[rows.length - 1];
    if (!current) continue;
    const scopeKey = `${current.app_key}|${current.platform}|${current.date}`;
    if (!recommendationScopes.has(scopeKey)) {
      await replaceAsaKeywordRecommendationsForDate(current.app_key, current.platform, current.date);
      recommendationScopes.add(scopeKey);
    }
    const stage = stageMap.get(`${current.app_key}|${current.platform}`) ?? 'rising';
    const window7 = rows.slice(-7);
    const installs7d = window7.reduce((sum, row) => sum + Number(row.installs || 0), 0);
    const totalCost7d = window7.reduce((sum, row) => sum + Number(row.total_cost || 0), 0);
    const purchaseCount7d = window7.reduce((sum, row) => sum + Number(row.purchase_count || 0), 0);
    const revenueD7Window = window7.reduce((sum, row) => sum + Number(row.revenue_d7 || 0), 0);
    const currentEcpi = installs7d > 0 ? totalCost7d / installs7d : Number(current.ecpi || 0);
    const currentCpp = purchaseCount7d > 0 ? totalCost7d / purchaseCount7d : 0;
    const currentD7Roas = totalCost7d > 0 ? revenueD7Window / totalCost7d : 0;

    const peerRows = metrics.filter(
      (item) =>
        item.app_key === current.app_key &&
        item.platform === current.platform &&
        item.date === current.date &&
        Number(item.installs || 0) >= 1
    );
    const peerEcpi = peerRows.map((item) => Number(item.ecpi || 0)).filter((item) => item > 0);
    const peerCpp = peerRows.map((item) => Number(item.cpp || 0)).filter((item) => item > 0);
    const peerRoas = peerRows.map((item) => Number(item.d7_roas || 0)).filter((item) => item > 0);
    const targetEcpi = Math.max(0.01, percentile(peerEcpi, 0.4) || median(peerEcpi) || currentEcpi || 0.01);
    const targetCpp = Math.max(0.01, percentile(peerCpp, 0.4) || median(peerCpp) || currentCpp || 0.01);
    const targetD7Roas = Math.max(0.01, percentile(peerRoas, 0.6) || median(peerRoas) || currentD7Roas || 0.01);

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
      target_ecpi: targetEcpi,
      target_cpp: targetCpp,
      target_d7_roas: targetD7Roas,
      installs_7d: installs7d,
      total_cost_7d: totalCost7d,
      purchase_count_7d: purchaseCount7d,
      revenue_d7_7d: revenueD7Window,
      trend_json: buildTrendJson(rows.slice(-14))
    });
    stateRows += 1;
    const action =
      stage === 'stable'
        ? currentD7Roas < targetD7Roas * 0.85 || (currentCpp > 0 && currentCpp > targetCpp * 1.15)
          ? 'decrease'
          : currentD7Roas >= targetD7Roas && (currentCpp === 0 || currentCpp <= targetCpp)
            ? 'increase'
            : 'hold'
        : currentEcpi > targetEcpi * 1.15
          ? 'decrease'
          : currentEcpi <= targetEcpi * 0.9
            ? 'increase'
            : 'hold';

    const llmResult = recommendationSummary(action, stage, currentEcpi, currentCpp, currentD7Roas);
    await upsertAsaKeywordRecommendation({
      app_key: current.app_key,
      platform: current.platform,
      keyword: current.keyword,
      campaign: current.campaign,
      adset: current.adset,
      date: current.date,
      action,
      change_ratio: action === 'hold' ? 0 : 0.2,
      primary_metric: stage === 'stable' ? 'd7_roas_cpp' : 'ecpi',
      current_ecpi: currentEcpi,
      current_cpp: currentCpp,
      current_d7_roas: currentD7Roas,
      target_ecpi: targetEcpi,
      target_cpp: targetCpp,
      target_d7_roas: targetD7Roas,
      reason_code: stage === 'stable' ? 'stable_dual_metric' : 'rising_ecpi',
      llm_summary: llmResult,
      status: 'pending'
    });
    recommendationRows += 1;

    const llmCall = await explainBudgetRecommendationWithLlm({
      appKey: current.app_key,
      platform: current.platform,
      mediaSource: 'Apple Search Ads',
      primaryMetric: stage === 'stable' ? 'roas' : 'ecpi',
      metricMode: stage === 'stable' ? 'active' : 'active',
      keyword: current.keyword,
      matchType: 'asa',
      action: action as 'increase' | 'decrease' | 'hold' | 'pause',
      changeRatio: action === 'hold' ? 0 : 0.2,
      currentCost: totalCost7d,
      suggestedBudget: action === 'increase' ? totalCost7d * 1.2 : action === 'decrease' ? totalCost7d * 0.8 : totalCost7d,
      confidence: stage === 'stable' ? 0.88 : 0.82,
      reasonCode: stage === 'stable' ? 'stable_dual_metric' : 'rising_ecpi',
      stage,
      lastCpi: currentEcpi,
      lastInstalls: installs7d,
      lastClicks: installs7d,
      currentEcpi,
      targetEcpi,
      volumeTier: installs7d >= 30 ? 'high' : installs7d >= 15 ? 'medium' : 'low',
      last3Installs: rows.slice(-3).reduce((sum, row) => sum + Number(row.installs || 0), 0),
      last7Installs: installs7d
    });
    await insertLlmAuditLog({
      biz_type: 'asa_keyword_recommendation',
      biz_id: `${current.app_key}|${current.platform}|${current.keyword}|${current.campaign}|${current.adset}|${current.date}`,
      model: llmCall.model,
      prompt_hash: llmCall.promptHash,
      response_json: llmCall.raw,
      latency_ms: llmCall.latencyMs,
      success: llmCall.ok
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
      primary_metric: stage === 'stable' ? 'd7_roas_cpp' : 'ecpi',
      current_ecpi: currentEcpi,
      current_cpp: currentCpp,
      current_d7_roas: currentD7Roas,
      target_ecpi: targetEcpi,
      target_cpp: targetCpp,
      target_d7_roas: targetD7Roas,
      reason_code: stage === 'stable' ? 'stable_dual_metric' : 'rising_ecpi',
      llm_summary: llmCall.output,
      status: 'pending'
    });
  }

  logInfo(logger, 'asa_keyword_state_cycle_done', { state_rows: stateRows, recommendation_rows: recommendationRows });
  return { stateRows, recommendationRows };
}

function aggregateDailyMetrics(
  installRows: AsaInstallRow[],
  eventRows: AsaInAppEventRow[],
  masterRows: AsaMasterMetricRow[]
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

  for (const row of eventRows) {
    const current = ensureAccumulator(row.install_date, row.app_key, row.platform, row.keyword, row.campaign, row.adset);
    const installTime = new Date(row.install_time).getTime();
    const eventTime = new Date(row.event_time).getTime();
    const deltaMs = Number.isFinite(installTime) && Number.isFinite(eventTime) ? eventTime - installTime : Number.POSITIVE_INFINITY;
    if (row.event_revenue_usd > 0) {
      current.purchase_count += 1;
      if (deltaMs <= ONE_DAY_MS) {
        current.revenue_d0 += row.event_revenue_usd;
      }
      if (deltaMs <= 7 * ONE_DAY_MS) {
        current.revenue_d7 += row.event_revenue_usd;
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
      d7_roas: row.total_cost > 0 ? row.revenue_d7 / row.total_cost : 0,
      snapshot_id: 0,
      version: Date.now()
    };
  });
}

async function replaceAsaSlice(params: {
  appKey: string;
  platform: string;
  date: string;
  snapshotId: number;
  installRows: AsaInstallRow[];
  eventRows: AsaInAppEventRow[];
  metricRows: AsaKeywordDailyMetricInsertRow[];
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

  await chInsertJSON('asa_raw_installs', installRows);
  await chInsertJSON('asa_raw_in_app_events', eventRows);
  await chInsertJSON(ASA_KEYWORD_METRICS_TABLE, metricRows);
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
  const startedAt = new Date();
  const dates = buildDateList(backfillDays);
  const apps = await listApps();
  const targets = asaTargets(apps);
  let installRowCount = 0;
  let eventRowCount = 0;
  let metricRowCount = 0;

  for (const target of targets) {
    for (const date of dates) {
      const [installsCsv, eventsCsv, masterMetrics] = await Promise.all([
        fetchRawCsv(target.appId, 'installs', date),
        fetchRawCsv(target.appId, 'events', date),
        fetchMasterKeywordMetrics(target.appId, target.app.app_key, target.platform, date)
      ]);
      const installRows = toAsaInstallRows(target.app, target.platform, installsCsv);
      const eventRows = toAsaEventRows(target.app, target.platform, eventsCsv);
      const metricRows = aggregateDailyMetrics(installRows, eventRows, masterMetrics);
      const snapshotId = createAsaSnapshotId();

      await replaceAsaSlice({
        appKey: target.app.app_key,
        platform: target.platform,
        date,
        snapshotId,
        installRows,
        eventRows,
        metricRows,
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
    app_targets: targets.length
  };
}

export async function queryAsaKeywordDashboard(filter: AsaKeywordQueryFilter): Promise<AsaKeywordQueryResult> {
  const page = Math.max(1, Math.floor(filter.page ?? 1));
  const pageSize = Math.min(100, Math.max(1, Math.floor(filter.pageSize ?? 20)));
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
            current_ecpi, current_cpp, current_d7_roas, target_ecpi, target_cpp, target_d7_roas,
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

  const summaryWhere: string[] = [];
  const summaryParams: Record<string, unknown> = {};
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
    summaryParams.from = filter.from;
  }
  if (filter.to) {
    summaryWhere.push('m.date <= toDate({to:String})');
    summaryParams.to = filter.to;
  }
  if (filter.keyword) {
    summaryWhere.push('positionCaseInsensitive(m.keyword, {keyword:String}) > 0');
    summaryParams.keyword = filter.keyword;
  }
  if (filter.campaign) {
    summaryWhere.push('positionCaseInsensitive(m.campaign, {campaign:String}) > 0');
    summaryParams.campaign = filter.campaign;
  }
  const summaryQuery = summaryWhere.length ? `WHERE ${summaryWhere.join(' AND ')}` : '';
  const summaryRows = await chQuery<AsaKeywordSummary & { keyword_count: number }>(
    `WITH
      ${buildLatestAsaSliceRangeCtes(ASA_KEYWORD_METRICS_TABLE, 'date')}
      SELECT
        keyword_count,
        installs,
        total_cost,
        if(installs > 0, total_cost / installs, 0) AS ecpi,
        if(purchase_count > 0, total_cost / purchase_count, 0) AS cpp,
        if(total_cost > 0, revenue_d7 / total_cost, 0) AS d7_roas
      FROM (
        SELECT
          countDistinct(keyword, campaign, adset, platform, app_key) AS keyword_count,
          sum(installs) AS installs,
          sum(total_cost) AS total_cost,
          sum(purchase_count) AS purchase_count,
          sum(revenue_d7) AS revenue_d7
        FROM ${ASA_KEYWORD_METRICS_TABLE} FINAL AS m
        INNER JOIN latest_slices AS s
          ON s.app_key = m.app_key
         AND s.platform = m.platform
         AND s.date = m.date
         AND s.snapshot_id = m.snapshot_id
        ${summaryQuery}
      )`,
    summaryParams
  );
  const summary = summaryRows[0] ?? {
    keyword_count: 0,
    installs: 0,
    total_cost: 0,
    ecpi: 0,
    cpp: 0,
    d7_roas: 0
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

  return { rows, summary, total: stateResult.total, page: stateResult.page, pageSize, totalPages: stateResult.totalPages };
}

export async function queryAsaKeywordTrend(
  appKey: string,
  platform: string,
  keyword: string,
  campaign: string,
  adset: string
): Promise<AsaKeywordDailyMetricInsertRow[]> {
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
        version
      FROM ${ASA_KEYWORD_METRICS_TABLE} FINAL AS m
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
  if (status === 'pending') return '待纳入简报';
  if (status === 'sent') return '已纳入简报';
  if (status === 'applied') return '已执行';
  if (status === 'rejected') return '已拒绝';
  if (status === 'expired') return '已过期';
  return '待纳入简报';
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

function formatAsaSummaryEcpi(input: { total_cost?: number | null; installs?: number | null; ecpi?: number | null }): string {
  return hasSpendWithoutInstalls(input) ? '—（有花费无安装）' : Number(input.ecpi || 0).toFixed(2);
}

function formatAsaSummaryRoas(input: { total_cost?: number | null; revenue_d7?: number | null; d7_roas?: number | null }): string {
  if (input.total_cost == null) {
    return `${Number(input.d7_roas || 0).toFixed(2)}`;
  }
  if (Number(input.total_cost || 0) <= 0) return '-';
  const value = `${Number(input.d7_roas || 0).toFixed(2)}`;
  return hasCostWithoutD7Revenue(input) ? `${value}（未观察到 D7 收入）` : value;
}

function metricSummaryLine(
  row: AsaKeywordRecommendationRow,
  context?: { total_cost?: number | null; installs?: number | null; revenue_d7?: number | null }
): string {
  return row.primary_metric === 'd7_roas_cpp'
    ? `D7 ROAS ${formatAsaSummaryRoas({
        total_cost: context?.total_cost,
        revenue_d7: context?.revenue_d7,
        d7_roas: row.current_d7_roas
      })} / 目标 ${row.target_d7_roas.toFixed(2)} ｜ CPP ${row.current_cpp > 0 ? row.current_cpp.toFixed(2) : '-'} / 目标 ${row.target_cpp.toFixed(2)}`
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

export async function buildAsaKeywordBriefPreview(filters: AsaBriefFilters): Promise<AsaBriefPreview> {
  const result = await queryAsaKeywordDashboard({
    appKey: filters.appKey,
    platform: filters.platform,
    from: filters.reportDate,
    to: filters.reportDate,
    page: 1,
    pageSize: 100
  });
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
    '',
    '【核心概览】',
    `- 当前阶段：${stageTitle(currentStage)}`,
    `- 关键词数：${result.summary.keyword_count}`,
    `- 核心指标：安装 ${result.summary.installs.toFixed(0)} ｜ 成本 $${result.summary.total_cost.toFixed(2)} ｜ eCPI ${formatAsaSummaryEcpi(result.summary)} ｜ CPP $${result.summary.cpp.toFixed(2)} ｜ D7 ROAS ${formatAsaSummaryRoas(result.summary)}`,
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
            d7_roas: row.current_d7_roas
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
            revenue_d7: context?.revenue_d7_7d
          })}`;
        })
      : ['- 当前没有可纳入简报的建议操作。']),
    '',
    '【口径说明】',
    '- ASA 关键词成本直接来自 AppsFlyer Master API（关键词 + 广告系列 + 广告组）。',
    '- 建议操作已并入 ASA 简报，不再单独发送。',
    '- eCPI 显示为 “—” 表示有花费无安装；D7 ROAS 显示 0.00 表示当前未观察到 D7 收入。'
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
        text: { tag: 'lark_md', content: `📅 **报告日期**\n${filters.reportDate}\n当前阶段：${stageTitle(currentStage)}` }
      },
      {
        tag: 'div',
        fields: [
          { is_short: true, text: { tag: 'lark_md', content: `**关键词数**\n${result.summary.keyword_count}` } },
          { is_short: true, text: { tag: 'lark_md', content: `**安装量**\n${result.summary.installs.toFixed(0)}` } },
          { is_short: true, text: { tag: 'lark_md', content: `**成本**\n$${result.summary.total_cost.toFixed(2)}` } },
          { is_short: true, text: { tag: 'lark_md', content: `**eCPI**\n${formatAsaSummaryEcpi(result.summary)}` } },
          { is_short: true, text: { tag: 'lark_md', content: `**CPP**\n$${result.summary.cpp.toFixed(2)}` } },
          { is_short: true, text: { tag: 'lark_md', content: `**D7 ROAS**\n${formatAsaSummaryRoas(result.summary)}` } }
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
                      d7_roas: row.current_d7_roas
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
            content: '口径说明：ASA 关键词成本直接来自 AppsFlyer Master API（关键词 + 广告系列 + 广告组）。建议操作已并入 ASA 简报，不再单独发送。eCPI 显示为“—”表示有花费无安装；D7 ROAS 显示 0.00 表示当前未观察到 D7 收入。'
          }
        ]
      }
    ]
  };

  return {
    report_date: filters.reportDate,
    title,
    summary: result.summary,
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
  const routeKey = filters.routeKey ?? (matchedRoute ? `asa:${matchedRoute.route_name}` : 'asa:default');
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
}

export async function runScheduledAsaKeywordBrief(logger: LoggerLike): Promise<void> {
  if (!env.asaDailyBriefEnabled) {
    logger.info?.('asa_daily_brief_disabled');
    return;
  }

  const schedule = await getPushScheduleTarget();
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: env.timezone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  }).formatToParts(new Date());
  const currentHour = Number(parts.find((part) => part.type === 'hour')?.value ?? '0');
  const currentMinute = Number(parts.find((part) => part.type === 'minute')?.value ?? '0');

  if (currentHour < schedule.hour || (currentHour === schedule.hour && currentMinute < schedule.minute)) {
    logger.info?.('asa_daily_brief_skip_before_window', {
      current_hour: currentHour,
      current_minute: currentMinute,
      report_time: schedule.time
    });
    return;
  }

  const reportDate = getDailyBriefDefaultReportDate(new Date(), env.timezone);
  const routes = await listEnabledAsaKeywordRoutes();

  if (routes.length === 0) {
    const briefResult = await sendAsaKeywordBrief(reportDate, {
      force: false,
      manualTriggered: false,
      routeKey: 'scheduled:asa:all'
    });
    if (briefResult.ok && !briefResult.skipped) {
      logger.info?.('asa_daily_brief_sent', {
        report_date: reportDate,
        route_key: 'scheduled:asa:all',
        render_mode: briefResult.notify.render_mode || 'interactive'
      });
    }
    return;
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
      routeKey: `scheduled:asa-route:${route.id}`,
      channelOverride: override
    });
    if (briefResult.ok && !briefResult.skipped) {
      logger.info?.('asa_daily_brief_route_sent', {
        report_date: reportDate,
        route_key: `scheduled:asa-route:${route.id}`,
        route_name: route.route_name
      });
    }
  }
}
