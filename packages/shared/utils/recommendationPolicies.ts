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

export class RecommendationPolicyValidationError extends Error {
  code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = 'RecommendationPolicyValidationError';
  }
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

export interface RelativeCompareMetricSample {
  metric: 'ctr' | 'cvr' | 'cpi' | 'roas';
  current: number | null;
  peers: number[];
}

export interface RelativeCompareDecisionResult {
  availableMetrics: string[];
  failedMetrics: string[];
  strongMetrics: string[];
  peerCounts: Record<string, number>;
}

const DEFAULT_CONTEXT_WINDOW_DAYS = [7, 14, 21];
const DEFAULT_MEDIA_SOURCE = 'apple search ads';

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function assertNoUnknownKeys(scope: string, value: Record<string, unknown>, allowedKeys: string[]): void {
  const allowed = new Set(allowedKeys);
  const unknownKeys = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknownKeys.length > 0) {
    throw new RecommendationPolicyValidationError(
      'invalid_rule_json',
      `${scope} 包含未支持字段: ${unknownKeys.join(', ')}`
    );
  }
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

function validateThresholdTargets(scope: string, value: unknown): void {
  const raw = asObject(value);
  assertNoUnknownKeys(scope, raw, ['ecpi_max', 'roas_min', 'roas_good', 'cpp_max', 'cpp_pause_threshold']);
  for (const [key, entry] of Object.entries(raw)) {
    const parsed = Number(entry);
    if (!Number.isFinite(parsed) || parsed < 0) {
      throw new RecommendationPolicyValidationError('invalid_rule_json', `${scope}.${key} 必须是大于等于 0 的数字`);
    }
  }
}

function validateThresholdMap(scope: string, value: unknown): void {
  const raw = asObject(value);
  for (const [targetKey, targetValue] of Object.entries(raw)) {
    if (!String(targetKey || '').trim()) {
      throw new RecommendationPolicyValidationError('invalid_rule_json', `${scope} 不能包含空键名`);
    }
    validateThresholdTargets(`${scope}.${targetKey}`, targetValue);
  }
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

export function validateRecommendationPolicyRule(value: unknown): RecommendationPolicyValidationResult {
  const raw = asObject(value);
  if (Object.keys(raw).length === 0) {
    throw new RecommendationPolicyValidationError('invalid_rule_json', 'ruleJson 不能为空');
  }
  assertNoUnknownKeys('ruleJson', raw, [
    'metric_family',
    'decision_mode',
    'traffic_scope',
    'media_sources',
    'maturity_window',
    'targets',
    'spend_policy',
    'action_playbook',
    'relative_compare'
  ]);

  if (!['ecpi', 'd7_roas_cpp', 'relative_compare'].includes(String(raw.metric_family || ''))) {
    throw new RecommendationPolicyValidationError('invalid_metric_family', 'metric_family 非法');
  }
  if (!['deterministic', 'hybrid'].includes(String(raw.decision_mode || ''))) {
    throw new RecommendationPolicyValidationError('invalid_decision_mode', 'decision_mode 非法');
  }
  if (!['all', 'asa_only', 'media_sources'].includes(String(raw.traffic_scope || ''))) {
    throw new RecommendationPolicyValidationError('invalid_traffic_scope', 'traffic_scope 非法');
  }

  const mediaSources = normalizeStringArray(raw.media_sources);
  if (String(raw.traffic_scope) === 'media_sources' && mediaSources.length === 0) {
    throw new RecommendationPolicyValidationError(
      'invalid_media_sources',
      'traffic_scope=media_sources 时必须提供至少一个媒体源'
    );
  }

  const maturityWindow = asObject(raw.maturity_window);
  assertNoUnknownKeys('ruleJson.maturity_window', maturityWindow, [
    'exclude_recent_days',
    'decision_window_days',
    'context_window_days'
  ]);
  if (!Number.isFinite(Number(maturityWindow.exclude_recent_days ?? 7)) || Number(maturityWindow.exclude_recent_days ?? 7) < 0) {
    throw new RecommendationPolicyValidationError('invalid_window', 'exclude_recent_days 必须是大于等于 0 的数字');
  }
  if (!Number.isFinite(Number(maturityWindow.decision_window_days ?? 14)) || Number(maturityWindow.decision_window_days ?? 14) <= 0) {
    throw new RecommendationPolicyValidationError('invalid_window', 'decision_window_days 必须是大于 0 的数字');
  }
  if (
    maturityWindow.context_window_days !== undefined &&
    !Array.isArray(maturityWindow.context_window_days) &&
    typeof maturityWindow.context_window_days !== 'string'
  ) {
    throw new RecommendationPolicyValidationError('invalid_window', 'context_window_days 必须是数组或逗号分隔字符串');
  }

  const targets = asObject(raw.targets);
  assertNoUnknownKeys('ruleJson.targets', targets, ['global_targets', 'country_targets', 'media_targets']);
  validateThresholdTargets('ruleJson.targets.global_targets', targets.global_targets);
  validateThresholdMap('ruleJson.targets.country_targets', targets.country_targets);
  validateThresholdMap('ruleJson.targets.media_targets', targets.media_targets);

  const spendPolicy = asObject(raw.spend_policy);
  assertNoUnknownKeys('ruleJson.spend_policy', spendPolicy, [
    'daily_budget_cap_usd',
    'low_spend_threshold_usd',
    'high_spend_threshold_usd',
    'trend_lookback_days',
    'uptrend_min_ratio'
  ]);

  const actionPlaybook = asObject(raw.action_playbook);
  assertNoUnknownKeys('ruleJson.action_playbook', actionPlaybook, [
    'low_spend_signal_weak',
    'high_spend_uptrend_expandable'
  ]);
  for (const [key, scenario] of Object.entries(actionPlaybook)) {
    const rawScenario = asObject(scenario);
    assertNoUnknownKeys(`ruleJson.action_playbook.${key}`, rawScenario, ['enabled', 'action_tags']);
  }

  const relativeCompare = asObject(raw.relative_compare);
  assertNoUnknownKeys('ruleJson.relative_compare', relativeCompare, [
    'compare_granularity',
    'metrics',
    'min_peer_count',
    'underperform_ratio',
    'min_failed_metrics'
  ]);
  if (
    relativeCompare.compare_granularity !== undefined &&
    String(relativeCompare.compare_granularity) !== 'campaign'
  ) {
    throw new RecommendationPolicyValidationError('invalid_relative_compare', 'compare_granularity 目前仅支持 campaign');
  }
  const relativeMetrics = normalizeStringArray(relativeCompare.metrics);
  if (relativeMetrics.some((metric) => !['ctr', 'cvr', 'cpi', 'roas'].includes(metric))) {
    throw new RecommendationPolicyValidationError('invalid_relative_compare', 'relative_compare.metrics 包含未支持指标');
  }
  if (String(raw.metric_family) === 'relative_compare' && relativeMetrics.length === 0) {
    throw new RecommendationPolicyValidationError('invalid_relative_compare', '同类对比判断至少需要选择 1 个比较指标');
  }

  const rule = normalizeRecommendationPolicyRule(raw);
  return {
    rule,
    effective_support: summarizeRecommendationPolicySupport('budget', rule)
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

function percentile(values: number[], ratio: number): number {
  const items = values.filter((item) => Number.isFinite(item)).sort((a, b) => a - b);
  if (items.length === 0) return 0;
  if (items.length === 1) return items[0];
  const index = (items.length - 1) * Math.min(Math.max(ratio, 0), 1);
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) {
    return items[lower];
  }
  const weight = index - lower;
  return items[lower] * (1 - weight) + items[upper] * weight;
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

export function evaluateRelativeCompareMetrics(
  samples: RelativeCompareMetricSample[],
  options: { minPeerCount: number; underperformRatio: number }
): RelativeCompareDecisionResult {
  const availableMetrics: string[] = [];
  const failedMetrics: string[] = [];
  const strongMetrics: string[] = [];
  const peerCounts: Record<string, number> = {};

  for (const sample of samples) {
    const peers = sample.peers.filter((value) => Number.isFinite(value) && value > 0);
    peerCounts[sample.metric] = peers.length;
    if (sample.current == null || !Number.isFinite(sample.current) || peers.length < options.minPeerCount) {
      continue;
    }
    const peerMedian = percentile(peers, 0.5);
    if (!Number.isFinite(peerMedian) || peerMedian <= 0) {
      continue;
    }
    availableMetrics.push(sample.metric);
    const threshold = Math.max(0, options.underperformRatio);
    if (sample.metric === 'cpi') {
      if (sample.current > peerMedian * (1 + threshold)) {
        failedMetrics.push(sample.metric);
      } else if (sample.current < peerMedian * (1 - threshold)) {
        strongMetrics.push(sample.metric);
      }
      continue;
    }
    if (sample.current < peerMedian * (1 - threshold)) {
      failedMetrics.push(sample.metric);
    } else if (sample.current > peerMedian * (1 + threshold)) {
      strongMetrics.push(sample.metric);
    }
  }

  return {
    availableMetrics,
    failedMetrics,
    strongMetrics,
    peerCounts
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
    notes.push('relative_compare 已接入 evaluator，当前按 campaign 代理比较，CTR 仍依赖后续素材级事实补齐。');
  }

  if (Object.keys(rule.targets.country_targets).length > 0) {
    supportedFeatures.push('country_targets');
    if (engine === 'budget') {
      notes.push('budget 引擎会在国家聚合口径可用时参与国家级 eCPI 阈值判断。');
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
