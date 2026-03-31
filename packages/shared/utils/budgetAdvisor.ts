import { chQuery } from './clickhouse.js';
import { env } from '../config/env.js';
import { explainBudgetRecommendationWithLlm } from './llm.js';
import { getDateStringInTimezone, shiftDateString } from './businessDate.js';
import {
  getRecommendationPolicyConfig,
  expirePendingBudgetRecommendationsForDate,
  insertLlmAuditLog,
  listApps,
  listKeywordLifecycleStatesByApp,
  listRecommendationPolicyConfigs,
  upsertBudgetRecommendation
} from './repositories.js';
import {
  KeywordLifecycleStateRow,
  RecommendationPolicyConfigRecord,
  RecommendationPolicyRuleJson
} from '../types/models.js';
import {
  buildRecommendationPolicyKey,
  buildRecommendationPolicyMap,
  defaultRecommendationPolicyRule,
  evaluateSpendScenarios,
  isRecommendationPolicyEnabledForMedia,
  normalizeRecommendationPolicyRule,
  resolveRecommendationTarget
} from './recommendationPolicies.js';

export interface BudgetAdvisorLogger {
  info: (message: string, context?: Record<string, unknown>) => void;
  warn: (message: string, context?: Record<string, unknown>) => void;
  error: (message: string, context?: Record<string, unknown>) => void;
}

export interface BudgetAdvisorCycleDetail {
  app_key: string;
  generated: number;
  status: 'ok' | 'failed' | 'skipped';
  error?: string;
}

export interface BudgetAdvisorCycleResult {
  started_at: string;
  ended_at: string;
  duration_ms: number;
  lookback_days: number;
  apps: number;
  generated_total: number;
  success_count: number;
  failed_count: number;
  skipped_count: number;
  details: BudgetAdvisorCycleDetail[];
}

export interface BudgetAdvisorProgressSnapshot {
  started_at: string;
  lookback_days: number;
  total_apps: number;
  processed_apps: number;
  current_app: string | null;
  generated_total: number;
  total_candidates: number;
  success_count: number;
  failed_count: number;
  skipped_count: number;
}

export type BudgetAdvisorProgressHandler = (snapshot: BudgetAdvisorProgressSnapshot) => void;

interface BudgetKeywordFact {
  app_key: string;
  platform: string;
  media_source: string;
  keyword: string;
  match_type: string;
  last3_installs: number;
  last7_installs: number;
  last7_clicks: number;
  last7_cost: number;
  current_ecpi: number;
}

interface BudgetValueFact {
  date: string;
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
}

type VolumeTier = 'low' | 'medium' | 'high';
type PrimaryMetric = 'ecpi' | 'roas';
type MetricMode = 'active' | 'roas_pending_revenue';

function factKey(platform: string, mediaSource: string, keyword: string, matchType: string): string {
  return `${platform}|${mediaSource}|${keyword}|${matchType}`;
}

function logInfo(
  logger: BudgetAdvisorLogger | undefined,
  message: string,
  context?: Record<string, unknown>
): void {
  logger?.info(message, context);
}

function logError(
  logger: BudgetAdvisorLogger | undefined,
  message: string,
  context?: Record<string, unknown>
): void {
  logger?.error(message, context);
}

function safeNumber(value: unknown, fallback = 0): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function todayDateString(): string {
  return getDateStringInTimezone();
}

function yesterdayDateString(): string {
  return shiftDateString(todayDateString(), -1);
}

function buildLookbackStartDate(lookbackDays: number): string {
  return shiftDateString(todayDateString(), -(Math.max(1, Math.floor(lookbackDays)) - 1));
}

function stateKey(platform: string, keyword: string, matchType: string): string {
  return `${platform}|${keyword}|${matchType}`;
}

function median(values: number[]): number {
  const list = values.filter((item) => item > 0).sort((a, b) => a - b);
  if (list.length === 0) return 0;
  const mid = Math.floor(list.length / 2);
  if (list.length % 2 === 1) return list[mid];
  return (list[mid - 1] + list[mid]) / 2;
}

function percentile(values: number[], p: number): number {
  const list = values.filter((item) => item > 0).sort((a, b) => a - b);
  if (list.length === 0) return 0;
  if (list.length === 1) return list[0];
  const rank = (list.length - 1) * Math.min(Math.max(p, 0), 1);
  const lower = Math.floor(rank);
  const upper = Math.ceil(rank);
  if (lower === upper) {
    return list[lower];
  }
  const weight = rank - lower;
  return list[lower] + (list[upper] - list[lower]) * weight;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function resolveVolumeTier(last3Installs: number): VolumeTier {
  if (last3Installs > 30) return 'high';
  if (last3Installs >= 15) return 'medium';
  return 'low';
}

function shouldCreateRecommendation(action: 'increase' | 'decrease' | 'hold' | 'pause'): boolean {
  return action !== 'hold';
}

function resolvePrimaryMetric(
  appKey: string,
  platform: string,
  policy: RecommendationPolicyRuleJson | null
): { primaryMetric: PrimaryMetric; metricMode: MetricMode } {
  if (policy?.metric_family === 'd7_roas_cpp') {
    return {
      primaryMetric: 'roas',
      metricMode: 'active'
    };
  }
  const normalizedPlatform = String(platform || '').trim().toLowerCase();
  const overrideKey = `${appKey}/${normalizedPlatform}`;
  const override = env.budgetPrimaryMetricOverrides[overrideKey];
  if (override) {
    return {
      primaryMetric: override.primaryMetric,
      metricMode: override.metricMode
    };
  }
  return {
    primaryMetric: 'ecpi',
    metricMode: 'active'
  };
}

function buildPolicyDecisionWindow(reportDate: string, policy: RecommendationPolicyRuleJson | null): { from: string; to: string } {
  const window = policy?.maturity_window ?? defaultRecommendationPolicyRule().maturity_window;
  const excludeRecentDays = Math.max(0, Math.floor(window.exclude_recent_days || 0));
  const decisionWindowDays = Math.max(1, Math.floor(window.decision_window_days || 1));
  const to = shiftDateString(reportDate, -excludeRecentDays);
  const from = shiftDateString(to, -(decisionWindowDays - 1));
  return { from, to };
}

function buildDeterministicDecision(input: {
  state: KeywordLifecycleStateRow;
  currentEcpi: number;
  targetEcpi: number;
  volumeTier: VolumeTier;
  last3Installs: number;
  last7Installs: number;
  last7Cost: number;
}): {
  action: 'increase' | 'decrease' | 'hold' | 'pause';
  changeRatio: number;
  confidence: number;
  reasonCode: string;
  volumeTier: VolumeTier;
} {
  const stage = input.state.current_stage;
  const score = safeNumber(input.state.stage_score, 0);
  const ecpi = input.currentEcpi;
  const target = input.targetEcpi;
  const ratio = target > 0 ? ecpi / target : 0;

  if (
    stage === 'pause_candidate' &&
    ecpi > 0 &&
    target > 0 &&
    ratio >= 1.35 &&
    input.last7Cost >= 30 &&
    input.last7Installs <= 5
  ) {
    return {
      action: 'pause',
      changeRatio: -1,
      confidence: clamp(0.76 + Math.min(0.18, (ratio - 1.35) * 0.2), 0.76, 0.94),
      reasonCode: 'ecpi_pause_candidate_extreme',
      volumeTier: input.volumeTier
    };
  }

  if (ecpi <= 0 || target <= 0) {
    return {
      action: 'hold',
      changeRatio: 0,
      confidence: clamp(score / 100, 0.35, 0.68),
      reasonCode: 'ecpi_missing_hold',
      volumeTier: input.volumeTier
    };
  }

  if (input.volumeTier === 'low') {
    return {
      action: 'hold',
      changeRatio: 0,
      confidence: clamp(score / 100, 0.38, 0.72),
      reasonCode: 'ecpi_low_volume_observe',
      volumeTier: input.volumeTier
    };
  }

  if (input.volumeTier === 'medium') {
    if (ratio <= 0.9) {
      return {
        action: 'increase',
        changeRatio: 0.2,
        confidence: clamp(0.64 + (0.9 - ratio) * 0.45, 0.64, 0.9),
        reasonCode: 'ecpi_medium_below_target_expand',
        volumeTier: input.volumeTier
      };
    }
    if (ratio >= 1.15) {
      return {
        action: 'decrease',
        changeRatio: -0.2,
        confidence: clamp(0.66 + (ratio - 1.15) * 0.35, 0.66, 0.91),
        reasonCode: 'ecpi_medium_above_target_reduce',
        volumeTier: input.volumeTier
      };
    }
    return {
      action: 'hold',
      changeRatio: 0,
      confidence: clamp(score / 100, 0.45, 0.76),
      reasonCode: 'ecpi_medium_near_target_hold',
      volumeTier: input.volumeTier
    };
  }

  if (ratio <= 1.0) {
    return {
      action: 'increase',
      changeRatio: 0.2,
      confidence: clamp(0.72 + (1 - ratio) * 0.28, 0.72, 0.94),
      reasonCode: 'ecpi_high_within_target_expand',
      volumeTier: input.volumeTier
    };
  }
  if (ratio >= 1.2) {
    return {
      action: 'decrease',
      changeRatio: -0.2,
      confidence: clamp(0.74 + (ratio - 1.2) * 0.28, 0.74, 0.95),
      reasonCode: 'ecpi_high_above_target_reduce',
      volumeTier: input.volumeTier
    };
  }

  return {
    action: 'hold',
    changeRatio: 0,
    confidence: clamp(score / 100, 0.48, 0.78),
    reasonCode: 'ecpi_high_near_target_hold',
    volumeTier: input.volumeTier
  };
}

function buildValueWindowDecision(input: {
  state: KeywordLifecycleStateRow;
  currentRoas: number;
  currentCpp: number;
  targetRoasMin: number;
  targetRoasGood: number;
  targetCpp: number;
  pauseCppThreshold: number;
  volumeTier: VolumeTier;
  avgDailySpend: number;
}): {
  action: 'increase' | 'decrease' | 'hold' | 'pause';
  changeRatio: number;
  confidence: number;
  reasonCode: string;
  volumeTier: VolumeTier;
} {
  const roasMin = Math.max(0, input.targetRoasMin);
  const roasGood = Math.max(roasMin, input.targetRoasGood || roasMin);
  const cppMax = Math.max(0, input.targetCpp);
  const cppPause = Math.max(cppMax, input.pauseCppThreshold || cppMax);
  const score = safeNumber(input.state.stage_score, 0);

  if (input.avgDailySpend <= 0 || (input.currentRoas <= 0 && input.currentCpp <= 0)) {
    return {
      action: 'hold',
      changeRatio: 0,
      confidence: clamp(score / 100, 0.36, 0.64),
      reasonCode: 'value_window_missing_hold',
      volumeTier: input.volumeTier
    };
  }

  if (input.volumeTier === 'low' && input.avgDailySpend < 20) {
    return {
      action: 'hold',
      changeRatio: 0,
      confidence: clamp(score / 100, 0.42, 0.7),
      reasonCode: 'value_window_low_volume_observe',
      volumeTier: input.volumeTier
    };
  }

  if (
    input.state.current_stage === 'pause_candidate' &&
    cppPause > 0 &&
    input.currentCpp > cppPause &&
    roasMin > 0 &&
    input.currentRoas > 0 &&
    input.currentRoas < roasMin * 0.75
  ) {
    return {
      action: 'pause',
      changeRatio: -1,
      confidence: clamp(0.78 + (input.currentCpp / Math.max(cppPause, 0.01) - 1) * 0.06, 0.78, 0.94),
      reasonCode: 'value_window_pause_candidate_extreme',
      volumeTier: input.volumeTier
    };
  }

  if (
    (roasMin > 0 && input.currentRoas > 0 && input.currentRoas < roasMin) ||
    (cppMax > 0 && input.currentCpp > 0 && input.currentCpp > cppMax)
  ) {
    return {
      action: 'decrease',
      changeRatio: -0.2,
      confidence: clamp(0.68 + Math.max(0, cppMax > 0 ? input.currentCpp / cppMax - 1 : 0) * 0.08, 0.68, 0.93),
      reasonCode: 'value_window_below_target_reduce',
      volumeTier: input.volumeTier
    };
  }

  if (
    (roasGood > 0 && input.currentRoas >= roasGood) &&
    (cppMax <= 0 || input.currentCpp <= 0 || input.currentCpp <= cppMax)
  ) {
    return {
      action: 'increase',
      changeRatio: 0.2,
      confidence: clamp(0.72 + (roasGood > 0 ? input.currentRoas / roasGood - 1 : 0) * 0.08, 0.72, 0.94),
      reasonCode: 'value_window_above_target_expand',
      volumeTier: input.volumeTier
    };
  }

  return {
    action: 'hold',
    changeRatio: 0,
    confidence: clamp(score / 100, 0.46, 0.78),
    reasonCode: 'value_window_near_target_hold',
    volumeTier: input.volumeTier
  };
}

async function queryBudgetKeywordFacts(appKey: string, reportDate: string): Promise<BudgetKeywordFact[]> {
  const last3From = shiftDateString(reportDate, -2);
  const last7From = shiftDateString(reportDate, -6);

  const rows = await chQuery<Record<string, unknown>>(
    `SELECT
        app_key,
        platform,
        media_source,
        keyword,
        match_type,
        sumIf(toFloat64(installs), date >= toDate({last3_from:String}) AND date <= toDate({report_date:String})) AS last3_installs,
        sumIf(toFloat64(installs), date >= toDate({last7_from:String}) AND date <= toDate({report_date:String})) AS last7_installs,
        sumIf(toFloat64(clicks), date >= toDate({last7_from:String}) AND date <= toDate({report_date:String})) AS last7_clicks,
        sumIf(toFloat64(total_cost), date >= toDate({last7_from:String}) AND date <= toDate({report_date:String})) AS last7_cost,
        if(
          sumIf(toFloat64(installs), date >= toDate({last3_from:String}) AND date <= toDate({report_date:String})) > 0,
          sumIf(toFloat64(af_average_ecpi) * toFloat64(installs), date >= toDate({last3_from:String}) AND date <= toDate({report_date:String}))
            / sumIf(toFloat64(installs), date >= toDate({last3_from:String}) AND date <= toDate({report_date:String})),
          if(
            sumIf(toFloat64(installs), date >= toDate({last7_from:String}) AND date <= toDate({report_date:String})) > 0,
            sumIf(toFloat64(af_average_ecpi) * toFloat64(installs), date >= toDate({last7_from:String}) AND date <= toDate({report_date:String}))
              / sumIf(toFloat64(installs), date >= toDate({last7_from:String}) AND date <= toDate({report_date:String})),
            0
          )
        ) AS current_ecpi
      FROM keyword_daily_metrics FINAL
      WHERE app_key = {app_key:String}
        AND date >= toDate({last7_from:String})
        AND date <= toDate({report_date:String})
      GROUP BY app_key, platform, media_source, keyword, match_type
      HAVING last7_installs > 0 OR last7_clicks > 0 OR last7_cost > 0
      ORDER BY platform ASC, media_source ASC, keyword ASC`,
    {
      app_key: appKey,
      last3_from: last3From,
      last7_from: last7From,
      report_date: reportDate
    }
  );

  return rows.map((row) => ({
    app_key: String(row.app_key || appKey),
    platform: String(row.platform || 'unknown').toLowerCase() || 'unknown',
    media_source: String(row.media_source || 'unknown') || 'unknown',
    keyword: String(row.keyword || ''),
    match_type: String(row.match_type || 'unknown') || 'unknown',
    last3_installs: safeNumber(row.last3_installs),
    last7_installs: safeNumber(row.last7_installs),
    last7_clicks: safeNumber(row.last7_clicks),
    last7_cost: safeNumber(row.last7_cost),
    current_ecpi: safeNumber(row.current_ecpi)
  }));
}

async function queryBudgetKeywordSpendSeries(
  appKey: string,
  reportDate: string,
  lookbackDays: number
): Promise<Map<string, number[]>> {
  const from = shiftDateString(reportDate, -(Math.max(1, Math.floor(lookbackDays)) - 1));
  const rows = await chQuery<Record<string, unknown>>(
    `SELECT
        platform,
        media_source,
        keyword,
        match_type,
        toString(date) AS date,
        sum(toFloat64(total_cost)) AS daily_cost
      FROM keyword_daily_metrics FINAL
      WHERE app_key = {app_key:String}
        AND date >= toDate({from:String})
        AND date <= toDate({report_date:String})
      GROUP BY platform, media_source, keyword, match_type, date
      ORDER BY platform ASC, media_source ASC, keyword ASC, match_type ASC, date ASC`,
    {
      app_key: appKey,
      from,
      report_date: reportDate
    }
  );
  const dates = Array.from({ length: Math.max(1, Math.floor(lookbackDays)) }, (_, index) =>
    shiftDateString(from, index)
  );
  const byKeyDate = new Map<string, Map<string, number>>();
  for (const row of rows) {
    const key = factKey(
      String(row.platform || 'unknown').toLowerCase(),
      String(row.media_source || 'unknown'),
      String(row.keyword || ''),
      String(row.match_type || 'unknown')
    );
    const bucket = byKeyDate.get(key) ?? new Map<string, number>();
    bucket.set(String(row.date || ''), safeNumber(row.daily_cost));
    byKeyDate.set(key, bucket);
  }

  const result = new Map<string, number[]>();
  for (const [key, bucket] of byKeyDate) {
    result.set(
      key,
      dates.map((date) => safeNumber(bucket.get(date)))
    );
  }
  return result;
}

async function queryBudgetValueFacts(appKey: string, from: string, to: string): Promise<BudgetValueFact[]> {
  try {
    const rows = await chQuery<Record<string, unknown>>(
      `SELECT
          toString(install_date) AS date,
          app_key,
          platform,
          media_source,
          country,
          campaign,
          keyword,
          match_type,
          installs,
          total_cost,
          purchase_count,
          revenue_d7,
          ctr,
          cvr,
          cpi,
          cpp,
          d7_roas
        FROM keyword_value_daily_metrics FINAL
        WHERE app_key = {app_key:String}
          AND install_date >= toDate({from:String})
          AND install_date <= toDate({to:String})`,
      { app_key: appKey, from, to }
    );
    return rows.map((row) => ({
      date: String(row.date || ''),
      app_key: String(row.app_key || appKey),
      platform: String(row.platform || 'unknown').toLowerCase(),
      media_source: String(row.media_source || 'unknown'),
      country: String(row.country || 'unknown'),
      campaign: String(row.campaign || 'unknown'),
      keyword: String(row.keyword || ''),
      match_type: String(row.match_type || 'unknown'),
      installs: safeNumber(row.installs),
      total_cost: safeNumber(row.total_cost),
      purchase_count: safeNumber(row.purchase_count),
      revenue_d7: safeNumber(row.revenue_d7),
      ctr: safeNumber(row.ctr),
      cvr: safeNumber(row.cvr),
      cpi: safeNumber(row.cpi),
      cpp: safeNumber(row.cpp),
      d7_roas: safeNumber(row.d7_roas)
    }));
  } catch {
    return [];
  }
}

function windowAverage(values: number[]): number {
  const filtered = values.filter((value) => Number.isFinite(value) && value >= 0);
  if (filtered.length === 0) {
    return 0;
  }
  return filtered.reduce((sum, value) => sum + value, 0) / filtered.length;
}

function buildPlatformFallbackTarget(states: KeywordLifecycleStateRow[]): number {
  const fallback = states.map((state) => safeNumber(state.last_cpi)).filter((item) => item > 0);
  return median(fallback);
}

function resolveTargetEcpi(params: {
  facts: BudgetKeywordFact[];
  factsByPlatform: BudgetKeywordFact[];
  statesByPlatform: KeywordLifecycleStateRow[];
  stateMap: Map<string, KeywordLifecycleStateRow>;
}): number {
  const groupCandidates = params.facts.filter((fact) => fact.current_ecpi > 0);
  const groupQualified = params.facts.filter((fact) => {
    const state = params.stateMap.get(stateKey(fact.platform, fact.keyword, fact.match_type));
    const ecpi = fact.current_ecpi > 0;
    return ecpi && fact.last3_installs >= 15 && fact.last7_cost >= 20 && state?.current_stage !== 'pause_candidate';
  });
  const platformCandidates = params.factsByPlatform.filter((fact) => fact.current_ecpi > 0);
  const platformQualified = params.factsByPlatform.filter((fact) => {
    const state = params.stateMap.get(stateKey(fact.platform, fact.keyword, fact.match_type));
    const ecpi = fact.current_ecpi > 0;
    return ecpi && fact.last3_installs >= 15 && fact.last7_cost >= 20 && state?.current_stage !== 'pause_candidate';
  });

  const groupP40 = percentile(groupQualified.map((item) => item.current_ecpi), 0.4);
  const platformP40 = percentile(platformQualified.map((item) => item.current_ecpi), 0.4);
  const platformMedian = median(platformCandidates.map((item) => item.current_ecpi));
  const lifecycleFallback = buildPlatformFallbackTarget(params.statesByPlatform);

  if (groupP40 > 0) {
    return platformMedian > 0 ? Math.min(groupP40, platformMedian) : groupP40;
  }
  if (platformP40 > 0) {
    return platformMedian > 0 ? Math.min(platformP40, platformMedian) : platformP40;
  }
  if (platformMedian > 0) {
    return platformMedian;
  }
  if (groupCandidates.length > 0) {
    return median(groupCandidates.map((item) => item.current_ecpi));
  }
  return lifecycleFallback;
}

export async function runBudgetAdvisorCycle(
  lookbackDays: number,
  logger?: BudgetAdvisorLogger,
  onProgress?: BudgetAdvisorProgressHandler
): Promise<BudgetAdvisorCycleResult> {
  const startedAt = new Date();
  const date = yesterdayDateString();
  const lookbackStartDate = buildLookbackStartDate(lookbackDays);
  const apps = await listApps();
  const policyRows = await listRecommendationPolicyConfigs({ engine: 'budget', enabled: true });
  const policyMap = buildRecommendationPolicyMap(
    policyRows.map((row) => ({
      ...row,
      rule_json: normalizeRecommendationPolicyRule(row.rule_json)
    }))
  );
  const maxTrendLookbackDays = Math.max(
    7,
    ...policyRows.map((row) => normalizeRecommendationPolicyRule(row.rule_json).spend_policy.trend_lookback_days)
  );
  const details: BudgetAdvisorCycleDetail[] = [];
  let generatedTotal = 0;
  let totalCandidates = 0;
  let processedApps = 0;
  let successCount = 0;
  let failedCount = 0;
  let skippedCount = 0;
  let currentApp: string | null = null;

  const emitProgress = () => {
    onProgress?.({
      started_at: startedAt.toISOString(),
      lookback_days: Math.max(1, Math.floor(lookbackDays)),
      total_apps: apps.length,
      processed_apps: processedApps,
      current_app: currentApp,
      generated_total: generatedTotal,
      total_candidates: totalCandidates,
      success_count: successCount,
      failed_count: failedCount,
      skipped_count: skippedCount
    });
  };

  logInfo(logger, 'budget_advisor_cycle_started', {
    lookback_days: lookbackDays,
    apps: apps.length,
    report_date: date
  });
  emitProgress();

  for (const app of apps) {
    try {
      currentApp = app.app_key;
      emitProgress();
      const appPolicies = policyRows
        .filter((row) => row.app_key === app.app_key)
        .map((row) => ({ ...row, rule_json: normalizeRecommendationPolicyRule(row.rule_json) }));
      const needsValueFacts = appPolicies.some((row) => row.rule_json.metric_family === 'd7_roas_cpp');
      const valueFactFrom = shiftDateString(date, -45);
      const [states, facts, spendSeriesMap, valueFacts] = await Promise.all([
        listKeywordLifecycleStatesByApp(app.app_key),
        queryBudgetKeywordFacts(app.app_key, date),
        queryBudgetKeywordSpendSeries(app.app_key, date, maxTrendLookbackDays),
        needsValueFacts ? queryBudgetValueFacts(app.app_key, valueFactFrom, date) : Promise.resolve([])
      ]);
      const filteredStates = states.filter((state) => String(state.last_seen_date || '') >= lookbackStartDate);
      await expirePendingBudgetRecommendationsForDate(app.app_key, date);

      if (filteredStates.length === 0 || facts.length === 0) {
        details.push({
          app_key: app.app_key,
          generated: 0,
          status: 'skipped'
        });
        processedApps += 1;
        skippedCount += 1;
        currentApp = null;
        emitProgress();
        continue;
      }

      const stateMap = new Map<string, KeywordLifecycleStateRow>();
      const statesByPlatform = new Map<string, KeywordLifecycleStateRow[]>();
      for (const state of filteredStates) {
        const platform = String(state.platform || 'unknown').toLowerCase() || 'unknown';
        stateMap.set(stateKey(platform, state.keyword, state.match_type), state);
        const list = statesByPlatform.get(platform);
        if (list) list.push(state);
        else statesByPlatform.set(platform, [state]);
      }

      const factsByPlatform = new Map<string, BudgetKeywordFact[]>();
      const factsByPlatformMedia = new Map<string, BudgetKeywordFact[]>();
      for (const fact of facts) {
        const platformList = factsByPlatform.get(fact.platform);
        if (platformList) platformList.push(fact);
        else factsByPlatform.set(fact.platform, [fact]);

        const mediaKey = `${fact.platform}|${fact.media_source}`;
        const mediaList = factsByPlatformMedia.get(mediaKey);
        if (mediaList) mediaList.push(fact);
        else factsByPlatformMedia.set(mediaKey, [fact]);
      }

      let generated = 0;
      const candidates: Array<{
        fact: BudgetKeywordFact;
        state: KeywordLifecycleStateRow;
        policy: RecommendationPolicyRuleJson | null;
        targetEcpi: number;
        volumeTier: VolumeTier;
        currentRoas: number | null;
        targetRoas: number | null;
        currentCpp: number | null;
        targetCpp: number | null;
        spendSeries: number[];
        scenarioTags: string[];
        presetActionItems: string[];
        decision: ReturnType<typeof buildDeterministicDecision> | ReturnType<typeof buildValueWindowDecision>;
        metricSettings: { primaryMetric: PrimaryMetric; metricMode: MetricMode };
      }> = [];
      const valueFactsByKey = new Map<string, BudgetValueFact[]>();
      for (const row of valueFacts) {
        const key = factKey(row.platform, row.media_source, row.keyword, row.match_type);
        const bucket = valueFactsByKey.get(key) ?? [];
        bucket.push(row);
        valueFactsByKey.set(key, bucket);
      }

      for (const fact of facts) {
        const state = stateMap.get(stateKey(fact.platform, fact.keyword, fact.match_type));
        if (!state) {
          continue;
        }
        const policyRecord =
          policyMap.get(buildRecommendationPolicyKey(app.app_key, fact.platform, 'budget')) ?? null;
        const policy = policyRecord ? normalizeRecommendationPolicyRule(policyRecord.rule_json) : null;
        if (!isRecommendationPolicyEnabledForMedia(policy, fact.media_source)) {
          continue;
        }

        const targetEcpi = resolveTargetEcpi({
          facts: factsByPlatformMedia.get(`${fact.platform}|${fact.media_source}`) ?? [],
          factsByPlatform: factsByPlatform.get(fact.platform) ?? [],
          statesByPlatform: statesByPlatform.get(fact.platform) ?? [],
          stateMap
        });
        const volumeTier = resolveVolumeTier(fact.last3_installs);
        const spendSeries = spendSeriesMap.get(factKey(fact.platform, fact.media_source, fact.keyword, fact.match_type)) ?? [];
        const avgDailySpend = spendSeries.length > 0 ? windowAverage(spendSeries) : fact.last7_cost / 7;
        const scenarioEvaluation = evaluateSpendScenarios({
          avgDailySpend,
          spendSeries,
          spendPolicy: policy?.spend_policy ?? defaultRecommendationPolicyRule().spend_policy,
          actionPlaybook: policy?.action_playbook ?? defaultRecommendationPolicyRule().action_playbook
        });
        const thresholdTargets = resolveRecommendationTarget(policy, {
          mediaSource: fact.media_source
        });
        const policyWindow = buildPolicyDecisionWindow(date, policy);
        const relevantValueFacts = (valueFactsByKey.get(factKey(fact.platform, fact.media_source, fact.keyword, fact.match_type)) ?? []).filter(
          (row) => row.date >= policyWindow.from && row.date <= policyWindow.to
        );
        const totalValueCost = relevantValueFacts.reduce((sum, row) => sum + row.total_cost, 0);
        const totalValueRevenue = relevantValueFacts.reduce((sum, row) => sum + row.revenue_d7, 0);
        const totalValuePurchases = relevantValueFacts.reduce((sum, row) => sum + row.purchase_count, 0);
        const currentRoas = totalValueCost > 0 ? totalValueRevenue / totalValueCost : null;
        const currentCpp = totalValuePurchases > 0 ? totalValueCost / totalValuePurchases : null;

        const valueDriven =
          policy?.metric_family === 'd7_roas_cpp' &&
          relevantValueFacts.length > 0 &&
          ((thresholdTargets.roas_min ?? 0) > 0 || (thresholdTargets.cpp_max ?? 0) > 0);

        const decision = valueDriven
          ? buildValueWindowDecision({
              state,
              currentRoas: currentRoas ?? 0,
              currentCpp: currentCpp ?? 0,
              targetRoasMin: thresholdTargets.roas_min ?? 0,
              targetRoasGood: thresholdTargets.roas_good ?? thresholdTargets.roas_min ?? 0,
              targetCpp: thresholdTargets.cpp_max ?? 0,
              pauseCppThreshold:
                thresholdTargets.cpp_pause_threshold ??
                (thresholdTargets.cpp_max ? thresholdTargets.cpp_max * 1.5 : 0),
              volumeTier,
              avgDailySpend
            })
          : buildDeterministicDecision({
              state,
              currentEcpi: fact.current_ecpi,
              targetEcpi: thresholdTargets.ecpi_max ?? targetEcpi,
              volumeTier,
              last3Installs: fact.last3_installs,
              last7Installs: fact.last7_installs,
              last7Cost: fact.last7_cost
            });
        if (!shouldCreateRecommendation(decision.action)) {
          continue;
        }

        candidates.push({
          fact,
          state,
          policy,
          targetEcpi: thresholdTargets.ecpi_max ?? targetEcpi,
          volumeTier,
          currentRoas,
          targetRoas:
            policy?.metric_family === 'd7_roas_cpp'
              ? thresholdTargets.roas_good ?? thresholdTargets.roas_min ?? null
              : null,
          currentCpp,
          targetCpp: policy?.metric_family === 'd7_roas_cpp' ? thresholdTargets.cpp_max ?? null : null,
          spendSeries,
          scenarioTags: scenarioEvaluation.scenarioTags,
          presetActionItems: scenarioEvaluation.actionItems,
          decision,
          metricSettings: resolvePrimaryMetric(app.app_key, fact.platform, policy)
        });
      }

      totalCandidates += candidates.length;
      emitProgress();

      for (const candidate of candidates) {
        const {
          fact,
          state,
          targetEcpi,
          policy,
          decision,
          metricSettings,
          currentRoas,
          targetRoas,
          currentCpp,
          targetCpp,
          scenarioTags,
          presetActionItems
        } = candidate;
        const currentCost = Math.max(0, fact.last7_cost);
        const suggestedBudget = Math.max(0, currentCost * (1 + decision.changeRatio));
        const expectedInstallsDelta =
          decision.action === 'increase'
            ? fact.last7_installs * Math.abs(decision.changeRatio) * 0.7
            : decision.action === 'decrease'
              ? -fact.last7_installs * Math.abs(decision.changeRatio) * 0.6
              : decision.action === 'pause'
                ? -fact.last7_installs
                : 0;

        const llm = await explainBudgetRecommendationWithLlm({
          appKey: app.app_key,
          platform: fact.platform || 'unknown',
          mediaSource: fact.media_source,
          primaryMetric: metricSettings.primaryMetric,
          metricMode: metricSettings.metricMode,
          keyword: state.keyword,
          matchType: state.match_type,
          action: decision.action,
          changeRatio: decision.changeRatio,
          currentCost,
          suggestedBudget,
          confidence: decision.confidence,
          reasonCode: decision.reasonCode,
          stage: state.current_stage,
          lastCpi: safeNumber(state.last_cpi),
          lastInstalls: safeNumber(state.last_installs),
          lastClicks: safeNumber(state.last_clicks),
          currentEcpi: fact.current_ecpi,
          targetEcpi,
          volumeTier: decision.volumeTier,
          last3Installs: fact.last3_installs,
          last7Installs: fact.last7_installs,
          currentRoas,
          targetRoas,
          currentCpp,
          targetCpp,
          scenarioTags,
          presetActionItems,
          structuredPolicy: policy ? (policy as unknown as Record<string, unknown>) : undefined,
          computedContext: {
            spend_series: candidate.spendSeries,
            current_cpp: currentCpp,
            target_cpp: targetCpp,
            current_roas: currentRoas,
            target_roas: targetRoas
          },
          manualPromptMarkdown:
            policyMap.get(buildRecommendationPolicyKey(app.app_key, fact.platform, 'budget'))?.manual_prompt_markdown ?? null
        });

        await insertLlmAuditLog({
          biz_type: 'budget_recommendation',
          biz_id: `${app.app_key}|${fact.platform}|${fact.media_source}|${state.keyword}|${state.match_type}|${date}`,
          model: llm.model,
          prompt_hash: llm.promptHash,
          response_json: llm.raw,
          latency_ms: llm.latencyMs,
          success: llm.ok
        });

        await upsertBudgetRecommendation({
          app_key: app.app_key,
          platform: fact.platform,
          media_source: fact.media_source,
          keyword: state.keyword,
          match_type: state.match_type,
          date,
          action: decision.action,
          change_ratio: decision.changeRatio,
          suggested_budget: suggestedBudget,
          current_cost: currentCost,
          current_ecpi: fact.current_ecpi,
          target_ecpi: targetEcpi,
          primary_metric: metricSettings.primaryMetric,
          metric_mode: metricSettings.metricMode,
          current_roas: currentRoas,
          target_roas: targetRoas,
          volume_tier: decision.volumeTier,
          expected_installs_delta: expectedInstallsDelta,
          confidence: decision.confidence,
          reason_code: decision.reasonCode,
          llm_summary: {
            ...llm.output,
            media_source: fact.media_source,
            current_ecpi: fact.current_ecpi,
            target_ecpi: targetEcpi,
            volume_tier: decision.volumeTier,
            primary_metric: metricSettings.primaryMetric,
            metric_mode: metricSettings.metricMode,
            last3_installs: fact.last3_installs,
            last7_installs: fact.last7_installs,
            current_roas: currentRoas,
            target_roas: targetRoas,
            current_cpp: currentCpp,
            target_cpp: targetCpp,
            scenario_tags: scenarioTags,
            metric_family: policy?.metric_family ?? 'ecpi'
          },
          status: 'pending'
        });

        generated += 1;
        generatedTotal += 1;
        emitProgress();
      }

      details.push({
        app_key: app.app_key,
        generated,
        status: generated > 0 ? 'ok' : 'skipped'
      });
      processedApps += 1;
      if (generated > 0) {
        successCount += 1;
      } else {
        skippedCount += 1;
      }
      currentApp = null;
      emitProgress();
    } catch (error) {
      const errorText = error instanceof Error ? error.message : String(error);
      details.push({
        app_key: app.app_key,
        generated: 0,
        status: 'failed',
        error: errorText
      });
      logError(logger, 'budget_advisor_app_failed', {
        app_key: app.app_key,
        error: errorText
      });
      processedApps += 1;
      failedCount += 1;
      currentApp = null;
      emitProgress();
    }
  }

  const endedAt = new Date();
  const summary: BudgetAdvisorCycleResult = {
    started_at: startedAt.toISOString(),
    ended_at: endedAt.toISOString(),
    duration_ms: endedAt.getTime() - startedAt.getTime(),
    lookback_days: Math.max(1, Math.floor(lookbackDays)),
    apps: apps.length,
    generated_total: generatedTotal,
    success_count: successCount,
    failed_count: failedCount,
    skipped_count: skippedCount,
    details
  };

  logInfo(logger, 'budget_advisor_cycle_finished', {
    apps: summary.apps,
    generated_total: summary.generated_total,
    success_count: summary.success_count,
    failed_count: summary.failed_count,
    skipped_count: summary.skipped_count,
    duration_ms: summary.duration_ms,
    qwen_model: env.qwen.model,
    qwen_thinking_enabled: env.qwen.thinkingEnabled
  });

  return summary;
}
