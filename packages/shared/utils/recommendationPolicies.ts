import type {
  RecommendationPolicyActionPlaybook,
  RecommendationPolicyConfigRecord,
  RecommendationPolicyEngine,
  RecommendationPolicyMaturityWindow,
  RecommendationPolicyRelativeCompare,
  RecommendationPolicyRuleJson,
  RecommendationPolicyScenarioRule,
  RecommendationPolicySpendConfig,
  RecommendationPolicyTargetConfig,
  RecommendationThresholdTargets,
  RecommendationTrafficScope
} from '../types/models.js';

type RecommendationPolicyDecisionMode = RecommendationPolicyRuleJson['decision_mode'];

export interface RecommendationPolicyValidationResult {
  rule: RecommendationPolicyRuleJson;
  effective_support: {
    automation_level: 'full' | 'partial';
    supported_features: string[];
    notes: string[];
  };
}

export interface SpendScenarioEvaluationInput {
  avgDailySpend: number;
  spendSeries: number[];
  spendPolicy: RecommendationPolicySpendConfig;
  actionPlaybook: RecommendationPolicyActionPlaybook;
}

export interface SpendScenarioEvaluationResult {
  scenarioTags: string[];
  actionItems: string[];
}

const DEFAULT_CONTEXT_WINDOW_DAYS = [7, 14, 21];
const DEFAULT_MEDIA_SOURCE = 'apple search ads';

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function toPositiveNumber(value: unknown, fallback: number, min = 0, max = Number.MAX_SAFE_INTEGER): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, parsed));
}

function toOptionalPositiveNumber(value: unknown): number | undefined {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return undefined;
  }
  return parsed;
}

function normalizeStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return Array.from(
      new Set(
        value
          .map((item) => String(item || '').trim())
          .filter((item) => item.length > 0)
      )
    );
  }
  if (typeof value === 'string' && value.trim()) {
    return Array.from(
      new Set(
        value
          .split(',')
          .map((item) => item.trim())
          .filter(Boolean)
      )
    );
  }
  return [];
}

function normalizeThresholdTargets(value: unknown): RecommendationThresholdTargets {
  const raw = asObject(value);
  return {
    ecpi_max: toOptionalPositiveNumber(raw.ecpi_max),
    roas_min: toOptionalPositiveNumber(raw.roas_min),
    roas_good: toOptionalPositiveNumber(raw.roas_good),
    cpp_max: toOptionalPositiveNumber(raw.cpp_max),
    cpp_pause_threshold: toOptionalPositiveNumber(raw.cpp_pause_threshold)
  };
}

function normalizeThresholdMap(value: unknown): Record<string, RecommendationThresholdTargets> {
  const raw = asObject(value);
  const normalized: Record<string, RecommendationThresholdTargets> = {};
  for (const [key, target] of Object.entries(raw)) {
    const normalizedKey = String(key || '').trim();
    if (!normalizedKey) {
      continue;
    }
    normalized[normalizedKey] = normalizeThresholdTargets(target);
  }
  return normalized;
}

function normalizeMaturityWindow(value: unknown): RecommendationPolicyMaturityWindow {
  const raw = asObject(value);
  const contextWindowDays = normalizeStringArray(raw.context_window_days)
    .map((item) => Number(item))
    .filter((item) => Number.isFinite(item) && item > 0)
    .map((item) => Math.floor(item));

  return {
    exclude_recent_days: Math.floor(toPositiveNumber(raw.exclude_recent_days, 7, 0, 60)),
    decision_window_days: Math.floor(toPositiveNumber(raw.decision_window_days, 14, 1, 60)),
    context_window_days:
      contextWindowDays.length > 0 ? Array.from(new Set(contextWindowDays)).sort((a, b) => a - b) : DEFAULT_CONTEXT_WINDOW_DAYS
  };
}

function normalizeTargets(value: unknown): RecommendationPolicyTargetConfig {
  const raw = asObject(value);
  return {
    global_targets: normalizeThresholdTargets(raw.global_targets),
    country_targets: normalizeThresholdMap(raw.country_targets),
    media_targets: normalizeThresholdMap(raw.media_targets)
  };
}

function normalizeSpendPolicy(value: unknown): RecommendationPolicySpendConfig {
  const raw = asObject(value);
  return {
    daily_budget_cap_usd: toOptionalPositiveNumber(raw.daily_budget_cap_usd),
    low_spend_threshold_usd: toOptionalPositiveNumber(raw.low_spend_threshold_usd),
    high_spend_threshold_usd: toOptionalPositiveNumber(raw.high_spend_threshold_usd),
    trend_lookback_days: Math.floor(toPositiveNumber(raw.trend_lookback_days, 7, 3, 30)),
    uptrend_min_ratio: toPositiveNumber(raw.uptrend_min_ratio, 0.15, 0, 10)
  };
}

function normalizeScenarioRule(value: unknown, fallbackTags: string[]): RecommendationPolicyScenarioRule {
  const raw = asObject(value);
  return {
    enabled: raw.enabled !== false,
    action_tags: normalizeStringArray(raw.action_tags).length > 0 ? normalizeStringArray(raw.action_tags) : fallbackTags
  };
}

function normalizeActionPlaybook(value: unknown): RecommendationPolicyActionPlaybook {
  const raw = asObject(value);
  return {
    low_spend_signal_weak: normalizeScenarioRule(raw.low_spend_signal_weak, [
      'iterate_creative',
      'increase_spend_capacity'
    ]),
    high_spend_uptrend_expandable: normalizeScenarioRule(raw.high_spend_uptrend_expandable, [
      'raise_roas_target',
      'scale_gradually'
    ])
  };
}

function normalizeRelativeCompare(value: unknown): RecommendationPolicyRelativeCompare {
  const raw = asObject(value);
  const metrics = normalizeStringArray(raw.metrics).filter((item) =>
    ['ctr', 'cvr', 'cpi', 'roas'].includes(item)
  ) as Array<'ctr' | 'cvr' | 'cpi' | 'roas'>;
  return {
    compare_granularity: 'campaign',
    metrics: metrics.length > 0 ? metrics : ['ctr', 'cvr', 'cpi', 'roas'],
    min_peer_count: Math.floor(toPositiveNumber(raw.min_peer_count, 3, 1, 1000)),
    underperform_ratio: toPositiveNumber(raw.underperform_ratio, 0.2, 0.01, 10),
    min_failed_metrics: Math.floor(toPositiveNumber(raw.min_failed_metrics, 2, 1, 4))
  };
}

export function defaultRecommendationPolicyRule(): RecommendationPolicyRuleJson {
  return {
    metric_family: 'ecpi',
    decision_mode: 'deterministic',
    traffic_scope: 'all',
    media_sources: [],
    maturity_window: normalizeMaturityWindow({}),
    targets: normalizeTargets({}),
    spend_policy: normalizeSpendPolicy({}),
    action_playbook: normalizeActionPlaybook({}),
    relative_compare: normalizeRelativeCompare({})
  };
}

export function normalizeRecommendationPolicyRule(value: unknown): RecommendationPolicyRuleJson {
  const raw = asObject(value);
  const metricFamily = ['ecpi', 'd7_roas_cpp', 'relative_compare'].includes(String(raw.metric_family || ''))
    ? (String(raw.metric_family) as RecommendationPolicyRuleJson['metric_family'])
    : 'ecpi';
  const decisionMode = ['deterministic', 'hybrid'].includes(String(raw.decision_mode || ''))
    ? (String(raw.decision_mode) as RecommendationPolicyDecisionMode)
    : 'deterministic';
  const trafficScope = ['all', 'asa_only', 'media_sources'].includes(String(raw.traffic_scope || ''))
    ? (String(raw.traffic_scope) as RecommendationTrafficScope)
    : 'all';

  return {
    metric_family: metricFamily,
    decision_mode: decisionMode,
    traffic_scope: trafficScope,
    media_sources: normalizeStringArray(raw.media_sources),
    maturity_window: normalizeMaturityWindow(raw.maturity_window),
    targets: normalizeTargets(raw.targets),
    spend_policy: normalizeSpendPolicy(raw.spend_policy),
    action_playbook: normalizeActionPlaybook(raw.action_playbook),
    relative_compare: normalizeRelativeCompare(raw.relative_compare)
  };
}

export function isRecommendationPolicyEnabledForMedia(
  rule: RecommendationPolicyRuleJson | null | undefined,
  mediaSource: string
): boolean {
  if (!rule) {
    return true;
  }
  const normalizedMediaSource = String(mediaSource || '').trim().toLowerCase();
  if (rule.traffic_scope === 'all') {
    return true;
  }
  if (rule.traffic_scope === 'asa_only') {
    return normalizedMediaSource === DEFAULT_MEDIA_SOURCE;
  }
  const targets = new Set(rule.media_sources.map((item) => item.trim().toLowerCase()).filter(Boolean));
  if (targets.size === 0) {
    return true;
  }
  return targets.has(normalizedMediaSource);
}

export function resolveRecommendationTarget(
  rule: RecommendationPolicyRuleJson | null | undefined,
  options: { country?: string | null; mediaSource?: string | null }
): RecommendationThresholdTargets {
  if (!rule) {
    return {};
  }
  const countryKey = String(options.country || '').trim();
  if (countryKey && rule.targets.country_targets[countryKey]) {
    return rule.targets.country_targets[countryKey];
  }
  const mediaKey = String(options.mediaSource || '').trim();
  if (mediaKey && rule.targets.media_targets[mediaKey]) {
    return rule.targets.media_targets[mediaKey];
  }
  return rule.targets.global_targets;
}

export function buildRecommendationPolicyKey(appKey: string, platform: string, engine: RecommendationPolicyEngine): string {
  return `${appKey}|${String(platform || 'unknown').trim().toLowerCase()}|${engine}`;
}

export function buildRecommendationPolicyMap(
  rows: RecommendationPolicyConfigRecord[]
): Map<string, RecommendationPolicyConfigRecord> {
  return new Map(rows.map((row) => [buildRecommendationPolicyKey(row.app_key, row.platform, row.engine), row]));
}

function average(values: number[]): number {
  const filtered = values.filter((value) => Number.isFinite(value) && value >= 0);
  if (filtered.length === 0) {
    return 0;
  }
  return filtered.reduce((sum, value) => sum + value, 0) / filtered.length;
}

function defaultActionItemsForTag(tag: string): string[] {
  if (tag === 'low_spend_signal_weak') {
    return ['优先迭代素材，先提升跑量能力。', '当前量级过低，短期 ROAS 波动不宜直接作为强动作依据。'];
  }
  if (tag === 'high_spend_uptrend_expandable') {
    return ['可逐步提高 ROAS 目标后扩量。', '放量时继续观察边际回收，避免粗暴提量。'];
  }
  return [];
}

export function evaluateSpendScenarios(input: SpendScenarioEvaluationInput): SpendScenarioEvaluationResult {
  const scenarioTags: string[] = [];
  const actionItems = new Set<string>();
  const lowSpendThreshold = input.spendPolicy.low_spend_threshold_usd;
  const highSpendThreshold = input.spendPolicy.high_spend_threshold_usd;
  if (
    input.actionPlaybook.low_spend_signal_weak.enabled &&
    lowSpendThreshold != null &&
    input.avgDailySpend > 0 &&
    input.avgDailySpend <= lowSpendThreshold
  ) {
    scenarioTags.push('low_spend_signal_weak');
    for (const item of defaultActionItemsForTag('low_spend_signal_weak')) {
      actionItems.add(item);
    }
  }

  const lookback = Math.max(3, Math.min(input.spendSeries.length, input.spendPolicy.trend_lookback_days));
  const trendSeries = input.spendSeries.slice(-lookback);
  if (
    input.actionPlaybook.high_spend_uptrend_expandable.enabled &&
    highSpendThreshold != null &&
    trendSeries.length >= 4 &&
    input.avgDailySpend >= highSpendThreshold
  ) {
    const splitIndex = Math.max(1, Math.floor(trendSeries.length / 2));
    const firstHalf = trendSeries.slice(0, splitIndex);
    const secondHalf = trendSeries.slice(splitIndex);
    const firstAvg = average(firstHalf);
    const secondAvg = average(secondHalf);
    const thresholdRatio = 1 + Math.max(0, input.spendPolicy.uptrend_min_ratio);
    if (firstAvg > 0 && secondAvg >= firstAvg * thresholdRatio) {
      scenarioTags.push('high_spend_uptrend_expandable');
      for (const item of defaultActionItemsForTag('high_spend_uptrend_expandable')) {
        actionItems.add(item);
      }
    }
  }

  return {
    scenarioTags,
    actionItems: Array.from(actionItems)
  };
}

export function summarizeRecommendationPolicySupport(
  engine: RecommendationPolicyEngine,
  rule: RecommendationPolicyRuleJson
): RecommendationPolicyValidationResult['effective_support'] {
  const supportedFeatures = ['traffic_scope', 'windowing', 'thresholds', 'manual_prompt_markdown', 'spend_scenarios'];
  const notes: string[] = [];
  let automationLevel: 'full' | 'partial' = 'full';

  if (rule.metric_family === 'd7_roas_cpp') {
    supportedFeatures.push('d7_roas_cpp');
    if (engine === 'budget') {
      automationLevel = 'partial';
      notes.push('budget 引擎的 D7 ROAS / CPP 依赖 keyword_value_daily_metrics 中已有成熟价值数据。');
    }
  }

  if (rule.metric_family === 'relative_compare') {
    automationLevel = 'partial';
    supportedFeatures.push('relative_compare');
    notes.push('relative_compare 目前按 campaign 代理比较，CTR 仍依赖后续素材级事实补齐。');
  }

  if (Object.keys(rule.targets.country_targets).length > 0) {
    supportedFeatures.push('country_targets');
    if (engine === 'budget') {
      automationLevel = 'partial';
      notes.push('budget 引擎的国家阈值目前主要用于解释上下文，核心动作仍以可用聚合口径为准。');
    } else {
      notes.push('ASA 引擎会优先读取国家级 eCPI 阈值。');
    }
  }

  if (rule.traffic_scope === 'asa_only') {
    supportedFeatures.push('asa_only');
  }
  if (rule.traffic_scope === 'media_sources') {
    supportedFeatures.push('media_source_filter');
  }

  return {
    automation_level: automationLevel,
    supported_features: Array.from(new Set(supportedFeatures)),
    notes
  };
}
