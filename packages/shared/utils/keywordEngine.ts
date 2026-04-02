import { chInsertJSON, chQuery } from './clickhouse.js';
import {
  listApps,
  listKeywordExtractRules,
  listKeywordLifecycleStatesByAppPlatform,
  upsertKeywordLifecycleState
} from './repositories.js';
import { extractKeywordFromCampaign, evaluateKeywordLifecycle } from './keyword.js';
import { KeywordExtractRuleRecord, KeywordLifecycleStateRow } from '../types/models.js';
import { env } from '../config/env.js';
import { getPreviousDateString, shiftDateString } from './businessDate.js';

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
  ctr: number;
  cvr: number;
  cpi: number;
  cpp: number;
  d7_roas: number;
  version: number;
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
const KEYWORD_VALUE_FACT_BACKFILL_DAYS = 45;

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
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : 0;
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
        argMax(source_report, ingest_time) AS source_report
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

async function queryKeywordValueRevenueRows(appKey: string, from: string, to: string): Promise<KeywordValueRevenueAggRow[]> {
  return chQuery<KeywordValueRevenueAggRow>(
    `SELECT
        toString(toDate(install_time)) AS install_date,
        app_key,
        if(empty(platform), 'unknown', lowerUTF8(platform)) AS platform,
        if(empty(media_source), 'unknown', media_source) AS media_source,
        if(empty(country), 'unknown', country) AS country,
        if(empty(campaign), 'unknown', campaign) AS campaign,
        toFloat64(count()) AS raw_event_count,
        toFloat64(
          countIf(
            revenue > 0
            AND dateDiff('second', install_time, event_time) >= 0
            AND dateDiff('second', install_time, event_time) <= 604800
          )
        ) AS purchase_count,
        sumIf(
          toFloat64(revenue),
          revenue > 0
          AND dateDiff('second', install_time, event_time) >= 0
          AND dateDiff('second', install_time, event_time) <= 604800
        ) AS revenue_d7
      FROM raw_events
      WHERE app_key = {app_key:String}
        AND toDate(install_time) >= toDate({from:String})
        AND toDate(install_time) <= toDate({to:String})
      GROUP BY install_date, app_key, platform, media_source, country, campaign
      ORDER BY install_date ASC, platform ASC, media_source ASC, country ASC, campaign ASC`,
    {
      app_key: appKey,
      from,
      to
    }
  );
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
    input.platform || 'unknown',
    input.media_source || 'unknown',
    input.country || 'unknown',
    input.campaign || 'unknown'
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
  }

  const aggregate = new Map<string, KeywordValueCostAgg>();
  for (const row of rows) {
    const extracted = extractKeywordFromCampaign(row.campaign, rules);
    const installDate = row.report_date;
    const platform = row.platform || 'unknown';
    const campaign = row.campaign || 'unknown';
    const mediaSource = row.media_source || 'unknown';
    const country = row.country || 'unknown';
    const revenueKey = buildKeywordValueSourceKey({
      install_date: installDate,
      platform,
      media_source: mediaSource,
      country,
      campaign
    });
    if (!revenueMap.has(revenueKey)) {
      continue;
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
    const revenue = revenueMap.get(
      buildKeywordValueSourceKey({
        install_date: row.install_date,
        platform: row.platform,
        media_source: row.media_source,
        country: row.country,
        campaign: row.campaign
      })
    );
    if (!revenue || revenue.raw_event_count <= 0) {
      return [];
    }
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
        purchase_count: revenue.purchase_count,
        revenue_d7: revenue.revenue_d7,
        ctr: row.impressions > 0 ? row.clicks / row.impressions : 0,
        cvr: row.clicks > 0 ? row.installs / row.clicks : 0,
        cpi: row.installs > 0 ? row.total_cost / row.installs : 0,
        cpp: revenue.purchase_count > 0 ? row.total_cost / revenue.purchase_count : 0,
        d7_roas: row.total_cost > 0 ? revenue.revenue_d7 / row.total_cost : 0,
        version
      }
    ];
  });
}

async function queryKeywordHistory(appKey: string, platform: string, days: number): Promise<KeywordDailyAgg[]> {
  const window = Math.max(1, Math.floor(days));
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
          AND date >= toDate(today() - ${window})
          AND date <= toDate(today() - 1)
      )
      GROUP BY report_date, platform, keyword, match_type
      ORDER BY keyword ASC, match_type ASC, report_date ASC`,
    { app_key: appKey, platform }
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
  const { from: valueFrom, to: valueTo } = buildWindow(Math.max(KEYWORD_VALUE_FACT_BACKFILL_DAYS, Math.max(1, Math.floor(backfillDays))));
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

  const details: KeywordEngineCycleDetail[] = [];
  const lifecycleLookbackDays = Math.max(
    Math.max(1, Math.floor(backfillDays)),
    Math.max(1, Math.floor(env.keywordEngineInitialBackfillDays))
  );

  for (const app of apps) {
    try {
      const requiresWideValueWindow = valueFrom !== from || valueTo !== to;
      const [rawRows, valueWindowPullRows, rawEventValueRows] = await Promise.all([
        queryPullRows(app.app_key, from, to),
        requiresWideValueWindow ? queryPullRows(app.app_key, valueFrom, valueTo) : Promise.resolve([]),
        queryKeywordValueRevenueRows(app.app_key, valueFrom, valueTo)
      ]);
      const valuePullRows = requiresWideValueWindow ? valueWindowPullRows : rawRows;
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

      if (rawEventValueRows.length === 0 && valuePullRows.length > 0) {
        logWarn(logger, 'keyword_engine_value_metrics_source_missing', {
          app_key: app.app_key,
          value_from: valueFrom,
          value_to: valueTo
        });
      }
      const valueRows = buildKeywordValueRows(app.app_key, valuePullRows, rawEventValueRows, version, rulesByApp);
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
