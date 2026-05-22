import { chExec, chInsertJSON, chQuery } from './clickhouse.js';
import { fetchAppsflyerText } from './appsflyerRequest.js';
import {
  listApps,
  listKeywordExtractRules,
  listKeywordLifecycleStatesByAppPlatform,
  upsertKeywordLifecycleState
} from './repositories.js';
import { extractKeywordFromCampaign, evaluateKeywordLifecycle } from './keyword.js';
import type { AppConfigRecord, KeywordExtractRuleRecord, KeywordLifecycleStateRow } from '../types/models.js';
import { env } from '../config/env.js';
import { getDateStringInTimezone, getPreviousDateString, shiftDateString } from './businessDate.js';
import { normalizeAfCohortRoasRate, parseAfCohortD7RoasRate } from './roasWindow.js';
import { isAfWindowProvisional } from './afMetricScopes.js';
import { upsertAfOfficialSnapshot } from './appsflyerOfficialSnapshots.js';
import { getMetabaseProductPlatforms } from './metabaseAds.js';

export interface KeywordEngineLogger {
  info: (message: string, context?: Record<string, unknown>) => void;
  warn: (message: string, context?: Record<string, unknown>) => void;
  error: (message: string, context?: Record<string, unknown>) => void;
}

interface PullAggRow {
  report_date: string;
  app_key: string;
  platform: string;
  campaign: string;
  media_source: string;
  country: string;
  impressions: string;
  installs: string;
  clicks: string;
  total_cost: string;
  average_ecpi: string;
  source_report: string;
  raw_json: string;
}

interface CsvRow {
  [key: string]: string;
}

interface KeywordFactRow {
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

interface KeywordDailyAgg {
  report_date: string;
  platform: string;
  keyword: string;
  match_type: string;
  installs: number;
  clicks: number;
  total_cost: number;
  average_ecpi: number;
}

interface KeywordValueRevenueAggRow {
  install_date: string;
  app_key: string;
  platform: string;
  media_source: string;
  country: string;
  campaign: string;
  raw_event_count: number;
  purchase_count: number;
  revenue_d7: number;
  af_cohort_roas: number;
  revenue_source_complete: boolean;
  af_cohort_roas_complete: boolean;
}

interface DateWindow {
  from: string;
  to: string;
}

interface KeywordValueCostAgg {
  install_date: string;
  app_key: string;
  platform: string;
  keyword: string;
  match_type: string;
  campaign: string;
  media_source: string;
  country: string;
  impressions: number;
  installs: number;
  clicks: number;
  total_cost: number;
}

interface KeywordValueFactRow {
  install_date: string;
  app_key: string;
  platform: string;
  media_source: string;
  country: string;
  campaign: string;
  keyword: string;
  match_type: string;
  installs: number;
  total_cost: number;
  purchase_count: number;
  revenue_d7: number;
  revenue_source_missing: number;
  ctr: number;
  cvr: number;
  cpi: number;
  cpp: number;
  d7_roas: number;
  af_cohort_roas: number;
  af_cohort_roas_missing: number;
  version: number;
}

interface KeywordFactMutationScope {
  appKey: string;
  from: string;
  to: string;
  platforms: string[];
  valueFrom?: string;
  valueTo?: string;
}

export interface KeywordEngineCycleDetail {
  app_key: string;
  keyword_rows: number;
  value_rows: number;
  lifecycle_rows: number;
  status: 'ok' | 'failed' | 'skipped';
  error?: string;
}

export interface KeywordEngineCycleResult {
  started_at: string;
  ended_at: string;
  duration_ms: number;
  backfill_days: number;
  apps: number;
  success_count: number;
  failed_count: number;
  skipped_count: number;
  details: KeywordEngineCycleDetail[];
}

const DAY_MS = 24 * 60 * 60 * 1000;
// Dashboard D7 ROAS follows the AF Dashboard-compatible rolling attribution
// window. AppsFlyer mode uses Cohort API; Metabase mode uses Dashboard D7 ROI.
const KEYWORD_VALUE_FACT_ROLLING_LOOKBACK_DAYS = 7;
const KEYWORD_VALUE_COHORT_MAX_QUERY_DAYS = 7;
let ensureKeywordValueFactSchemaPromise: Promise<void> | null = null;

async function ensureKeywordValueFactSchema(): Promise<void> {
  if (!ensureKeywordValueFactSchemaPromise) {
    ensureKeywordValueFactSchemaPromise = chExec(
      `ALTER TABLE keyword_value_daily_metrics
        ADD COLUMN IF NOT EXISTS revenue_source_missing UInt8 DEFAULT 0,
        ADD COLUMN IF NOT EXISTS af_cohort_roas Float64 DEFAULT 0,
        ADD COLUMN IF NOT EXISTS af_cohort_roas_missing UInt8 DEFAULT 1`
    ).catch((error) => {
      ensureKeywordValueFactSchemaPromise = null;
      throw error;
    });
  }
  await ensureKeywordValueFactSchemaPromise;
}

function uniquePlatformsFromPullRows(rows: PullAggRow[]): string[] {
  return Array.from(
    new Set(
      rows
        .map((row) => String(row.platform || 'unknown').trim().toLowerCase() || 'unknown')
        .filter((platform) => platform.length > 0)
    )
  );
}

function resolveKeywordFactMutationPlatforms(appKey: string, rawRows: PullAggRow[], valueRows: PullAggRow[]): string[] {
  const rowPlatforms = Array.from(
    new Set([...uniquePlatformsFromPullRows(rawRows), ...uniquePlatformsFromPullRows(valueRows)])
  );
  if (rowPlatforms.length > 0) {
    return rowPlatforms;
  }
  return getMetabaseProductPlatforms(appKey);
}

async function clearKeywordFactSlices(scope: KeywordFactMutationScope): Promise<void> {
  if (scope.platforms.length === 0) {
    return;
  }
  const platforms = scope.platforms;
  const valueFrom = scope.valueFrom ?? scope.from;
  const valueTo = scope.valueTo ?? scope.to;
  const queryParams = {
    app_key: scope.appKey,
    from: scope.from,
    to: scope.to,
    value_from: valueFrom,
    value_to: valueTo,
    platforms
  };
  await chExec(
    `ALTER TABLE keyword_daily_metrics
      DELETE WHERE app_key = {app_key:String}
        AND date >= toDate({from:String})
        AND date <= toDate({to:String})
        AND has({platforms:Array(String)}, lowerUTF8(platform))
      SETTINGS mutations_sync = 2`,
    queryParams
  );
  await chExec(
    `ALTER TABLE keyword_value_daily_metrics
      DELETE WHERE app_key = {app_key:String}
        AND install_date >= toDate({value_from:String})
        AND install_date <= toDate({value_to:String})
        AND has({platforms:Array(String)}, lowerUTF8(platform))
      SETTINGS mutations_sync = 2`,
    queryParams
  );
}

function logInfo(
  logger: KeywordEngineLogger | undefined,
  message: string,
  context?: Record<string, unknown>
): void {
  if (logger) {
    logger.info(message, context);
  }
}

function logWarn(
  logger: KeywordEngineLogger | undefined,
  message: string,
  context?: Record<string, unknown>
): void {
  if (logger) {
    logger.warn(message, context);
  }
}

function logError(
  logger: KeywordEngineLogger | undefined,
  message: string,
  context?: Record<string, unknown>
): void {
  if (logger) {
    logger.error(message, context);
  }
}

function normalizeDateInput(value: string | Date): Date | null {
  if (value instanceof Date) {
    return Number.isFinite(value.getTime()) ? value : null;
  }
  const text = String(value).trim();
  if (!text) {
    return null;
  }
  const parsed = text.includes('T') ? new Date(text) : new Date(`${text}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) ? parsed : null;
}

function dateDaysDiff(from: string | Date, to: string | Date): number {
  const a = normalizeDateInput(from);
  const b = normalizeDateInput(to);
  if (!a || !b) {
    return 0;
  }
  return Math.max(0, Math.round((b.getTime() - a.getTime()) / DAY_MS));
}

function buildWindow(backfillDays: number): { from: string; to: string } {
  const safeDays = Math.max(1, Math.floor(backfillDays));
  const to = getPreviousDateString(1);
  const from = shiftDateString(to, -(safeDays - 1));
  return { from, to };
}

function toNumber(raw: string): number {
  const text = String(raw ?? '').trim();
  if (!text || text.toLowerCase() === 'n/a') {
    return 0;
  }
  const parsed = Number(text.replace(/[,$%\s]/g, ''));
  return Number.isFinite(parsed) ? parsed : 0;
}

function compareDateStrings(left: string, right: string): number {
  const leftDate = normalizeDateInput(left);
  const rightDate = normalizeDateInput(right);
  if (!leftDate || !rightDate) {
    return 0;
  }
  return leftDate.getTime() - rightDate.getTime();
}

function sleepMs(durationMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, Math.floor(durationMs))));
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
      if (row.some((cell) => cell.trim().length > 0)) {
        rows.push(row);
      }
      row = [];
      continue;
    }
    field += char;
  }

  row.push(field);
  if (row.some((cell) => cell.trim().length > 0)) {
    rows.push(row);
  }
  return rows;
}

function normalizeCsvHeader(header: string): string {
  return header
    .replace(/^\uFEFF/, '')
    .trim()
    .toLowerCase()
    .replace(/\([^)]*\)/g, ' ')
    .replace(/\s+/g, '_')
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function parseCsv(csv: string): CsvRow[] {
  const rows = parseCsvRows(csv);
  if (rows.length <= 1) {
    return [];
  }
  const headers = rows[0].map((header) => normalizeCsvHeader(header));
  return rows.slice(1).map((cols) => {
    const row: CsvRow = {};
    for (let index = 0; index < headers.length; index += 1) {
      row[headers[index]] = String(cols[index] ?? '').trim();
    }
    return row;
  });
}

function normalizeSourceDimension(value: string | undefined | null): string {
  const text = String(value ?? '').trim().toLowerCase();
  return text.length > 0 ? text : 'unknown';
}

function buildKeywordValueCohortUrl(appKey: string, appId: string): string {
  return env.cohortEndpointTemplate
    .replace('{app_key}', appKey)
    .replace('{app_id}', encodeURIComponent(appId));
}

function buildKeywordValueCohortBody(window: DateWindow, kpi: 'revenue' | 'roas'): string {
  return JSON.stringify({
    cohort_type: 'user_acquisition',
    from: window.from,
    to: window.to,
    aggregation_type: 'cumulative',
    preferred_timezone: true,
    preferred_currency: true,
    groupings: ['date', 'pid', 'c', 'geo'],
    kpis: [kpi]
  });
}

export function buildKeywordValueCohortWindows(
  valueFrom: string,
  valueTo: string,
  _reportDate: string,
  maxChunkDays = KEYWORD_VALUE_COHORT_MAX_QUERY_DAYS
): DateWindow[] {
  if (compareDateStrings(valueFrom, valueTo) > 0) {
    return [];
  }

  const chunkDays = Math.max(1, Math.floor(maxChunkDays));
  const windows: DateWindow[] = [];
  let cursor = valueFrom;
  while (compareDateStrings(cursor, valueTo) <= 0) {
    const candidateTo = shiftDateString(cursor, chunkDays - 1);
    const chunkTo = compareDateStrings(candidateTo, valueTo) <= 0 ? candidateTo : valueTo;
    windows.push({ from: cursor, to: chunkTo });
    cursor = shiftDateString(chunkTo, 1);
  }
  return windows;
}

function accumulateKeywordValueRevenueRow(
  aggregate: Map<string, KeywordValueRevenueAggRow>,
  row: KeywordValueRevenueAggRow
): void {
  const key = buildKeywordValueSourceKey({
    install_date: row.install_date,
    platform: row.platform,
    media_source: row.media_source,
    country: row.country,
    campaign: row.campaign
  });
  const existing = aggregate.get(key);
  if (existing) {
    existing.raw_event_count += row.raw_event_count;
    existing.purchase_count += row.purchase_count;
    existing.revenue_d7 += row.revenue_d7;
    existing.af_cohort_roas =
      row.af_cohort_roas_complete ? row.af_cohort_roas : existing.af_cohort_roas;
    existing.revenue_source_complete = existing.revenue_source_complete || row.revenue_source_complete;
    existing.af_cohort_roas_complete = existing.af_cohort_roas_complete || row.af_cohort_roas_complete;
    return;
  }
  aggregate.set(key, { ...row });
}

function aggregateKeywordValueRevenueRows(rows: KeywordValueRevenueAggRow[]): Map<string, KeywordValueRevenueAggRow> {
  const aggregate = new Map<string, KeywordValueRevenueAggRow>();
  for (const row of rows) {
    accumulateKeywordValueRevenueRow(aggregate, row);
  }
  return aggregate;
}

function accumulateKeywordValueRevenueGroupRow(
  aggregate: Map<string, KeywordValueRevenueAggRow>,
  row: KeywordValueRevenueAggRow
): void {
  const key = buildKeywordValueSourceGroupKey({
    install_date: row.install_date,
    platform: row.platform,
    media_source: row.media_source,
    campaign: row.campaign
  });
  const existing = aggregate.get(key);
  if (existing) {
    existing.raw_event_count += row.raw_event_count;
    existing.purchase_count += row.purchase_count;
    existing.revenue_d7 += row.revenue_d7;
    existing.af_cohort_roas =
      row.af_cohort_roas_complete ? row.af_cohort_roas : existing.af_cohort_roas;
    existing.revenue_source_complete = existing.revenue_source_complete || row.revenue_source_complete;
    existing.af_cohort_roas_complete = existing.af_cohort_roas_complete || row.af_cohort_roas_complete;
    return;
  }
  aggregate.set(key, { ...row, country: 'unknown' });
}

export function mergeKeywordValueRevenueRows(rowsList: KeywordValueRevenueAggRow[][]): KeywordValueRevenueAggRow[] {
  const merged = new Map<string, KeywordValueRevenueAggRow>();
  for (const rows of rowsList) {
    for (const [key, row] of aggregateKeywordValueRevenueRows(rows)) {
      const existing = merged.get(key);
      if (existing) {
        existing.raw_event_count += row.raw_event_count;
        existing.purchase_count += row.purchase_count;
        existing.revenue_d7 += row.revenue_d7;
        existing.af_cohort_roas =
          row.af_cohort_roas_complete ? row.af_cohort_roas : existing.af_cohort_roas;
        existing.revenue_source_complete = existing.revenue_source_complete || row.revenue_source_complete;
        existing.af_cohort_roas_complete = existing.af_cohort_roas_complete || row.af_cohort_roas_complete;
      } else {
        merged.set(key, { ...row });
      }
    }
  }
  return Array.from(merged.values());
}

function percentile50(values: number[]): number {
  if (values.length === 0) return 0;
  const arr = [...values].sort((a, b) => a - b);
  const mid = Math.floor(arr.length / 2);
  if (arr.length % 2 === 1) {
    return arr[mid];
  }
  return (arr[mid - 1] + arr[mid]) / 2;
}

async function queryPullRows(appKey: string, from: string, to: string): Promise<PullAggRow[]> {
  return chQuery<PullAggRow>(
    `SELECT
        toString(date) AS report_date,
        app_key,
        platform,
        campaign,
        media_source,
        country,
        toString(argMax(impressions, ingest_time)) AS impressions,
        toString(argMax(installs, ingest_time)) AS installs,
        toString(argMax(clicks, ingest_time)) AS clicks,
        toString(argMax(total_cost, ingest_time)) AS total_cost,
        toString(argMax(average_ecpi, ingest_time)) AS average_ecpi,
        argMax(source_report, ingest_time) AS source_report,
        argMax(raw_json, ingest_time) AS raw_json
      FROM (
        SELECT
          date,
          app_key,
          if(empty(platform), 'unknown', lowerUTF8(platform)) AS platform,
          if(empty(campaign), 'unknown', campaign) AS campaign,
          if(empty(media_source), 'unknown', media_source) AS media_source,
          if(empty(country), 'unknown', country) AS country,
          impressions,
          installs,
          clicks,
          total_cost,
          average_ecpi,
          source_report,
          raw_json,
          ingest_time
        FROM pull_aggregate_daily
        WHERE app_key = {app_key:String}
          AND date >= toDate({from:String})
          AND date <= toDate({to:String})
      )
      GROUP BY date, app_key, platform, campaign, media_source, country
      ORDER BY date ASC`,
    {
      app_key: appKey,
      from,
      to
    }
  );
}

function parseJsonObject(value: string): Record<string, unknown> {
  const text = String(value || '').trim();
  if (!text) {
    return {};
  }
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function parseMetabaseDashboardRate(value: unknown): number | null {
  if (value == null || value === '') {
    return null;
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) && value >= 0 ? value : null;
  }
  const text = String(value).trim();
  if (!text || text.toLowerCase() === 'n/a' || text === '-') {
    return null;
  }
  const parsed = Number(text.replace(/[,$%\s]/g, ''));
  if (!Number.isFinite(parsed) || parsed < 0) {
    return null;
  }
  return text.includes('%') ? parsed / 100 : parsed;
}

function buildMetabaseKeywordValueRevenueRows(rows: PullAggRow[]): KeywordValueRevenueAggRow[] {
  const aggregate = new Map<
    string,
    {
      row: KeywordValueRevenueAggRow;
      coveredCost: number;
      missingCost: number;
    }
  >();

  for (const sourceRow of rows) {
    const raw = parseJsonObject(sourceRow.raw_json);
    const d7Roas = parseMetabaseDashboardRate(raw.d7_roas);
    const totalCost = toNumber(sourceRow.total_cost);
    const key = buildKeywordValueSourceKey({
      install_date: sourceRow.report_date,
      platform: sourceRow.platform,
      media_source: sourceRow.media_source,
      country: sourceRow.country,
      campaign: sourceRow.campaign
    });
    const current =
      aggregate.get(key) ??
      {
        row: {
          install_date: sourceRow.report_date,
          app_key: sourceRow.app_key,
          platform: sourceRow.platform,
          media_source: sourceRow.media_source,
          country: sourceRow.country,
          campaign: sourceRow.campaign,
          raw_event_count: 0,
          purchase_count: toNumber(String(raw.paid_users ?? '0')),
          revenue_d7: 0,
          af_cohort_roas: 0,
          revenue_source_complete: false,
          af_cohort_roas_complete: false
        },
        coveredCost: 0,
        missingCost: 0
      };

    current.row.purchase_count += aggregate.has(key) ? toNumber(String(raw.paid_users ?? '0')) : 0;
    if (totalCost > 0 && d7Roas != null) {
      current.coveredCost += totalCost;
      current.row.revenue_d7 += totalCost * d7Roas;
    } else if (totalCost > 0) {
      current.missingCost += totalCost;
    }
    if (!aggregate.has(key)) {
      aggregate.set(key, current);
    }
  }

  return Array.from(aggregate.values()).map((item) => ({
    ...item.row,
    af_cohort_roas: item.coveredCost > 0 ? item.row.revenue_d7 / item.coveredCost : 0,
    revenue_source_complete: item.coveredCost > 0 && item.missingCost === 0,
    af_cohort_roas_complete: item.coveredCost > 0 && item.missingCost === 0
  }));
}

function keywordValueRevenueExactKey(row: Pick<KeywordValueRevenueAggRow, 'install_date' | 'platform' | 'media_source' | 'country' | 'campaign'>): string {
  return buildKeywordValueSourceKey({
    install_date: row.install_date,
    platform: row.platform,
    media_source: row.media_source,
    country: row.country,
    campaign: row.campaign
  });
}

function mergeMetabaseKeywordValueWithAfFallback(
  metabaseRows: KeywordValueRevenueAggRow[],
  afFallbackRows: KeywordValueRevenueAggRow[]
): KeywordValueRevenueAggRow[] {
  const merged = new Map<string, KeywordValueRevenueAggRow>();
  for (const row of metabaseRows) {
    merged.set(keywordValueRevenueExactKey(row), { ...row });
  }
  for (const fallbackRow of afFallbackRows) {
    const key = keywordValueRevenueExactKey(fallbackRow);
    const existing = merged.get(key);
    if (!existing) {
      merged.set(key, { ...fallbackRow });
      continue;
    }
    if (!existing.af_cohort_roas_complete && fallbackRow.af_cohort_roas_complete) {
      existing.raw_event_count = fallbackRow.raw_event_count;
      existing.purchase_count = fallbackRow.purchase_count;
      existing.revenue_d7 = fallbackRow.revenue_d7;
      existing.af_cohort_roas = fallbackRow.af_cohort_roas;
      existing.revenue_source_complete = fallbackRow.revenue_source_complete;
      existing.af_cohort_roas_complete = true;
    }
  }
  return Array.from(merged.values());
}

function parseKeywordValueCohortRows(
  appKey: string,
  platform: string,
  rows: CsvRow[],
  kpi: 'revenue' | 'roas'
): KeywordValueRevenueAggRow[] {
  return rows.map((row) => {
    const roasRate = kpi === 'roas' ? parseAfCohortD7RoasRate(row) : null;
    return {
      install_date: String(row.date || '').trim(),
      app_key: appKey,
      platform: platform.toLowerCase(),
      media_source: String(row.pid || 'unknown').trim() || 'unknown',
      country: String(row.geo || 'unknown').trim() || 'unknown',
      campaign: String(row.c || 'unknown').trim() || 'unknown',
      raw_event_count: kpi === 'revenue' ? toNumber(row.revenue_count_day_7 || '0') : 0,
      purchase_count: kpi === 'revenue' ? toNumber(row.revenue_count_day_7 || '0') : 0,
      revenue_d7: kpi === 'revenue' ? toNumber(row.revenue_sum_day_7 || '0') : 0,
      af_cohort_roas: roasRate == null ? 0 : normalizeAfCohortRoasRate(roasRate),
      revenue_source_complete: kpi === 'revenue',
      af_cohort_roas_complete: roasRate != null
    };
  });
}

async function recordKeywordValueCohortRoasSnapshot(input: {
  app: AppConfigRecord;
  platform: string;
  appId: string;
  window: DateWindow;
  rowCount: number;
  logger?: KeywordEngineLogger;
}): Promise<void> {
  try {
    await upsertAfOfficialSnapshot({
      metricScope: 'dashboard_d7_roas',
      sourceSurface: 'cohort_api',
      sourceApi: 'cohort_api',
      appKey: input.app.app_key,
      platform: input.platform,
      appId: input.appId,
      windowFrom: input.window.from,
      windowTo: input.window.to,
      timezone: 'preferred',
      currency: 'preferred',
      queryParams: {
        cohort_type: 'user_acquisition',
        from: input.window.from,
        to: input.window.to,
        aggregation_type: 'cumulative',
        preferred_timezone: true,
        preferred_currency: true,
        groupings: ['date', 'pid', 'c', 'geo'],
        kpis: ['roas']
      },
      rowCount: input.rowCount,
      isProvisional: isAfWindowProvisional(input.window.to),
      metadataJson: {
        metric: 'd7_roas',
        source: 'AppsFlyer Cohort API roas KPI (legacy AppsFlyer source)'
      }
    });
  } catch (error) {
    logWarn(input.logger, 'keyword_engine_cohort_roas_snapshot_record_failed', {
      app_key: input.app.app_key,
      platform: input.platform,
      app_id: input.appId,
      from: input.window.from,
      to: input.window.to,
      error: error instanceof Error ? error.message : String(error)
    });
  }
}

async function queryKeywordValueCohortRows(
  app: AppConfigRecord,
  platform: string,
  appId: string,
  windows: DateWindow[],
  logger?: KeywordEngineLogger
): Promise<KeywordValueRevenueAggRow[]> {
  if (windows.length === 0) {
    return [];
  }
  const url = buildKeywordValueCohortUrl(app.app_key, appId);
  const mergedRows: KeywordValueRevenueAggRow[] = [];
  const failedWindows: Array<{ window: DateWindow; error: unknown }> = [];
  for (let index = 0; index < windows.length; index += 1) {
    const window = windows[index];
    if (index > 0) {
      await sleepMs(env.cohortRequestIntervalMs);
    }
    try {
      const revenueCsv = await fetchAppsflyerText(url, {
        headers: {
          Authorization: `Bearer ${env.masterApiToken}`,
          'Content-Type': 'application/json',
          Accept: 'text/csv'
        },
        timeoutMs: env.cohortRequestTimeoutMs,
        label: 'cohort_api',
        method: 'POST',
        body: buildKeywordValueCohortBody(window, 'revenue')
      });
      await sleepMs(env.cohortRequestIntervalMs);
      const roasCsv = await fetchAppsflyerText(url, {
        headers: {
          Authorization: `Bearer ${env.masterApiToken}`,
          'Content-Type': 'application/json',
          Accept: 'text/csv'
        },
        timeoutMs: env.cohortRequestTimeoutMs,
        label: 'cohort_api',
        method: 'POST',
        body: buildKeywordValueCohortBody(window, 'roas')
      });
      const windowRows = mergeKeywordValueRevenueRows([
        parseKeywordValueCohortRows(app.app_key, platform, parseCsv(revenueCsv), 'revenue'),
        parseKeywordValueCohortRows(app.app_key, platform, parseCsv(roasCsv), 'roas')
      ]);
      mergedRows.push(...windowRows);
      await recordKeywordValueCohortRoasSnapshot({
        app,
        platform,
        appId,
        window,
        rowCount: windowRows.filter((row) => row.af_cohort_roas_complete).length,
        logger
      });
    } catch (error) {
      failedWindows.push({ window, error });
      logWarn(logger, 'keyword_engine_value_metrics_cohort_window_failed', {
        app_key: app.app_key,
        platform,
        app_id: appId,
        from: window.from,
        to: window.to,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }
  if (mergedRows.length === 0 && failedWindows.length > 0) {
    throw failedWindows[0].error instanceof Error ? failedWindows[0].error : new Error(String(failedWindows[0].error));
  }
  return mergeKeywordValueRevenueRows([mergedRows]);
}

function buildKeywordFactRows(
  appKey: string,
  rows: PullAggRow[],
  version: number,
  rulesByApp: Map<string, KeywordExtractRuleRecord[]>
): KeywordFactRow[] {
  const rules = rulesByApp.get(appKey) ?? [];
  const aggregate = new Map<string, KeywordFactRow>();

  for (const row of rows) {
    const extracted = extractKeywordFromCampaign(row.campaign, rules);
    const date = row.report_date;
    const platform = row.platform || 'unknown';
    const campaign = row.campaign || 'unknown';
    const mediaSource = row.media_source || 'unknown';
    const country = row.country || 'unknown';
    const installs = toNumber(row.installs);
    const clicks = toNumber(row.clicks);
    const totalCost = toNumber(row.total_cost);
    const averageEcpi = toNumber(row.average_ecpi);
    const key = [
      date,
      appKey,
      platform,
      extracted.keyword,
      extracted.matchType,
      campaign,
      mediaSource,
      country
    ].join('|');

    const existing = aggregate.get(key);
    if (existing) {
      const mergedInstalls = existing.installs + installs;
      existing.af_average_ecpi =
        mergedInstalls > 0
          ? (existing.af_average_ecpi * existing.installs + averageEcpi * installs) / mergedInstalls
          : 0;
      existing.installs += installs;
      existing.clicks += clicks;
      existing.total_cost += totalCost;
      continue;
    }

    aggregate.set(key, {
      date,
      app_key: appKey,
      platform,
      keyword: extracted.keyword,
      match_type: extracted.matchType,
      campaign,
      media_source: mediaSource,
      country,
      installs,
      clicks,
      total_cost: totalCost,
      cpi: 0,
      af_average_ecpi: averageEcpi,
      cvr: 0,
      source_report: row.source_report || 'daily_report_v5',
      version
    });
  }

  const out = Array.from(aggregate.values());
  for (const row of out) {
    row.cpi = row.installs > 0 ? row.total_cost / row.installs : 0;
    row.cvr = row.clicks > 0 ? row.installs / row.clicks : 0;
  }
  return out;
}

function buildKeywordValueSourceKey(input: {
  install_date: string;
  platform: string;
  media_source: string;
  country: string;
  campaign: string;
}): string {
  return [
    input.install_date,
    normalizeSourceDimension(input.platform),
    normalizeSourceDimension(input.media_source),
    normalizeSourceDimension(input.country),
    normalizeSourceDimension(input.campaign)
  ].join('|');
}

function buildKeywordValueSourceGroupKey(input: {
  install_date: string;
  platform: string;
  media_source: string;
  campaign: string;
}): string {
  return [
    input.install_date,
    normalizeSourceDimension(input.platform),
    normalizeSourceDimension(input.media_source),
    normalizeSourceDimension(input.campaign)
  ].join('|');
}

export function buildKeywordValueRows(
  appKey: string,
  rows: PullAggRow[],
  revenueRows: KeywordValueRevenueAggRow[],
  version: number,
  rulesByApp: Map<string, KeywordExtractRuleRecord[]>
): KeywordValueFactRow[] {
  const rules = rulesByApp.get(appKey) ?? [];
  const revenueMap = new Map<string, KeywordValueRevenueAggRow>();
  const revenueAllCountriesMap = new Map<string, KeywordValueRevenueAggRow>();
  for (const row of revenueRows) {
    revenueMap.set(
      buildKeywordValueSourceKey({
        install_date: row.install_date,
        platform: row.platform,
        media_source: row.media_source,
        country: row.country,
        campaign: row.campaign
      }),
      row
    );
    accumulateKeywordValueRevenueGroupRow(revenueAllCountriesMap, row);
  }

  const aggregate = new Map<string, KeywordValueCostAgg>();
  const pullCountryGroupStats = new Map<string, { hasPreciseCountry: boolean }>();
  for (const row of rows) {
    const extracted = extractKeywordFromCampaign(row.campaign, rules);
    const installDate = row.report_date;
    const platform = row.platform || 'unknown';
    const campaign = row.campaign || 'unknown';
    const mediaSource = row.media_source || 'unknown';
    const country = row.country || 'unknown';
    const sourceGroupKey = buildKeywordValueSourceGroupKey({
      install_date: installDate,
      platform,
      media_source: mediaSource,
      campaign
    });
    const existingGroupStats = pullCountryGroupStats.get(sourceGroupKey);
    if (existingGroupStats) {
      existingGroupStats.hasPreciseCountry ||= normalizeSourceDimension(country) !== 'unknown';
    } else {
      pullCountryGroupStats.set(sourceGroupKey, {
        hasPreciseCountry: normalizeSourceDimension(country) !== 'unknown'
      });
    }
    const key = [
      installDate,
      appKey,
      platform,
      extracted.keyword,
      extracted.matchType,
      campaign,
      mediaSource,
      country
    ].join('|');
    const impressions = toNumber(row.impressions);
    const installs = toNumber(row.installs);
    const clicks = toNumber(row.clicks);
    const totalCost = toNumber(row.total_cost);
    const existing = aggregate.get(key);
    if (existing) {
      existing.impressions += impressions;
      existing.installs += installs;
      existing.clicks += clicks;
      existing.total_cost += totalCost;
      continue;
    }

    aggregate.set(key, {
      install_date: installDate,
      app_key: appKey,
      platform,
      keyword: extracted.keyword,
      match_type: extracted.matchType,
      campaign,
      media_source: mediaSource,
      country,
      impressions,
      installs,
      clicks,
      total_cost: totalCost
    });
  }

  return Array.from(aggregate.values()).flatMap((row) => {
    const exactRevenue = revenueMap.get(
      buildKeywordValueSourceKey({
        install_date: row.install_date,
        platform: row.platform,
        media_source: row.media_source,
        country: row.country,
        campaign: row.campaign
      })
    );
    const sourceGroupKey = buildKeywordValueSourceGroupKey({
      install_date: row.install_date,
      platform: row.platform,
      media_source: row.media_source,
      campaign: row.campaign
    });
    const hasPreciseCountry = pullCountryGroupStats.get(sourceGroupKey)?.hasPreciseCountry ?? false;
    const revenue =
      normalizeSourceDimension(row.country) === 'unknown' && !hasPreciseCountry
        ? revenueAllCountriesMap.get(sourceGroupKey) ?? exactRevenue
        : exactRevenue;
    const revenueSourceMissing = revenue?.revenue_source_complete ? 0 : 1;
    const afCohortRoasMissing = revenue?.af_cohort_roas_complete ? 0 : 1;
    const purchaseCount = revenue ? revenue.purchase_count : 0;
    const revenueD7 = revenue ? revenue.revenue_d7 : 0;
    const afCohortRoas = afCohortRoasMissing === 0 ? Number(revenue?.af_cohort_roas || 0) : 0;
    return [
      {
        install_date: row.install_date,
        app_key: row.app_key,
        platform: row.platform,
        media_source: row.media_source,
        country: row.country,
        campaign: row.campaign,
        keyword: row.keyword,
        match_type: row.match_type,
        installs: row.installs,
        total_cost: row.total_cost,
        purchase_count: purchaseCount,
        revenue_d7: revenueD7,
        revenue_source_missing: revenueSourceMissing,
        ctr: row.impressions > 0 ? row.clicks / row.impressions : 0,
        cvr: row.clicks > 0 ? row.installs / row.clicks : 0,
        cpi: row.installs > 0 ? row.total_cost / row.installs : 0,
        cpp: purchaseCount > 0 ? row.total_cost / purchaseCount : 0,
        // Keep the local revenue / cost ratio as the shadow validation value.
        d7_roas: revenueSourceMissing === 0 && row.total_cost > 0 ? revenueD7 / row.total_cost : 0,
        af_cohort_roas: afCohortRoas,
        af_cohort_roas_missing: afCohortRoasMissing,
        version
      }
    ];
  });
}

async function queryKeywordHistory(appKey: string, platform: string, days: number): Promise<KeywordDailyAgg[]> {
  const window = Math.max(1, Math.floor(days));
  const today = getDateStringInTimezone(new Date(), env.timezone);
  const from = shiftDateString(today, -window);
  const to = shiftDateString(today, -1);
  return chQuery<KeywordDailyAgg>(
    `SELECT
        report_date,
        platform,
        keyword,
        match_type,
        sum(installs_raw) AS installs,
        sum(clicks_raw) AS clicks,
        sum(total_cost_raw) AS total_cost,
        if(
          sum(installs_raw) > 0,
          sum(ecpi_weight) / sum(installs_raw),
          0
        ) AS average_ecpi
      FROM (
        SELECT
          toString(date) AS report_date,
          platform,
          keyword,
          match_type,
          toFloat64(installs) AS installs_raw,
          toFloat64(clicks) AS clicks_raw,
          toFloat64(total_cost) AS total_cost_raw,
          toFloat64(af_average_ecpi) * toFloat64(installs) AS ecpi_weight
        FROM keyword_daily_metrics FINAL
        WHERE app_key = {app_key:String}
          AND platform = {platform:String}
          AND date >= toDate({from:String})
          AND date <= toDate({to:String})
      )
      GROUP BY report_date, platform, keyword, match_type
      ORDER BY keyword ASC, match_type ASC, report_date ASC`,
    { app_key: appKey, platform, from, to }
  );
}

function sumRange(rows: KeywordDailyAgg[], startIdx: number, endIdx: number, field: keyof KeywordDailyAgg): number {
  let total = 0;
  for (let i = startIdx; i <= endIdx; i += 1) {
    const row = rows[i];
    if (!row) continue;
    total += Number(row[field] ?? 0);
  }
  return total;
}

function buildHistoryMetrics(rows: KeywordDailyAgg[]): {
  firstSeen: string;
  lastSeen: string;
  lastInstalls: number;
  lastClicks: number;
  lastCost: number;
  lastCpi: number;
  lastOfficialEcpi: number;
  last7Installs: number;
  last7Clicks: number;
  last7Cost: number;
  last7OfficialEcpi: number;
  last7Cvr: number;
  last3Installs: number;
  last3OfficialEcpi: number;
  prev3Installs: number;
  points: Array<{ date: string; installs: number; clicks: number; total_cost: number; average_ecpi: number }>;
} {
  const sorted = [...rows].sort((a, b) => a.report_date.localeCompare(b.report_date));
  const firstSeen = sorted[0].report_date;
  const lastSeen = sorted[sorted.length - 1].report_date;
  const last = sorted[sorted.length - 1];
  const start7 = Math.max(0, sorted.length - 7);
  const start3 = Math.max(0, sorted.length - 3);
  const prev3Start = Math.max(0, sorted.length - 6);
  const prev3End = Math.max(-1, sorted.length - 4);

  const last7Installs = sumRange(sorted, start7, sorted.length - 1, 'installs');
  const last7Clicks = sumRange(sorted, start7, sorted.length - 1, 'clicks');
  const last7Cost = sumRange(sorted, start7, sorted.length - 1, 'total_cost');
  const last7OfficialEcpi =
    last7Installs > 0
      ? sorted.slice(start7).reduce((sum, item) => sum + Number(item.average_ecpi ?? 0) * Number(item.installs ?? 0), 0) /
        last7Installs
      : 0;
  const last3Installs = sumRange(sorted, start3, sorted.length - 1, 'installs');
  const last3OfficialEcpi =
    last3Installs > 0
      ? sorted.slice(start3).reduce((sum, item) => sum + Number(item.average_ecpi ?? 0) * Number(item.installs ?? 0), 0) /
        last3Installs
      : 0;
  const prev3Installs = prev3End >= 0 ? sumRange(sorted, prev3Start, prev3End, 'installs') : 0;

  return {
    firstSeen,
    lastSeen,
    lastInstalls: Number(last.installs ?? 0),
    lastClicks: Number(last.clicks ?? 0),
    lastCost: Number(last.total_cost ?? 0),
    lastCpi: Number(last.installs ?? 0) > 0 ? Number(last.total_cost ?? 0) / Number(last.installs ?? 0) : 0,
    lastOfficialEcpi: Number(last.average_ecpi ?? 0),
    last7Installs,
    last7Clicks,
    last7Cost,
    last7OfficialEcpi,
    last7Cvr: last7Clicks > 0 ? last7Installs / last7Clicks : 0,
    last3Installs,
    last3OfficialEcpi,
    prev3Installs,
    points: sorted.map((item) => ({
      date: item.report_date,
      installs: Number(item.installs ?? 0),
      clicks: Number(item.clicks ?? 0),
      total_cost: Number(item.total_cost ?? 0),
      average_ecpi: Number(item.average_ecpi ?? 0)
    }))
  };
}

function computeDaysInStage(
  previous: KeywordLifecycleStateRow | undefined,
  stage: string,
  currentLastSeen: string
): number {
  if (!previous || previous.current_stage !== stage) {
    return 1;
  }
  const gap = dateDaysDiff(previous.last_seen_date, currentLastSeen);
  const previousDays = Number(previous.days_in_stage);
  if (!Number.isFinite(previousDays)) {
    return Math.max(1, gap + 1);
  }
  return Math.max(1, Math.floor(previousDays + gap));
}

async function computeLifecycleStates(
  appKey: string,
  platform: string,
  lifecycleLookbackDays: number
): Promise<number> {
  const historyRows = await queryKeywordHistory(appKey, platform, lifecycleLookbackDays);
  if (historyRows.length === 0) {
    return 0;
  }

  const grouped = new Map<string, KeywordDailyAgg[]>();
  for (const row of historyRows) {
    const key = `${row.keyword}|${row.match_type}`;
    const list = grouped.get(key);
    if (list) {
      list.push(row);
    } else {
      grouped.set(key, [row]);
    }
  }

  const previousStates = await listKeywordLifecycleStatesByAppPlatform(appKey, platform);
  const previousMap = new Map<string, KeywordLifecycleStateRow>();
  for (const row of previousStates) {
    previousMap.set(`${row.keyword}|${row.match_type}`, row);
  }

  const cpiSeries: number[] = [];
  const cvrSeries: number[] = [];
  const metricsMap = new Map<string, ReturnType<typeof buildHistoryMetrics>>();

  for (const [key, rows] of grouped.entries()) {
    const metrics = buildHistoryMetrics(rows);
    metricsMap.set(key, metrics);
    cpiSeries.push(metrics.lastCpi);
    cvrSeries.push(metrics.last7Cvr);
  }

  const baselineCpi = percentile50(cpiSeries.filter((item) => item > 0));
  const baselineCvr = percentile50(cvrSeries.filter((item) => item > 0));
  let upserted = 0;

  for (const [key, metrics] of metricsMap.entries()) {
    const [keyword, matchType] = key.split('|');
    const daysActive = dateDaysDiff(metrics.firstSeen, metrics.lastSeen) + 1;
    const stageEval = evaluateKeywordLifecycle({
      daysActive,
      lastCpi: metrics.lastCpi,
      lastInstalls: metrics.lastInstalls,
      lastClicks: metrics.lastClicks,
      last7Installs: metrics.last7Installs,
      last7Clicks: metrics.last7Clicks,
      last7Cost: metrics.last7Cost,
      last7Cvr: metrics.last7Cvr,
      last3Installs: metrics.last3Installs,
      prev3Installs: metrics.prev3Installs,
      appBaselineCpi: baselineCpi,
      appBaselineCvr: baselineCvr
    });
    const previous = previousMap.get(key);
    const daysInStage = computeDaysInStage(previous, stageEval.stage, metrics.lastSeen);
    const trendJson = {
      reason_code: stageEval.reasonCode,
      baseline_cpi: baselineCpi,
      baseline_cvr: baselineCvr,
      official_ecpi: {
        last: metrics.lastOfficialEcpi,
        last3_avg: metrics.last3OfficialEcpi,
        last7_avg: metrics.last7OfficialEcpi
      },
      last3_installs: metrics.last3Installs,
      last7: {
        installs: metrics.last7Installs,
        clicks: metrics.last7Clicks,
        total_cost: metrics.last7Cost,
        cvr: metrics.last7Cvr
      },
      recent_points: metrics.points.slice(-7)
    };

    await upsertKeywordLifecycleState({
      app_key: appKey,
      platform,
      keyword,
      match_type: matchType || 'unknown',
      current_stage: stageEval.stage,
      stage_score: stageEval.stageScore,
      first_seen_date: metrics.firstSeen,
      last_seen_date: metrics.lastSeen,
      days_in_stage: daysInStage,
      last_cpi: metrics.lastCpi,
      last_installs: metrics.lastInstalls,
      last_clicks: metrics.lastClicks,
      trend_json: trendJson
    });
    upserted += 1;
  }

  return upserted;
}

export async function runKeywordEngineCycle(
  backfillDays: number,
  logger?: KeywordEngineLogger
): Promise<KeywordEngineCycleResult> {
  const startedAt = new Date();
  const version = Date.now();
  const { from, to } = buildWindow(backfillDays);
  const { from: valueFrom, to: valueTo } = buildWindow(
    Math.max(KEYWORD_VALUE_FACT_ROLLING_LOOKBACK_DAYS, Math.max(1, Math.floor(backfillDays)))
  );
  const apps = await listApps();
  const rules = await listKeywordExtractRules();
  const rulesByApp = new Map<string, KeywordExtractRuleRecord[]>();
  for (const rule of rules) {
    const list = rulesByApp.get(rule.app_key);
    if (list) {
      list.push(rule);
    } else {
      rulesByApp.set(rule.app_key, [rule]);
    }
  }

  logInfo(logger, 'keyword_engine_cycle_started', {
    backfill_days: backfillDays,
    from,
    to,
    value_from: valueFrom,
    value_to: valueTo,
    apps: apps.length
  });
  await ensureKeywordValueFactSchema();

  const details: KeywordEngineCycleDetail[] = [];
  const lifecycleLookbackDays = Math.max(
    Math.max(1, Math.floor(backfillDays)),
    Math.max(1, Math.floor(env.keywordEngineInitialBackfillDays))
  );

  for (const app of apps) {
    try {
      const requiresWideValueWindow = valueFrom !== from || valueTo !== to;
      const [rawRows, valueWindowPullRows] = await Promise.all([
        queryPullRows(app.app_key, from, to),
        requiresWideValueWindow ? queryPullRows(app.app_key, valueFrom, valueTo) : Promise.resolve([])
      ]);
      const valuePullRows = requiresWideValueWindow ? valueWindowPullRows : rawRows;
      if (env.adsDailySource === 'metabase') {
        await clearKeywordFactSlices({
          appKey: app.app_key,
          from,
          to,
          valueFrom,
          valueTo,
          platforms: resolveKeywordFactMutationPlatforms(app.app_key, rawRows, valuePullRows)
        });
      }
      if (rawRows.length === 0 && valuePullRows.length === 0) {
        details.push({
          app_key: app.app_key,
          keyword_rows: 0,
          value_rows: 0,
          lifecycle_rows: 0,
          status: 'skipped'
        });
        continue;
      }

      let lifecycleRows = 0;
      let keywordRows: KeywordFactRow[] = [];
      if (rawRows.length > 0) {
        keywordRows = buildKeywordFactRows(app.app_key, rawRows, version, rulesByApp);
        await chInsertJSON('keyword_daily_metrics', keywordRows);
        const platforms = new Set(
          keywordRows.map((item) => (item.platform || 'unknown').toLowerCase()).filter((item) => item.length > 0)
        );
        for (const platform of platforms) {
          lifecycleRows += await computeLifecycleStates(app.app_key, platform, lifecycleLookbackDays);
        }
      }

      let cohortValueRows: KeywordValueRevenueAggRow[] = [];
      if (env.adsDailySource === 'metabase') {
        // Metabase mode already writes AF Dashboard-compatible D7 ROI into
        // pull_aggregate_daily.raw_json. Only missing Dashboard D7 ROI slices
        // are filled from the legacy AppsFlyer Cohort API fallback.
        const metabaseValueRows = buildMetabaseKeywordValueRevenueRows(valuePullRows);
        cohortValueRows = metabaseValueRows;
        if (env.adsDailyAfFallbackEnabled && metabaseValueRows.some((row) => !row.af_cohort_roas_complete)) {
          const cohortWindows = buildKeywordValueCohortWindows(valueFrom, valueTo, to);
          const missingPlatforms = new Set(
            metabaseValueRows
              .filter((row) => !row.af_cohort_roas_complete)
              .map((row) => String(row.platform || 'unknown').toLowerCase())
          );
          const cohortTargets: Array<{ platform: string; appId: string }> = [];
          if (app.ios_pull_app_id && missingPlatforms.has('ios')) {
            cohortTargets.push({ platform: 'ios', appId: app.ios_pull_app_id });
          }
          if (app.android_pull_app_id && missingPlatforms.has('android')) {
            cohortTargets.push({ platform: 'android', appId: app.android_pull_app_id });
          }
          const afFallbackRows: KeywordValueRevenueAggRow[] = [];
          for (const target of cohortTargets) {
            try {
              afFallbackRows.push(...(await queryKeywordValueCohortRows(app, target.platform, target.appId, cohortWindows, logger)));
            } catch (error) {
              logWarn(logger, 'keyword_engine_value_metrics_af_fallback_failed', {
                app_key: app.app_key,
                platform: target.platform,
                app_id: target.appId,
                value_from: valueFrom,
                value_to: valueTo,
                error: error instanceof Error ? error.message : String(error)
              });
            }
          }
          if (afFallbackRows.length > 0) {
            cohortValueRows = mergeMetabaseKeywordValueWithAfFallback(metabaseValueRows, afFallbackRows);
          }
        }
      } else {
        const cohortWindows = buildKeywordValueCohortWindows(valueFrom, valueTo, to);
        const valuePlatforms = new Set(valuePullRows.map((row) => String(row.platform || 'unknown').toLowerCase()));
        const cohortTargets: Array<{ platform: string; appId: string }> = [];
        if (app.ios_pull_app_id && valuePlatforms.has('ios')) {
          cohortTargets.push({ platform: 'ios', appId: app.ios_pull_app_id });
        }
        if (app.android_pull_app_id && valuePlatforms.has('android')) {
          cohortTargets.push({ platform: 'android', appId: app.android_pull_app_id });
        }
        for (const target of cohortTargets) {
          try {
            cohortValueRows.push(...(await queryKeywordValueCohortRows(app, target.platform, target.appId, cohortWindows, logger)));
          } catch (error) {
            logWarn(logger, 'keyword_engine_value_metrics_cohort_failed', {
              app_key: app.app_key,
              platform: target.platform,
              app_id: target.appId,
              value_from: valueFrom,
              value_to: valueTo,
              official_roas_windows: cohortWindows.length,
              error: error instanceof Error ? error.message : String(error)
            });
          }
        }
      }

      if (cohortValueRows.length === 0 && valuePullRows.length > 0) {
        logWarn(logger, 'keyword_engine_value_metrics_source_missing', {
          app_key: app.app_key,
          value_from: valueFrom,
          value_to: valueTo,
          source: env.adsDailySource === 'metabase' ? 'metabase_dashboard_d7_roi' : 'appsflyer_cohort_api'
        });
      }
      const valueRows = buildKeywordValueRows(app.app_key, valuePullRows, cohortValueRows, version, rulesByApp);
      await chInsertJSON('keyword_value_daily_metrics', valueRows);

      details.push({
        app_key: app.app_key,
        keyword_rows: keywordRows.length,
        value_rows: valueRows.length,
        lifecycle_rows: lifecycleRows,
        status: 'ok'
      });
    } catch (error) {
      const errorText = error instanceof Error ? error.message : String(error);
      details.push({
        app_key: app.app_key,
        keyword_rows: 0,
        value_rows: 0,
        lifecycle_rows: 0,
        status: 'failed',
        error: errorText
      });
      logError(logger, 'keyword_engine_app_failed', {
        app_key: app.app_key,
        error: errorText
      });
    }
  }

  const endedAt = new Date();
  const successCount = details.filter((item) => item.status === 'ok').length;
  const failedCount = details.filter((item) => item.status === 'failed').length;
  const skippedCount = details.filter((item) => item.status === 'skipped').length;

  const summary: KeywordEngineCycleResult = {
    started_at: startedAt.toISOString(),
    ended_at: endedAt.toISOString(),
    duration_ms: endedAt.getTime() - startedAt.getTime(),
    backfill_days: Math.max(1, Math.floor(backfillDays)),
    apps: apps.length,
    success_count: successCount,
    failed_count: failedCount,
    skipped_count: skippedCount,
    details
  };

  logInfo(logger, 'keyword_engine_cycle_finished', {
    backfill_days: summary.backfill_days,
    from,
    to,
    success_count: successCount,
    failed_count: failedCount,
    skipped_count: skippedCount,
    duration_ms: summary.duration_ms
  });

  if (skippedCount > 0) {
    logWarn(logger, 'keyword_engine_skipped_apps', { skipped_count: skippedCount });
  }

  return summary;
}
