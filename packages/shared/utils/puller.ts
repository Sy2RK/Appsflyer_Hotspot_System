import { env } from '../config/env.js';
import crypto from 'crypto';
import {
  getPullContentGuard,
  listApps,
  releasePullCycleLock,
  tryAcquirePullCycleLock,
  upsertPullContentGuard,
  upsertPullReportReadiness
} from './repositories.js';
import { chExec, chInsertJSON, chQuery } from './clickhouse.js';
import { md5Hex } from './hash.js';
import { buildPreviousDateList, getPreviousDateString } from './businessDate.js';

interface CsvRow {
  [key: string]: string;
}

interface PullAggregateDailyRow {
  [key: string]: string | number;
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

interface DailyMetricRow {
  [key: string]: string | number;
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

export interface PullCycleDetail {
  app_key: string;
  date: string;
  platform?: string;
  status:
    | 'ok'
    | 'failed'
    | 'skipped_no_token'
    | 'skipped_missing_pull_app_id'
    | 'skipped_cycle_locked'
    | 'skipped_recently_pulled'
    | 'skipped_same_content_cooldown'
    | 'skipped_rate_limited_after_403';
  rows: number;
  metrics_rows: number;
  error?: string;
  attempts?: number;
  recovered_by_retry?: boolean;
}

export interface PullCycleResult {
  started_at: string;
  ended_at: string;
  duration_ms: number;
  backfill_days: number;
  dates: string[];
  apps: number;
  success_count: number;
  failed_count: number;
  skipped_count: number;
  details: PullCycleDetail[];
}

export interface PullLogger {
  info: (message: string, context?: Record<string, unknown>) => void;
  warn: (message: string, context?: Record<string, unknown>) => void;
  error: (message: string, context?: Record<string, unknown>) => void;
}

const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const PULL_SOURCE_REPORT = 'daily_report_v5';
const PULL_CYCLE_LOCK_NAME = 'pull_daily_report_v5_cycle';
const PULL_REVIEW_RETRY_DELAY_MS = 30 * 1000;
const NON_BLOCKING_READINESS_STATUSES = new Set<PullCycleDetail['status']>([
  'ok',
  'skipped_recently_pulled',
  'skipped_same_content_cooldown'
]);

interface PullAttemptResult {
  ok: boolean;
  status: 'ok' | 'skipped_same_content_cooldown';
  rows: number;
  metricsRows: number;
  error?: string;
  rateLimited: boolean;
}

interface PullReviewCandidate {
  detailIndex: number;
  appKey: string;
  pullAppId: string;
  date: string;
  platform: string;
}

interface PullSliceScope {
  appKey: string;
  date: string;
  platform: string;
}

function buildPullTargets(app: {
  ios_pull_app_id: string;
  android_pull_app_id: string;
  pull_app_id: string;
}): Array<{ pullAppId: string; platform: string }> {
  const targets: Array<{ pullAppId: string; platform: string }> = [];
  if (app.ios_pull_app_id) {
    targets.push({ pullAppId: app.ios_pull_app_id, platform: 'ios' });
  }
  if (app.android_pull_app_id) {
    targets.push({ pullAppId: app.android_pull_app_id, platform: 'android' });
  }
  if (targets.length === 0 && app.pull_app_id) {
    targets.push({ pullAppId: app.pull_app_id, platform: 'unknown' });
  }
  return targets;
}

function buildPullReadinessErrorSummary(details: PullCycleDetail[]): string | null {
  const summaries = Array.from(
    new Set(
      details
        .filter((detail) => !NON_BLOCKING_READINESS_STATUSES.has(detail.status))
        .map((detail) => {
          const platform = detail.platform ? `/${detail.platform}` : '';
          const reason = String(detail.error || detail.status).trim();
          return `${detail.app_key}${platform}:${reason}`;
        })
        .filter((value) => value.length > 0)
    )
  ).slice(0, 5);

  return summaries.length > 0 ? summaries.join(' | ') : null;
}

async function markPullReadinessPending(
  dates: string[],
  expectedTargets: number,
  startedAt: string
): Promise<void> {
  await Promise.all(
    dates.map((date) =>
      upsertPullReportReadiness({
        report_date: date,
        source_report: PULL_SOURCE_REPORT,
        status: 'pending',
        expected_targets: expectedTargets,
        ok_targets: 0,
        blocked_targets: 0,
        last_cycle_started_at: startedAt,
        last_cycle_finished_at: null,
        last_error_summary: null
      })
    )
  );
}

async function finalizePullReadiness(
  dates: string[],
  details: PullCycleDetail[],
  expectedTargets: number,
  startedAt: string,
  finishedAt: string
): Promise<void> {
  await Promise.all(
    dates.map(async (date) => {
      const dateDetails = details.filter((detail) => detail.date === date && detail.status !== 'skipped_missing_pull_app_id');
      const okTargets = dateDetails.filter((detail) => NON_BLOCKING_READINESS_STATUSES.has(detail.status)).length;
      const blockedTargets = Math.max(0, expectedTargets - okTargets);
      await upsertPullReportReadiness({
        report_date: date,
        source_report: PULL_SOURCE_REPORT,
        status: blockedTargets > 0 ? 'blocked' : 'ready',
        expected_targets: expectedTargets,
        ok_targets: okTargets,
        blocked_targets: blockedTargets,
        last_cycle_started_at: startedAt,
        last_cycle_finished_at: finishedAt,
        last_error_summary: buildPullReadinessErrorSummary(dateDetails)
      });
    })
  );
}

const HEADER_ALIASES: Record<string, string> = {
  date: 'date',
  'agency/pmd (af_prt)': 'agency_pmd',
  'agency/pmd': 'agency_pmd',
  af_prt: 'agency_pmd',
  'media source (pid)': 'media_source',
  'media source': 'media_source',
  pid: 'media_source',
  'campaign (c)': 'campaign',
  campaign: 'campaign',
  c: 'campaign',
  impressions: 'impressions',
  clicks: 'clicks',
  ctr: 'ctr',
  installs: 'installs',
  'conversion rate': 'conversion_rate',
  sessions: 'sessions',
  'loyal users': 'loyal_users',
  'loyal users/installs': 'loyal_users_installs_ratio',
  'total cost': 'total_cost',
  'average ecpi': 'average_ecpi',
  country: 'country',
  'country code': 'country_code',
  platform: 'platform',
  os: 'platform',
  revenue: 'revenue',
  events: 'events'
};

function logInfo(logger: PullLogger | undefined, message: string, context?: Record<string, unknown>): void {
  if (logger) {
    logger.info(message, context);
  }
}

function logWarn(logger: PullLogger | undefined, message: string, context?: Record<string, unknown>): void {
  if (logger) {
    logger.warn(message, context);
  }
}

function logError(logger: PullLogger | undefined, message: string, context?: Record<string, unknown>): void {
  if (logger) {
    logger.error(message, context);
  }
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

function normalizeHeader(header: string): string {
  const normalized = header.replace(/^\uFEFF/, '').trim().toLowerCase().replace(/\s+/g, ' ');
  if (HEADER_ALIASES[normalized]) {
    return HEADER_ALIASES[normalized];
  }

  const stripped = normalized.replace(/\([^)]*\)/g, ' ').replace(/\s+/g, ' ').trim();
  if (HEADER_ALIASES[stripped]) {
    return HEADER_ALIASES[stripped];
  }

  return stripped.replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

async function replacePullDailySlice(
  scope: PullSliceScope,
  pullRows: PullAggregateDailyRow[],
  metricRows: DailyMetricRow[]
): Promise<void> {
  const mutationParams = {
    date: scope.date,
    app_key: scope.appKey,
    platform: scope.platform,
    source_report: PULL_SOURCE_REPORT
  };

  const existingPullRows = await chQuery<PullAggregateDailyRow>(
    `SELECT date, app_key, platform, media_source, country, campaign, agency_pmd, impressions, clicks, ctr,
            installs, conversion_rate, sessions, loyal_users, loyal_users_installs_ratio, total_cost,
            average_ecpi, source_report, pull_window_from, pull_window_to, revenue, events, raw_json, ingest_time
       FROM pull_aggregate_daily
      WHERE date = toDate({date:String})
        AND app_key = {app_key:String}
        AND lowerUTF8(platform) = {platform:String}
        AND source_report = {source_report:String}`,
    mutationParams
  );
  const existingMetricRows = await chQuery<DailyMetricRow>(
    `SELECT date, app_key, metric, value, platform, media_source, campaign, country, source, version
       FROM metrics_daily
      WHERE date = toDate({date:String})
        AND app_key = {app_key:String}
        AND lowerUTF8(platform) = {platform:String}
        AND source = {source_report:String}`,
    mutationParams
  );

  const deletePullSlice = async (): Promise<void> => chExec(
    `ALTER TABLE pull_aggregate_daily
      DELETE WHERE date = toDate({date:String})
        AND app_key = {app_key:String}
        AND lowerUTF8(platform) = {platform:String}
        AND source_report = {source_report:String}
      SETTINGS mutations_sync = 2`,
    mutationParams
  );

  const deleteMetricSlice = async (): Promise<void> => chExec(
    `ALTER TABLE metrics_daily
      DELETE WHERE date = toDate({date:String})
        AND app_key = {app_key:String}
        AND lowerUTF8(platform) = {platform:String}
        AND source = {source_report:String}
      SETTINGS mutations_sync = 2`,
    mutationParams
  );

  let replacementStarted = false;

  try {
    await deletePullSlice();
    await deleteMetricSlice();
    replacementStarted = true;

    if (pullRows.length > 0) {
      await chInsertJSON('pull_aggregate_daily', pullRows);
    }
    if (metricRows.length > 0) {
      await chInsertJSON('metrics_daily', metricRows);
    }
  } catch (error) {
    if (replacementStarted) {
      const rollbackErrors: string[] = [];
      try {
        await deletePullSlice();
        if (existingPullRows.length > 0) {
          await chInsertJSON('pull_aggregate_daily', existingPullRows);
        }
      } catch (rollbackError) {
        rollbackErrors.push(`pull=${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`);
      }
      try {
        await deleteMetricSlice();
        if (existingMetricRows.length > 0) {
          await chInsertJSON('metrics_daily', existingMetricRows);
        }
      } catch (rollbackError) {
        rollbackErrors.push(`metrics=${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`);
      }
      if (rollbackErrors.length > 0) {
        throw new Error(
          `replace_pull_daily_slice_failed:${
            error instanceof Error ? error.message : String(error)
          }; rollback_failed:${rollbackErrors.join(' | ')}`
        );
      }
    }
    throw error;
  }
}

function parseCsv(csv: string): CsvRow[] {
  const rows = parseCsvRows(csv);
  if (rows.length <= 1) {
    return [];
  }

  const headers = rows[0].map((h) => normalizeHeader(h));
  const data: CsvRow[] = [];

  for (let i = 1; i < rows.length; i += 1) {
    const cols = rows[i];
    const row: CsvRow = {};

    for (let j = 0; j < headers.length; j += 1) {
      row[headers[j]] = (cols[j] ?? '').trim();
    }

    data.push(row);
  }

  return data;
}

function toNumber(value: string | undefined): number {
  if (!value) {
    return 0;
  }

  const raw = value.trim();
  if (!raw || raw.toLowerCase() === 'n/a') {
    return 0;
  }

  const cleaned = raw.replace(/[,$%\s]/g, '');
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : 0;
}

function toStringOr(value: string | undefined, fallback: string): string {
  const text = (value ?? '').trim();
  return text.length > 0 ? text : fallback;
}

function buildDateList(backfillDays: number): string[] {
  return buildPreviousDateList(backfillDays);
}

function yesterdayDateString(): string {
  return getPreviousDateString(1);
}

function cooldownMsForReportDate(date: string): number {
  return date >= yesterdayDateString()
    ? env.pullerSameContentCooldownRecentMs
    : env.pullerSameContentCooldownHistoricalMs;
}

function nextAllowedAtForReportDate(date: string): string {
  return new Date(Date.now() + cooldownMsForReportDate(date)).toISOString();
}

function normalizePlatform(value: string): string {
  const text = String(value || '').trim().toLowerCase();
  return text || 'unknown';
}

function toPullRows(params: {
  appKey: string;
  date: string;
  platformHint: string;
  rows: CsvRow[];
}): PullAggregateDailyRow[] {
  const ingestTime = new Date().toISOString().slice(0, 19).replace('T', ' ');

  return params.rows.map((row) => {
    const rowDate = toStringOr(row.date, params.date);
    const mediaSource = toStringOr(row.media_source ?? row.pid, 'unknown');
    const campaign = toStringOr(row.campaign ?? row.c, 'unknown');
    const country = toStringOr(row.country ?? row.country_code, 'unknown');
    const platform = toStringOr(row.platform, params.platformHint || 'unknown').toLowerCase();

    return {
      date: rowDate,
      app_key: params.appKey,
      platform,
      media_source: mediaSource,
      country,
      campaign,
      agency_pmd: toStringOr(row.agency_pmd ?? row.af_prt, ''),
      impressions: toNumber(row.impressions),
      clicks: toNumber(row.clicks),
      ctr: toNumber(row.ctr),
      installs: toNumber(row.installs),
      conversion_rate: toNumber(row.conversion_rate),
      sessions: toNumber(row.sessions),
      loyal_users: toNumber(row.loyal_users),
      loyal_users_installs_ratio: toNumber(row.loyal_users_installs_ratio),
      total_cost: toNumber(row.total_cost),
      average_ecpi: toNumber(row.average_ecpi),
      source_report: PULL_SOURCE_REPORT,
      pull_window_from: params.date,
      pull_window_to: params.date,
      revenue: toNumber(row.revenue),
      events: toNumber(row.events),
      raw_json: JSON.stringify(row),
      ingest_time: ingestTime
    };
  });
}

function toDailyMetricRows(rows: PullAggregateDailyRow[], version: number): DailyMetricRow[] {
  const source = 'pull_daily_report_v5';
  const aggregate = new Map<string, DailyMetricRow>();

  for (const row of rows) {
    const metrics = [
      { metric: 'installs', value: row.installs },
      { metric: 'clicks', value: row.clicks },
      { metric: 'total_cost', value: row.total_cost }
    ];

    for (const item of metrics) {
      const key = [
        row.date,
        row.app_key,
        row.platform,
        item.metric,
        row.media_source,
        row.campaign,
        row.country,
        source
      ].join('|');

      const existing = aggregate.get(key);
      if (existing) {
        existing.value += item.value;
      } else {
        aggregate.set(key, {
          date: row.date,
          app_key: row.app_key,
          platform: row.platform,
          metric: item.metric,
          value: item.value,
          media_source: row.media_source,
          campaign: row.campaign,
          country: row.country,
          source,
          version
        });
      }
    }
  }

  return Array.from(aggregate.values());
}

function buildPullContentSignature(rows: PullAggregateDailyRow[]): string {
  const normalized = [...rows]
    .sort((a, b) => {
      return (
        a.media_source.localeCompare(b.media_source) ||
        a.country.localeCompare(b.country) ||
        a.campaign.localeCompare(b.campaign) ||
        a.platform.localeCompare(b.platform)
      );
    })
    .map((row) =>
      [
        row.date,
        row.media_source,
        row.country,
        row.campaign,
        row.platform,
        row.agency_pmd,
        Number(row.impressions).toFixed(6),
        Number(row.installs).toFixed(6),
        Number(row.clicks).toFixed(6),
        Number(row.ctr).toFixed(6),
        Number(row.conversion_rate).toFixed(6),
        Number(row.sessions).toFixed(6),
        Number(row.loyal_users).toFixed(6),
        Number(row.loyal_users_installs_ratio).toFixed(6),
        Number(row.total_cost).toFixed(6),
        Number(row.average_ecpi).toFixed(6),
        Number(row.revenue).toFixed(6),
        Number(row.events).toFixed(6),
        row.source_report,
        row.pull_window_from,
        row.pull_window_to
      ].join('|')
    )
    .join('\n');

  return md5Hex(normalized);
}

function isRateLimitError(errorText: string): boolean {
  const lower = String(errorText || '').toLowerCase();
  return lower.includes('status=403') && lower.includes('limit reached for daily-report');
}

function isCooldownActive(nextAllowedAt?: string | null): boolean {
  if (!nextAllowedAt) {
    return false;
  }
  const value = new Date(nextAllowedAt).getTime();
  return Number.isFinite(value) && value > Date.now();
}

async function sleepMs(durationMs: number): Promise<void> {
  const safeDuration = Math.max(0, Math.floor(durationMs));
  if (safeDuration <= 0) {
    return;
  }
  await new Promise((resolve) => setTimeout(resolve, safeDuration));
}

function buildPullUrl(appKey: string, pullAppId: string, date: string): string {
  const endpoint =
    process.env.APPSFLYER_PULL_ENDPOINT_TEMPLATE
      ?.replace('{app_key}', appKey)
      .replace('{app_id}', pullAppId) ??
    `https://hq1.appsflyer.com/api/agg-data/export/app/${pullAppId}/daily_report/v5`;

  const sep = endpoint.includes('?') ? '&' : '?';
  return `${endpoint}${sep}from=${date}&to=${date}`;
}

async function pullAppDaily(
  appKey: string,
  pullAppId: string,
  date: string,
  platformHint: string
): Promise<{ rows: number; metricsRows: number; signature: string }> {
  const url = buildPullUrl(appKey, pullAppId, date);

  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${env.pullToken}`
    }
  });

  if (!response.ok) {
    const errorBody = (await response.text().catch(() => ''))
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 120);
    throw new Error(
      errorBody ? `pull_api_failed status=${response.status} body=${errorBody}` : `pull_api_failed status=${response.status}`
    );
  }

  const csv = await response.text();
  const parsedRows = parseCsv(csv);
  const pullRows = toPullRows({ appKey, date, rows: parsedRows, platformHint });
  const signature = buildPullContentSignature(pullRows);

  return {
    rows: pullRows.length,
    metricsRows: toDailyMetricRows(pullRows, Date.now()).length,
    signature
  };
}

async function executePullAttempt(params: {
  appKey: string;
  pullAppId: string;
  date: string;
  platform: string;
}): Promise<PullAttemptResult> {
  const guard = await getPullContentGuard(params.appKey, params.platform, params.date, PULL_SOURCE_REPORT);
  const url = buildPullUrl(params.appKey, params.pullAppId, params.date);

  try {
    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${env.pullToken}`
      }
    });

    if (!response.ok) {
      const errorBody = (await response.text().catch(() => ''))
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 120);
      throw new Error(
        errorBody ? `pull_api_failed status=${response.status} body=${errorBody}` : `pull_api_failed status=${response.status}`
      );
    }

    const csv = await response.text();
    const parsedRows = parseCsv(csv);
    const pullRows = toPullRows({
      appKey: params.appKey,
      date: params.date,
      rows: parsedRows,
      platformHint: params.platform
    });
    const signature = buildPullContentSignature(pullRows);
    const metricRows = toDailyMetricRows(pullRows, Date.now());

    if (guard?.content_signature && guard.content_signature === signature) {
      const nextAllowedAt = nextAllowedAtForReportDate(params.date);
      await upsertPullContentGuard({
        app_key: params.appKey,
        platform: params.platform,
        report_date: params.date,
        source_report: PULL_SOURCE_REPORT,
        content_signature: signature,
        last_status: 'skipped_same_content_cooldown',
        last_error: null,
        next_allowed_at: nextAllowedAt
      });
      return {
        ok: true,
        status: 'skipped_same_content_cooldown',
        rows: 0,
        metricsRows: 0,
        rateLimited: false
      };
    }

    await replacePullDailySlice(
      {
        appKey: params.appKey,
        date: params.date,
        platform: params.platform
      },
      pullRows,
      metricRows
    );
    await upsertPullContentGuard({
      app_key: params.appKey,
      platform: params.platform,
      report_date: params.date,
      source_report: PULL_SOURCE_REPORT,
      content_signature: signature,
      last_status: 'ok',
      last_error: null,
      next_allowed_at: nextAllowedAtForReportDate(params.date)
    });

    return {
      ok: true,
      status: 'ok',
      rows: pullRows.length,
      metricsRows: metricRows.length,
      rateLimited: false
    };
  } catch (error) {
    const errorText = error instanceof Error ? error.message : String(error);
    await upsertPullContentGuard({
      app_key: params.appKey,
      platform: params.platform,
      report_date: params.date,
      source_report: PULL_SOURCE_REPORT,
      content_signature: guard?.content_signature ?? '',
      last_status: 'failed',
      last_error: errorText,
      next_allowed_at: null
    });
    return {
      ok: false,
      status: 'ok',
      rows: 0,
      metricsRows: 0,
      error: errorText,
      rateLimited: isRateLimitError(errorText)
    };
  }
}

export async function runPullCycle(backfillDays: number, logger?: PullLogger): Promise<PullCycleResult> {
  const startedAt = new Date();
  const startedAtIso = startedAt.toISOString();
  const safeBackfillDays = Math.max(1, Math.floor(backfillDays));
  const apps = await listApps();
  const dates = buildDateList(safeBackfillDays);
  const details: PullCycleDetail[] = [];
  const reviewQueue: PullReviewCandidate[] = [];
  const lockOwnerId = crypto.randomUUID();
  const expectedTargets = apps.reduce((sum, app) => sum + buildPullTargets(app).length, 0);

  const lockAcquired = await tryAcquirePullCycleLock(PULL_CYCLE_LOCK_NAME, lockOwnerId, env.pullerLockTtlMs);
  if (!lockAcquired) {
    const endedAt = new Date();
    return {
      started_at: startedAt.toISOString(),
      ended_at: endedAt.toISOString(),
      duration_ms: endedAt.getTime() - startedAt.getTime(),
      backfill_days: safeBackfillDays,
      dates,
      apps: apps.length,
      success_count: 0,
      failed_count: 0,
      skipped_count: 1,
      details: [
        {
          app_key: '*',
          date: '-',
          platform: 'unknown',
          status: 'skipped_cycle_locked',
          rows: 0,
          metrics_rows: 0,
          error: 'pull_cycle_running'
        }
      ]
    };
  }

  try {
    await markPullReadinessPending(dates, expectedTargets, startedAtIso);
    logInfo(logger, 'puller_cycle_started', {
      apps: apps.length,
      backfill_days: safeBackfillDays,
      dates
    });

    for (const app of apps) {
      const targets = buildPullTargets(app);
      if (targets.length === 0) {
        details.push({
          app_key: app.app_key,
          date: '-',
          status: 'skipped_missing_pull_app_id',
          rows: 0,
          metrics_rows: 0,
          error: 'missing_pull_app_id'
        });
        logWarn(logger, 'puller_skip_missing_pull_app_id', { app_key: app.app_key });
        continue;
      }

      for (const target of targets) {
        let rateLimited = false;
        const platform = normalizePlatform(target.platform);

        for (const date of dates) {
          if (rateLimited) {
            details.push({
              app_key: app.app_key,
              date,
              platform,
              status: 'skipped_rate_limited_after_403',
              rows: 0,
              metrics_rows: 0,
              error: 'rate_limited_after_403'
            });
            continue;
          }

          if (!env.pullToken) {
            details.push({
              app_key: app.app_key,
              date,
              platform,
              status: 'skipped_no_token',
              rows: 0,
              metrics_rows: 0,
              error: 'missing_pull_token',
              attempts: 0,
              recovered_by_retry: false
            });
            logWarn(logger, 'puller_skipped_no_token', { app_key: app.app_key, platform });
            continue;
          }

          const guard = await getPullContentGuard(app.app_key, platform, date, PULL_SOURCE_REPORT);
          if (guard && isCooldownActive(guard.next_allowed_at)) {
            const status =
              guard.last_status === 'skipped_same_content_cooldown'
                ? 'skipped_same_content_cooldown'
                : 'skipped_recently_pulled';
            details.push({
              app_key: app.app_key,
              date,
              platform,
              status,
              rows: 0,
              metrics_rows: 0,
              error:
                status === 'skipped_same_content_cooldown'
                  ? `same_content_cooldown_until=${guard.next_allowed_at}`
                  : `recently_pulled_until=${guard.next_allowed_at}`,
              attempts: 0,
              recovered_by_retry: false
            });
            continue;
          }

          const attempt = await executePullAttempt({
            appKey: app.app_key,
            pullAppId: target.pullAppId,
            date,
            platform
          });

          if (attempt.ok) {
            if (attempt.status === 'skipped_same_content_cooldown') {
              const nextAllowedAt = nextAllowedAtForReportDate(date);
              details.push({
                app_key: app.app_key,
                date,
                platform,
                status: 'skipped_same_content_cooldown',
                rows: 0,
                metrics_rows: 0,
                error: `same_content_cooldown_until=${nextAllowedAt}`,
                attempts: 1,
                recovered_by_retry: false
              });
              logInfo(logger, 'puller_skip_same_content_cooldown', {
                app_key: app.app_key,
                date,
                platform,
                next_allowed_at: nextAllowedAt
              });
            } else {
              details.push({
                app_key: app.app_key,
                date,
                platform,
                status: 'ok',
                rows: attempt.rows,
                metrics_rows: attempt.metricsRows,
                attempts: 1,
                recovered_by_retry: false
              });
              logInfo(logger, 'puller_ingested', {
                app_key: app.app_key,
                date,
                platform,
                rows: attempt.rows,
                metrics_rows: attempt.metricsRows,
                source: PULL_SOURCE_REPORT,
                attempts: 1
              });
            }
          } else {
            if (attempt.rateLimited) {
              rateLimited = true;
            }
            details.push({
              app_key: app.app_key,
              date,
              platform,
              status: 'failed',
              rows: 0,
              metrics_rows: 0,
              error: attempt.error,
              attempts: 1,
              recovered_by_retry: false
            });
            reviewQueue.push({
              detailIndex: details.length - 1,
              appKey: app.app_key,
              pullAppId: target.pullAppId,
              date,
              platform
            });
            logError(logger, 'puller_app_day_failed', {
              app_key: app.app_key,
              date,
              platform,
              error: attempt.error
            });
          }

          await sleepMs(env.pullerRequestIntervalMs);
        }
      }
    }

    if (reviewQueue.length > 0) {
      logInfo(logger, 'puller_review_retry_scheduled', {
        retry_count: reviewQueue.length,
        wait_ms: PULL_REVIEW_RETRY_DELAY_MS
      });
      await sleepMs(PULL_REVIEW_RETRY_DELAY_MS);

      for (const candidate of reviewQueue) {
        const retry = await executePullAttempt({
          appKey: candidate.appKey,
          pullAppId: candidate.pullAppId,
          date: candidate.date,
          platform: candidate.platform
        });
        const detail = details[candidate.detailIndex];
        if (!detail) {
          continue;
        }

        if (retry.ok) {
          detail.status = 'ok';
          detail.rows = retry.rows;
          detail.metrics_rows = retry.metricsRows;
          detail.error = undefined;
          detail.attempts = 2;
          detail.recovered_by_retry = true;
          logInfo(logger, 'puller_review_retry_recovered', {
            app_key: candidate.appKey,
            date: candidate.date,
            platform: candidate.platform,
            rows: retry.rows,
            metrics_rows: retry.metricsRows
          });
        } else {
          detail.error = retry.error;
          detail.attempts = 2;
          detail.recovered_by_retry = false;
          logError(logger, 'puller_review_retry_failed', {
            app_key: candidate.appKey,
            date: candidate.date,
            platform: candidate.platform,
            error: retry.error
          });
        }

        await sleepMs(env.pullerRequestIntervalMs);
      }
    }

    const endedAt = new Date();
    const endedAtIso = endedAt.toISOString();
    const successCount = details.filter((item) => item.status === 'ok').length;
    const failedCount = details.filter((item) => item.status === 'failed').length;
    const skippedCount = details.filter((item) => item.status.startsWith('skipped_')).length;

    await finalizePullReadiness(dates, details, expectedTargets, startedAtIso, endedAtIso);

    const summary: PullCycleResult = {
      started_at: startedAtIso,
      ended_at: endedAtIso,
      duration_ms: endedAt.getTime() - startedAt.getTime(),
      backfill_days: safeBackfillDays,
      dates,
      apps: apps.length,
      success_count: successCount,
      failed_count: failedCount,
      skipped_count: skippedCount,
      details
    };

    logInfo(logger, 'puller_cycle_finished', {
      apps: apps.length,
      backfill_days: safeBackfillDays,
      dates,
      success_count: successCount,
      failed_count: failedCount,
      skipped_count: skippedCount,
      duration_ms: summary.duration_ms
    });

    return summary;
  } catch (error) {
    const endedAtIso = new Date().toISOString();
    const errorText = error instanceof Error ? error.message : String(error);
    await Promise.all(
      dates.map((date) =>
        upsertPullReportReadiness({
          report_date: date,
          source_report: PULL_SOURCE_REPORT,
          status: 'blocked',
          expected_targets: expectedTargets,
          ok_targets: 0,
          blocked_targets: expectedTargets,
          last_cycle_started_at: startedAtIso,
          last_cycle_finished_at: endedAtIso,
          last_error_summary: errorText
        })
      )
    );
    throw error;
  } finally {
    await releasePullCycleLock(PULL_CYCLE_LOCK_NAME, lockOwnerId);
  }
}
