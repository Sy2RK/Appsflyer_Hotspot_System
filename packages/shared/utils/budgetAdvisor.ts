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

function logInfo(
  logger: BudgetAdvisorLogger | undefined,
  message: string,
  context?: Record<string, unknown>
): void {
  if (logger) {
    logger.info(message, context);
  }
}

function logError(
  logger: BudgetAdvisorLogger | undefined,
  message: string,
  context?: Record<string, unknown>
): void {
  if (logger) {
    logger.error(message, context);
  }
}

function safeNumber(value: unknown, fallback = 0): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function yesterdayDateString(): string {
  const now = new Date();
  const ms = now.getTime() - 24 * 60 * 60 * 1000;
  return new Date(ms).toISOString().slice(0, 10);
}

function buildLookbackStartDate(lookbackDays: number): string {
  const safeDays = Math.max(1, Math.floor(lookbackDays));
  const now = new Date();
  const ms = now.getTime() - (safeDays - 1) * 24 * 60 * 60 * 1000;
  return new Date(ms).toISOString().slice(0, 10);
}

function median(values: number[]): number {
  const list = values.filter((item) => item > 0).sort((a, b) => a - b);
  if (list.length === 0) return 0;
  const mid = Math.floor(list.length / 2);
  if (list.length % 2 === 1) return list[mid];
  return (list[mid - 1] + list[mid]) / 2;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

type VolumeTier = 'low' | 'medium' | 'high';

function resolveVolumeTier(last3Installs: number): VolumeTier {
  if (last3Installs > 30) {
    return 'high';
  }
  if (last3Installs >= 15) {
    return 'medium';
  }
  return 'low';
}

function buildTargetEcpi(states: KeywordLifecycleStateRow[]): number {
  const parsed = states
    .map((state) => parseTrend(state))
    .filter((item) => item.currentOfficialEcpi > 0);

  const prioritized = parsed.filter((item) => item.last3Installs >= 15).map((item) => item.currentOfficialEcpi);
  if (prioritized.length >= 3) {
    return median(prioritized);
  }

  const all = parsed.map((item) => item.currentOfficialEcpi);
  if (all.length > 0) {
    return median(all);
  }

  const fallback = states.map((state) => safeNumber(state.last_cpi)).filter((item) => item > 0);
  return median(fallback);
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

function parseTrend(state: KeywordLifecycleStateRow): {
  last7Cost: number;
  last7Installs: number;
  last7Clicks: number;
  last3Installs: number;
  currentOfficialEcpi: number;
  last3OfficialEcpi: number;
  last7OfficialEcpi: number;
} {
  const raw = state.trend_json;
  if (!raw || typeof raw !== 'object') {
    return {
      last7Cost: safeNumber(state.last_cpi) * safeNumber(state.last_installs),
      last7Installs: safeNumber(state.last_installs),
      last7Clicks: safeNumber(state.last_clicks),
      last3Installs: safeNumber(state.last_installs),
      currentOfficialEcpi: safeNumber(state.last_cpi),
      last3OfficialEcpi: safeNumber(state.last_cpi),
      last7OfficialEcpi: safeNumber(state.last_cpi)
    };
  }

  const trend = raw as Record<string, unknown>;
  const last7 = trend.last7 && typeof trend.last7 === 'object' ? (trend.last7 as Record<string, unknown>) : {};
  const officialEcpi =
    trend.official_ecpi && typeof trend.official_ecpi === 'object'
      ? (trend.official_ecpi as Record<string, unknown>)
      : {};
  return {
    last7Cost: safeNumber(last7.total_cost, safeNumber(state.last_cpi) * safeNumber(state.last_installs)),
    last7Installs: safeNumber(last7.installs, safeNumber(state.last_installs)),
    last7Clicks: safeNumber(last7.clicks, safeNumber(state.last_clicks)),
    last3Installs: safeNumber(trend.last3_installs, safeNumber(state.last_installs)),
    currentOfficialEcpi: safeNumber(officialEcpi.last, safeNumber(state.last_cpi)),
    last3OfficialEcpi: safeNumber(officialEcpi.last3_avg, safeNumber(state.last_cpi)),
    last7OfficialEcpi: safeNumber(officialEcpi.last7_avg, safeNumber(state.last_cpi))
  };
}

function shouldCreateRecommendation(
  action: 'increase' | 'decrease' | 'hold' | 'pause'
): boolean {
  return action !== 'hold';
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
    apps: apps.length
  });

  for (const app of apps) {
    try {
      const states = (await listKeywordLifecycleStatesByApp(app.app_key)).filter(
        (state) => String(state.last_seen_date || '') >= lookbackStartDate
      );
      await expirePendingBudgetRecommendationsForDate(app.app_key, date);
      if (states.length === 0) {
        details.push({
          app_key: app.app_key,
          generated: 0,
          status: 'skipped'
        });
        continue;
      }

      let generated = 0;
      const statesByPlatform = new Map<string, KeywordLifecycleStateRow[]>();
      for (const state of states) {
        const platform = String(state.platform || 'unknown').toLowerCase();
        const list = statesByPlatform.get(platform);
        if (list) {
          list.push(state);
        } else {
          statesByPlatform.set(platform, [state]);
        }
      }

      for (const [platform, platformStates] of statesByPlatform.entries()) {
        const targetEcpi = buildTargetEcpi(platformStates);
        for (const state of platformStates) {
          const trend = parseTrend(state);
          const volumeTier = resolveVolumeTier(trend.last3Installs);
          const currentEcpi = trend.last3OfficialEcpi > 0 ? trend.last3OfficialEcpi : trend.currentOfficialEcpi;
          const decision = buildDeterministicDecision({
            state,
            currentEcpi,
            targetEcpi,
            volumeTier,
            last3Installs: trend.last3Installs,
            last7Installs: trend.last7Installs,
            last7Cost: trend.last7Cost
          });
          if (!shouldCreateRecommendation(decision.action)) {
            continue;
          }

          const currentCost = Math.max(0, trend.last7Cost);
          const suggestedBudget = Math.max(0, currentCost * (1 + decision.changeRatio));
          const expectedInstallsDelta =
            decision.action === 'increase'
              ? trend.last7Installs * Math.abs(decision.changeRatio) * 0.7
              : decision.action === 'decrease'
                ? -trend.last7Installs * Math.abs(decision.changeRatio) * 0.6
                : decision.action === 'pause'
                  ? -trend.last7Installs
                  : 0;

          const llm = await explainBudgetRecommendationWithLlm({
            appKey: app.app_key,
            platform: state.platform || 'unknown',
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
            currentEcpi,
            targetEcpi,
            volumeTier: decision.volumeTier,
            last3Installs: trend.last3Installs,
            last7Installs: trend.last7Installs
          });

          await insertLlmAuditLog({
            biz_type: 'budget_recommendation',
            biz_id: `${app.app_key}|${state.platform}|${state.keyword}|${state.match_type}|${date}`,
            model: llm.model,
            prompt_hash: llm.promptHash,
            response_json: llm.raw,
            latency_ms: llm.latencyMs,
            success: llm.ok
          });

          await upsertBudgetRecommendation({
            app_key: app.app_key,
            platform,
            keyword: state.keyword,
            match_type: state.match_type,
            date,
            action: decision.action,
            change_ratio: decision.changeRatio,
            suggested_budget: suggestedBudget,
            current_cost: currentCost,
            current_ecpi: currentEcpi,
            target_ecpi: targetEcpi,
            volume_tier: decision.volumeTier,
            expected_installs_delta: expectedInstallsDelta,
            confidence: decision.confidence,
            reason_code: decision.reasonCode,
            llm_summary: {
              ...llm.output,
              current_ecpi: currentEcpi,
              target_ecpi: targetEcpi,
              volume_tier: decision.volumeTier,
              last3_installs: trend.last3Installs,
              last7_installs: trend.last7Installs
            },
            status: 'pending'
          });

          generated += 1;
        }
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
