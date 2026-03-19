import { chQuery } from './clickhouse.js';
import { env } from '../config/env.js';
import { explainBudgetRecommendationWithLlm } from './llm.js';
import {
  expirePendingBudgetRecommendationsForDate,
  insertLlmAuditLog,
  listApps,
  listKeywordLifecycleStatesByApp,
  upsertBudgetRecommendation
} from './repositories.js';
import { KeywordLifecycleStateRow } from '../types/models.js';

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

type VolumeTier = 'low' | 'medium' | 'high';
type PrimaryMetric = 'ecpi' | 'roas';
type MetricMode = 'active' | 'roas_pending_revenue';

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
  return new Date().toISOString().slice(0, 10);
}

function shiftDateString(dateString: string, days: number): string {
  const [year, month, day] = dateString.split('-').map(Number);
  const value = new Date(Date.UTC(year, month - 1, day));
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
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

function resolvePrimaryMetric(appKey: string, platform: string): { primaryMetric: PrimaryMetric; metricMode: MetricMode } {
  if (appKey === 'ai-seek' && platform === 'android') {
    return {
      primaryMetric: 'roas',
      metricMode: 'roas_pending_revenue'
    };
  }
  return {
    primaryMetric: 'ecpi',
    metricMode: 'active'
  };
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
  logger?: BudgetAdvisorLogger
): Promise<BudgetAdvisorCycleResult> {
  const startedAt = new Date();
  const date = yesterdayDateString();
  const lookbackStartDate = buildLookbackStartDate(lookbackDays);
  const apps = await listApps();
  const details: BudgetAdvisorCycleDetail[] = [];
  let generatedTotal = 0;

  logInfo(logger, 'budget_advisor_cycle_started', {
    lookback_days: lookbackDays,
    apps: apps.length,
    report_date: date
  });

  for (const app of apps) {
    try {
      const [states, facts] = await Promise.all([
        listKeywordLifecycleStatesByApp(app.app_key),
        queryBudgetKeywordFacts(app.app_key, date)
      ]);
      const filteredStates = states.filter((state) => String(state.last_seen_date || '') >= lookbackStartDate);
      await expirePendingBudgetRecommendationsForDate(app.app_key, date);

      if (filteredStates.length === 0 || facts.length === 0) {
        details.push({
          app_key: app.app_key,
          generated: 0,
          status: 'skipped'
        });
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
      for (const fact of facts) {
        const state = stateMap.get(stateKey(fact.platform, fact.keyword, fact.match_type));
        if (!state) {
          continue;
        }

        const targetEcpi = resolveTargetEcpi({
          facts: factsByPlatformMedia.get(`${fact.platform}|${fact.media_source}`) ?? [],
          factsByPlatform: factsByPlatform.get(fact.platform) ?? [],
          statesByPlatform: statesByPlatform.get(fact.platform) ?? [],
          stateMap
        });
        const volumeTier = resolveVolumeTier(fact.last3_installs);
        const decision = buildDeterministicDecision({
          state,
          currentEcpi: fact.current_ecpi,
          targetEcpi,
          volumeTier,
          last3Installs: fact.last3_installs,
          last7Installs: fact.last7_installs,
          last7Cost: fact.last7_cost
        });
        if (!shouldCreateRecommendation(decision.action)) {
          continue;
        }

        const metricSettings = resolvePrimaryMetric(app.app_key, fact.platform);
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
          last7Installs: fact.last7_installs
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
          current_roas: null,
          target_roas: null,
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
            last7_installs: fact.last7_installs
          },
          status: 'pending'
        });

        generated += 1;
      }

      details.push({
        app_key: app.app_key,
        generated,
        status: generated > 0 ? 'ok' : 'skipped'
      });
      generatedTotal += generated;
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
    success_count: details.filter((item) => item.status === 'ok').length,
    failed_count: details.filter((item) => item.status === 'failed').length,
    skipped_count: details.filter((item) => item.status === 'skipped').length,
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
