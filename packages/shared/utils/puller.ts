import { env } from '../config/env.js';
import { listApps } from './repositories.js';
import { chInsertJSON } from './clickhouse.js';

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
  status: 'ok' | 'failed' | 'skipped_no_token' | 'skipped_missing_pull_app_id';
  rows: number;
  metrics_rows: number;
  error?: string;
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
  const days = Math.max(1, backfillDays);
  const now = new Date();
  const result: string[] = [];

  for (let i = 1; i <= days; i += 1) {
    const day = new Date(now.getTime() - i * ONE_DAY_MS).toISOString().slice(0, 10);
    result.push(day);
  }

  return result;
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
      source_report: 'daily_report_v5',
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
): Promise<{ rows: number; metricsRows: number }> {
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
  const version = Date.now();
  const metricRows = toDailyMetricRows(pullRows, version);

  await chInsertJSON('pull_aggregate_daily', pullRows);
  await chInsertJSON('metrics_daily', metricRows);

  return {
    rows: pullRows.length,
    metricsRows: metricRows.length
  };
}

export async function runPullCycle(backfillDays: number, logger?: PullLogger): Promise<PullCycleResult> {
  const startedAt = new Date();
  const safeBackfillDays = Math.max(1, Math.floor(backfillDays));
  const apps = await listApps();
  const dates = buildDateList(safeBackfillDays);
  const details: PullCycleDetail[] = [];

  logInfo(logger, 'puller_cycle_started', {
    apps: apps.length,
    backfill_days: safeBackfillDays,
    dates
  });

  for (const app of apps) {
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
      for (const date of dates) {
        if (!env.pullToken) {
          details.push({
            app_key: app.app_key,
            date,
            platform: target.platform,
            status: 'skipped_no_token',
            rows: 0,
            metrics_rows: 0,
            error: 'missing_pull_token'
          });
          logWarn(logger, 'puller_skipped_no_token', { app_key: app.app_key, platform: target.platform });
          continue;
        }

        try {
          const result = await pullAppDaily(app.app_key, target.pullAppId, date, target.platform);
          details.push({
            app_key: app.app_key,
            date,
            platform: target.platform,
            status: 'ok',
            rows: result.rows,
            metrics_rows: result.metricsRows
          });
          logInfo(logger, 'puller_ingested', {
            app_key: app.app_key,
            date,
            platform: target.platform,
            rows: result.rows,
            metrics_rows: result.metricsRows,
            source: 'daily_report_v5'
          });
        } catch (error) {
          const errorText = error instanceof Error ? error.message : String(error);
          details.push({
            app_key: app.app_key,
            date,
            platform: target.platform,
            status: 'failed',
            rows: 0,
            metrics_rows: 0,
            error: errorText
          });
          logError(logger, 'puller_app_day_failed', {
            app_key: app.app_key,
            date,
            platform: target.platform,
            error: errorText
          });
        }
      }
    }
  }

  const endedAt = new Date();
  const successCount = details.filter((item) => item.status === 'ok').length;
  const failedCount = details.filter((item) => item.status === 'failed').length;
  const skippedCount = details.filter((item) => item.status.startsWith('skipped_')).length;

  const summary: PullCycleResult = {
    started_at: startedAt.toISOString(),
    ended_at: endedAt.toISOString(),
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
}
