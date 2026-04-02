const THRESHOLD_FIELDS = ['ecpi_max', 'roas_min', 'roas_good', 'cpp_max', 'cpp_pause_threshold'];
const DEFAULT_CONTEXT_WINDOWS = [7, 14, 21];
const DEFAULT_RELATIVE_METRICS = ['ctr', 'cvr', 'cpi', 'roas'];
const DEFAULT_ADJUSTMENT_POLICY = {
  default_increase_ratio: '0.2',
  default_decrease_ratio: '0.2',
  high_spend_uptrend_increase_ratio: '0.3'
};
const THRESHOLD_FIELDS_BY_METRIC_FAMILY = {
  ecpi: ['ecpi_max'],
  d7_roas_cpp: ['roas_min', 'roas_good', 'cpp_max', 'cpp_pause_threshold'],
  relative_compare: []
};

let rowIdSeed = 0;

export const POLICY_ENGINE_LABELS = {
  budget: '常规预算建议',
  asa: 'ASA'
};

export const POLICY_METRIC_FAMILY_LABELS = {
  ecpi: 'eCPI',
  d7_roas_cpp: 'D7 ROAS + CPP',
  relative_compare: '同类对比判断'
};

export const POLICY_DECISION_MODE_LABELS = {
  deterministic: '按固定规则判断',
  hybrid: '规则 + AI 辅助判断'
};

export const POLICY_TRAFFIC_SCOPE_LABELS = {
  all: '全部流量',
  asa_only: '仅 ASA',
  media_sources: '指定媒体源'
};

export const POLICY_RELATIVE_METRIC_LABELS = {
  ctr: 'CTR',
  cvr: 'CVR',
  cpi: 'CPI',
  roas: 'ROAS'
};

export const POLICY_ERROR_MESSAGES = {
  appKey_platform_engine_required: '请先选择应用、平台和建议类型。',
  invalid_platform: '当前平台无效，请重新选择平台。',
  asa_requires_ios: 'ASA 规则只支持 iOS，请改为 iOS 后再保存。',
  app_not_found: '未找到对应应用，请先检查应用是否已在应用设置里创建。',
  app_platform_not_supported: '当前应用不支持这个平台，请重新选择应用或平台。',
  invalid_metric_family: '优化目标类型无效，请重新选择核心指标。',
  invalid_decision_mode: '判断方式无效，请重新选择决策方式。',
  invalid_traffic_scope: '流量范围无效，请重新选择流量范围。',
  invalid_media_sources: '已选择指定媒体源，但媒体源列表为空，请至少添加一个媒体源。',
  invalid_window: '观察窗口设置无效，请检查排除天数和窗口天数。',
  invalid_rule_json: '当前规则内容不完整，请检查阈值和限制条件。',
  invalid_relative_compare: '同类对比判断设置无效，请检查对比指标和阈值。'
};

function createRowId(prefix) {
  rowIdSeed += 1;
  return `${prefix}_${rowIdSeed}`;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function deepClone(value) {
  return JSON.parse(JSON.stringify(value ?? {}));
}

function toInputValue(value) {
  return value == null || value === '' ? '' : String(value);
}

function toTrimmedString(value) {
  return String(value ?? '').trim();
}

function toRawString(value) {
  return value == null ? '' : String(value);
}

function toNumberOrUndefined(value) {
  const text = toTrimmedString(value);
  if (!text) {
    return undefined;
  }
  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function toPositiveIntegerOrUndefined(value) {
  const parsed = toNumberOrUndefined(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function normalizeStringList(values) {
  return Array.from(
    new Set(
      (Array.isArray(values) ? values : [])
        .map((item) => toTrimmedString(item))
        .filter(Boolean)
    )
  );
}

function normalizePositiveIntegerList(values) {
  return Array.from(
    new Set(
      normalizeStringList(values)
        .map((item) => toPositiveIntegerOrUndefined(item))
        .filter((item) => item !== undefined)
    )
  ).sort((left, right) => left - right);
}

function sortObjectKeys(value) {
  if (Array.isArray(value)) {
    return value.map((item) => sortObjectKeys(item));
  }
  if (!isPlainObject(value)) {
    return value;
  }
  return Object.keys(value)
    .sort()
    .reduce((accumulator, key) => {
      accumulator[key] = sortObjectKeys(value[key]);
      return accumulator;
    }, {});
}

function buildThresholdInputValues(values = {}) {
  return THRESHOLD_FIELDS.reduce((accumulator, field) => {
    accumulator[field] = toInputValue(values[field]);
    return accumulator;
  }, {});
}

function buildTargetRow(kind, key = '', values = {}) {
  return {
    id: createRowId(kind),
    key: toTrimmedString(key),
    ...buildThresholdInputValues(values)
  };
}

function buildTargetRows(kind, targetMap = {}) {
  if (!isPlainObject(targetMap) || Object.keys(targetMap).length === 0) {
    return [];
  }
  return Object.entries(targetMap).map(([key, value]) => buildTargetRow(kind, key, value));
}

function buildTargetMap(rows) {
  const targetMap = {};
  for (const row of Array.isArray(rows) ? rows : []) {
    const key = toTrimmedString(row?.key);
    if (!key) {
      continue;
    }
    const values = {};
    for (const field of THRESHOLD_FIELDS) {
      const parsed = toNumberOrUndefined(row?.[field]);
      if (parsed !== undefined) {
        values[field] = parsed;
      }
    }
    if (Object.keys(values).length > 0) {
      targetMap[key] = values;
    }
  }
  return targetMap;
}

function buildThresholdObject(values = {}) {
  return THRESHOLD_FIELDS.reduce((accumulator, field) => {
    const parsed = toNumberOrUndefined(values[field]);
    if (parsed !== undefined) {
      accumulator[field] = parsed;
    }
    return accumulator;
  }, {});
}

function createBaseDraft(selection = {}) {
  return {
    selection: {
      platform: toTrimmedString(selection.platform).toLowerCase(),
      appKey: toTrimmedString(selection.appKey),
      engine: toTrimmedString(selection.engine).toLowerCase()
    },
    metricFamily: 'ecpi',
    decisionMode: 'deterministic',
    trafficScope: 'all',
    mediaSources: [],
    excludeRecentDays: '7',
    decisionWindowDays: '14',
    contextWindowDays: DEFAULT_CONTEXT_WINDOWS.slice(),
    globalTargets: buildThresholdInputValues({}),
    countryTargets: [],
    mediaTargets: [],
    spendPolicy: {
      daily_budget_cap_usd: '',
      low_spend_threshold_usd: '',
      high_spend_threshold_usd: '',
      trend_lookback_days: '7',
      uptrend_min_ratio: '0.15'
    },
    adjustmentPolicy: {
      default_increase_ratio: DEFAULT_ADJUSTMENT_POLICY.default_increase_ratio,
      default_decrease_ratio: DEFAULT_ADJUSTMENT_POLICY.default_decrease_ratio,
      high_spend_uptrend_increase_ratio: DEFAULT_ADJUSTMENT_POLICY.high_spend_uptrend_increase_ratio
    },
    relativeCompare: {
      metrics: DEFAULT_RELATIVE_METRICS.slice(),
      underperform_ratio: '0.2',
      min_peer_count: '3',
      min_failed_metrics: '2'
    },
    manualPromptMarkdown: '',
    enabled: true
  };
}

export function createPolicyTemplate(selection = {}, templateKind = 'recommended') {
  const draft = createBaseDraft(selection);
  if (templateKind === 'recommended') {
    draft.trafficScope = draft.selection.engine === 'asa' ? 'asa_only' : 'all';
    draft.spendPolicy.low_spend_threshold_usd = '10';
    draft.spendPolicy.high_spend_threshold_usd = '100';
  }
  return draft;
}

export function buildPolicyDraftFromRow(row = {}) {
  const rule = isPlainObject(row.rule_json) ? row.rule_json : {};
  const targets = isPlainObject(rule.targets) ? rule.targets : {};
  const maturityWindow = isPlainObject(rule.maturity_window) ? rule.maturity_window : {};
  const spendPolicy = isPlainObject(rule.spend_policy) ? rule.spend_policy : {};
  const adjustmentPolicy = isPlainObject(rule.adjustment_policy) ? rule.adjustment_policy : {};
  const relativeCompare = isPlainObject(rule.relative_compare) ? rule.relative_compare : {};
  const draft = createBaseDraft({
    platform: row.platform,
    appKey: row.app_key,
    engine: row.engine
  });

  draft.metricFamily = toTrimmedString(rule.metric_family || 'ecpi') || 'ecpi';
  draft.decisionMode = toTrimmedString(rule.decision_mode || 'deterministic') || 'deterministic';
  draft.trafficScope = toTrimmedString(rule.traffic_scope || 'all') || 'all';
  draft.mediaSources = normalizeStringList(rule.media_sources);
  draft.excludeRecentDays = toInputValue(maturityWindow.exclude_recent_days ?? 7);
  draft.decisionWindowDays = toInputValue(maturityWindow.decision_window_days ?? 14);
  draft.contextWindowDays = normalizePositiveIntegerList(maturityWindow.context_window_days);
  if (draft.contextWindowDays.length === 0) {
    draft.contextWindowDays = DEFAULT_CONTEXT_WINDOWS.slice();
  }
  draft.globalTargets = buildThresholdInputValues(targets.global_targets || {});
  draft.countryTargets = buildTargetRows('country', targets.country_targets);
  draft.mediaTargets = buildTargetRows('media', targets.media_targets);
  draft.spendPolicy = {
    daily_budget_cap_usd: toInputValue(spendPolicy.daily_budget_cap_usd),
    low_spend_threshold_usd: toInputValue(spendPolicy.low_spend_threshold_usd),
    high_spend_threshold_usd: toInputValue(spendPolicy.high_spend_threshold_usd),
    trend_lookback_days: toInputValue(spendPolicy.trend_lookback_days ?? 7),
    uptrend_min_ratio: toInputValue(spendPolicy.uptrend_min_ratio ?? 0.15)
  };
  draft.adjustmentPolicy = {
    default_increase_ratio: toInputValue(adjustmentPolicy.default_increase_ratio ?? DEFAULT_ADJUSTMENT_POLICY.default_increase_ratio),
    default_decrease_ratio: toInputValue(adjustmentPolicy.default_decrease_ratio ?? DEFAULT_ADJUSTMENT_POLICY.default_decrease_ratio),
    high_spend_uptrend_increase_ratio: toInputValue(
      adjustmentPolicy.high_spend_uptrend_increase_ratio ?? DEFAULT_ADJUSTMENT_POLICY.high_spend_uptrend_increase_ratio
    )
  };
  draft.relativeCompare = {
    metrics: normalizeStringList(relativeCompare.metrics).filter((metric) => POLICY_RELATIVE_METRIC_LABELS[metric]),
    underperform_ratio: toInputValue(relativeCompare.underperform_ratio ?? 0.2),
    min_peer_count: toInputValue(relativeCompare.min_peer_count ?? 3),
    min_failed_metrics: toInputValue(relativeCompare.min_failed_metrics ?? 2)
  };
  if (draft.relativeCompare.metrics.length === 0) {
    draft.relativeCompare.metrics = DEFAULT_RELATIVE_METRICS.slice();
  }
  draft.manualPromptMarkdown = toRawString(row.manual_prompt_markdown);
  draft.enabled = row.enabled !== false;
  return draft;
}

function sanitizeThresholdInputs(values = {}, allowedFields = []) {
  return THRESHOLD_FIELDS.reduce((accumulator, field) => {
    accumulator[field] = allowedFields.includes(field) ? toInputValue(values[field]) : '';
    return accumulator;
  }, {});
}

function sanitizeTargetRows(rows = [], allowedFields = []) {
  if (allowedFields.length === 0) {
    return [];
  }
  return (Array.isArray(rows) ? rows : []).map((row) => ({
    id: row?.id || createRowId('target'),
    key: toTrimmedString(row?.key),
    ...sanitizeThresholdInputs(row, allowedFields)
  }));
}

export function sanitizeRecommendationPolicyDraft(draft = {}, metricFamilyOverride) {
  const sanitized = deepClone(draft);
  const metricFamily = toTrimmedString(metricFamilyOverride || sanitized.metricFamily || 'ecpi') || 'ecpi';
  const allowedFields = THRESHOLD_FIELDS_BY_METRIC_FAMILY[metricFamily] || THRESHOLD_FIELDS_BY_METRIC_FAMILY.ecpi;
  sanitized.metricFamily = metricFamily;
  sanitized.globalTargets = sanitizeThresholdInputs(sanitized.globalTargets, allowedFields);
  if (metricFamily === 'relative_compare') {
    sanitized.countryTargets = [];
    sanitized.mediaTargets = [];
  } else {
    sanitized.countryTargets = sanitizeTargetRows(sanitized.countryTargets, allowedFields);
    sanitized.mediaTargets = sanitizeTargetRows(sanitized.mediaTargets, allowedFields);
  }
  return sanitized;
}

function applyControlledNumberFields(target, source, fields) {
  for (const field of fields) {
    const value = toNumberOrUndefined(source?.[field]);
    if (value === undefined) {
      delete target[field];
    } else {
      target[field] = value;
    }
  }
}

export function mergeRecommendationPolicyRule(baseRule = {}, draft = {}) {
  const metricFamily = toTrimmedString(draft.metricFamily || 'ecpi') || 'ecpi';
  const allowedFields = THRESHOLD_FIELDS_BY_METRIC_FAMILY[metricFamily] || THRESHOLD_FIELDS_BY_METRIC_FAMILY.ecpi;
  const sanitizedDraft = sanitizeRecommendationPolicyDraft(draft, metricFamily);
  const result = isPlainObject(baseRule) ? deepClone(baseRule) : {};

  result.metric_family = metricFamily;
  result.decision_mode = toTrimmedString(sanitizedDraft.decisionMode || 'deterministic') || 'deterministic';
  result.traffic_scope = toTrimmedString(sanitizedDraft.trafficScope || 'all') || 'all';
  result.media_sources = normalizeStringList(sanitizedDraft.mediaSources);

  const maturityWindow = isPlainObject(result.maturity_window) ? result.maturity_window : {};
  result.maturity_window = maturityWindow;
  maturityWindow.exclude_recent_days = toNumberOrUndefined(sanitizedDraft.excludeRecentDays) ?? 7;
  maturityWindow.decision_window_days = toNumberOrUndefined(sanitizedDraft.decisionWindowDays) ?? 14;
  maturityWindow.context_window_days = normalizePositiveIntegerList(sanitizedDraft.contextWindowDays);
  if (maturityWindow.context_window_days.length === 0) {
    maturityWindow.context_window_days = DEFAULT_CONTEXT_WINDOWS.slice();
  }

  const targets = isPlainObject(result.targets) ? result.targets : {};
  result.targets = targets;
  const globalTargets = isPlainObject(targets.global_targets) ? targets.global_targets : {};
  targets.global_targets = globalTargets;
  applyControlledNumberFields(globalTargets, sanitizedDraft.globalTargets, allowedFields);
  for (const field of THRESHOLD_FIELDS) {
    if (!allowedFields.includes(field)) {
      delete globalTargets[field];
    }
  }

  const countryTargets = buildTargetMap(sanitizedDraft.countryTargets);
  if (Object.keys(countryTargets).length === 0) {
    delete targets.country_targets;
  } else {
    targets.country_targets = countryTargets;
  }

  const mediaTargets = buildTargetMap(sanitizedDraft.mediaTargets);
  if (Object.keys(mediaTargets).length === 0) {
    delete targets.media_targets;
  } else {
    targets.media_targets = mediaTargets;
  }

  const spendPolicy = isPlainObject(result.spend_policy) ? result.spend_policy : {};
  result.spend_policy = spendPolicy;
  applyControlledNumberFields(spendPolicy, sanitizedDraft.spendPolicy, [
    'daily_budget_cap_usd',
    'low_spend_threshold_usd',
    'high_spend_threshold_usd',
    'trend_lookback_days',
    'uptrend_min_ratio'
  ]);
  if (toNumberOrUndefined(sanitizedDraft.spendPolicy?.trend_lookback_days) === undefined) {
    spendPolicy.trend_lookback_days = 7;
  }
  if (toNumberOrUndefined(sanitizedDraft.spendPolicy?.uptrend_min_ratio) === undefined) {
    spendPolicy.uptrend_min_ratio = 0.15;
  }

  const adjustmentPolicy = isPlainObject(result.adjustment_policy) ? result.adjustment_policy : {};
  result.adjustment_policy = adjustmentPolicy;
  applyControlledNumberFields(adjustmentPolicy, sanitizedDraft.adjustmentPolicy, [
    'default_increase_ratio',
    'default_decrease_ratio',
    'high_spend_uptrend_increase_ratio'
  ]);
  if (toNumberOrUndefined(sanitizedDraft.adjustmentPolicy?.default_increase_ratio) === undefined) {
    adjustmentPolicy.default_increase_ratio = Number(DEFAULT_ADJUSTMENT_POLICY.default_increase_ratio);
  }
  if (toNumberOrUndefined(sanitizedDraft.adjustmentPolicy?.default_decrease_ratio) === undefined) {
    adjustmentPolicy.default_decrease_ratio = Number(DEFAULT_ADJUSTMENT_POLICY.default_decrease_ratio);
  }
  if (toNumberOrUndefined(sanitizedDraft.adjustmentPolicy?.high_spend_uptrend_increase_ratio) === undefined) {
    adjustmentPolicy.high_spend_uptrend_increase_ratio = Number(
      DEFAULT_ADJUSTMENT_POLICY.high_spend_uptrend_increase_ratio
    );
  }

  if (metricFamily === 'relative_compare') {
    const relativeCompare = isPlainObject(result.relative_compare) ? result.relative_compare : {};
    result.relative_compare = relativeCompare;
    relativeCompare.compare_granularity = 'campaign';
    relativeCompare.metrics = normalizeStringList(sanitizedDraft.relativeCompare?.metrics).filter(
      (metric) => POLICY_RELATIVE_METRIC_LABELS[metric]
    );
    relativeCompare.underperform_ratio = toNumberOrUndefined(sanitizedDraft.relativeCompare?.underperform_ratio) ?? 0.2;
    relativeCompare.min_peer_count = toNumberOrUndefined(sanitizedDraft.relativeCompare?.min_peer_count) ?? 3;
    relativeCompare.min_failed_metrics = toNumberOrUndefined(sanitizedDraft.relativeCompare?.min_failed_metrics) ?? 2;
  } else {
    delete result.relative_compare;
  }

  return result;
}

export function buildRecommendationPolicySnapshot(draft = {}) {
  return JSON.stringify(sortObjectKeys(draft));
}

function formatNumber(value) {
  if (value == null || value === '') {
    return '';
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return String(value);
  }
  return Number.isInteger(parsed) ? String(parsed) : parsed.toFixed(parsed >= 10 ? 0 : 2).replace(/\.?0+$/, '');
}

function summarizeAdjustmentPolicy(rule) {
  const adjustmentPolicy = isPlainObject(rule.adjustment_policy) ? rule.adjustment_policy : {};
  const increaseRatio = Number(adjustmentPolicy.default_increase_ratio);
  const decreaseRatio = Number(adjustmentPolicy.default_decrease_ratio);
  const highSpendIncreaseRatio = Number(adjustmentPolicy.high_spend_uptrend_increase_ratio);
  if (
    !Number.isFinite(increaseRatio) ||
    !Number.isFinite(decreaseRatio) ||
    !Number.isFinite(highSpendIncreaseRatio) ||
    (increaseRatio === 0.2 && decreaseRatio === 0.2 && highSpendIncreaseRatio === 0.3)
  ) {
    return '';
  }
  return `上调 ${formatNumber(increaseRatio * 100)}% / 下调 ${formatNumber(decreaseRatio * 100)}% / 高花费扩量 ${formatNumber(highSpendIncreaseRatio * 100)}%`;
}

function summarizeObjective(rule) {
  if (rule.metric_family === 'd7_roas_cpp') {
    return '以 D7 ROAS 和 CPP 为核心目标';
  }
  if (rule.metric_family === 'relative_compare') {
    return '按同类对比表现判断是否调控';
  }
  return '以 eCPI 为核心目标';
}

function summarizeScope(rule) {
  if (rule.traffic_scope === 'asa_only') {
    return '仅 ASA';
  }
  if (rule.traffic_scope === 'media_sources') {
    const sources = normalizeStringList(rule.media_sources);
    if (sources.length === 0) {
      return '指定媒体源';
    }
    if (sources.length <= 2) {
      return sources.join('、');
    }
    return `${sources.slice(0, 2).join('、')} 等 ${sources.length} 个媒体源`;
  }
  return '全部流量';
}

function summarizeThresholds(rule) {
  const targets = isPlainObject(rule.targets) ? rule.targets : {};
  const globalTargets = isPlainObject(targets.global_targets) ? targets.global_targets : {};
  const countryCount = Object.keys(isPlainObject(targets.country_targets) ? targets.country_targets : {}).length;
  const mediaCount = Object.keys(isPlainObject(targets.media_targets) ? targets.media_targets : {}).length;

  if (rule.metric_family === 'd7_roas_cpp') {
    const parts = [];
    if (globalTargets.roas_min != null) parts.push(`ROAS ≥ ${formatNumber(globalTargets.roas_min)}`);
    if (globalTargets.roas_good != null) parts.push(`优秀线 ≥ ${formatNumber(globalTargets.roas_good)}`);
    if (globalTargets.cpp_max != null) parts.push(`CPP ≤ ${formatNumber(globalTargets.cpp_max)}`);
    if (globalTargets.cpp_pause_threshold != null) parts.push(`暂停线 ≥ ${formatNumber(globalTargets.cpp_pause_threshold)}`);
    const adjustmentSummary = summarizeAdjustmentPolicy(rule);
    if (adjustmentSummary) parts.push(adjustmentSummary);
    return parts.join(' · ') || '按 ROAS 与 CPP 共同判断';
  }

  if (rule.metric_family === 'relative_compare') {
    const relativeCompare = isPlainObject(rule.relative_compare) ? rule.relative_compare : {};
    const metrics = normalizeStringList(relativeCompare.metrics).map((metric) => POLICY_RELATIVE_METRIC_LABELS[metric] || metric);
    const parts = [];
    if (metrics.length > 0) parts.push(`比较 ${metrics.join(' / ')}`);
    if (relativeCompare.underperform_ratio != null) {
      parts.push(`明显落后阈值 ${formatNumber(Number(relativeCompare.underperform_ratio) * 100)}%`);
    }
    if (relativeCompare.min_peer_count != null) parts.push(`至少 ${formatNumber(relativeCompare.min_peer_count)} 个对比对象`);
    const adjustmentSummary = summarizeAdjustmentPolicy(rule);
    if (adjustmentSummary) parts.push(adjustmentSummary);
    return parts.join(' · ') || '按同类对比判断';
  }

  const parts = [];
  if (globalTargets.ecpi_max != null) {
    parts.push(`eCPI ≤ ${formatNumber(globalTargets.ecpi_max)}`);
  }
  if (countryCount > 0) {
    parts.push(`${countryCount} 个国家单独阈值`);
  }
  if (mediaCount > 0) {
    parts.push(`${mediaCount} 个媒体源单独阈值`);
  }
  const adjustmentSummary = summarizeAdjustmentPolicy(rule);
  if (adjustmentSummary) parts.push(adjustmentSummary);
  return parts.join(' · ') || '按 eCPI 判断';
}

function summarizeSupport(effectiveSupport = {}) {
  const supportLabel = effectiveSupport?.automation_level === 'full' ? '完整支持' : '部分支持';
  const note = Array.isArray(effectiveSupport?.notes) && effectiveSupport.notes[0] ? String(effectiveSupport.notes[0]) : '';
  return {
    supportLabel,
    note
  };
}

export function buildRecommendationPolicyTableSummary(row = {}) {
  const rule = isPlainObject(row.rule_json) ? row.rule_json : {};
  const support = summarizeSupport(row.effective_support);
  return {
    objective: summarizeObjective(rule),
    scope: summarizeScope(rule),
    thresholds: summarizeThresholds(rule),
    supportLabel: support.supportLabel,
    supportNote: support.note
  };
}

export function buildRecommendationPolicyReviewSummary(input = {}) {
  const rule = isPlainObject(input.ruleJson) ? input.ruleJson : {};
  return {
    objective: summarizeObjective(rule),
    scope: summarizeScope(rule),
    thresholds: summarizeThresholds(rule),
    supportLabel: input.supportLabel || '保存后按当前规则生效',
    impactItems: [
      { label: '当前应用', value: input.appName || '-' },
      { label: '当前平台', value: input.platformLabel || '-' },
      { label: '当前建议类型', value: input.engineLabel || '-' },
      { label: '是否立即生效', value: input.enabled ? '立即生效' : '先保存为停用状态' },
      { label: '影响范围', value: '只影响当前选择的应用、平台和建议类型，不会改动其他组合' }
    ]
  };
}

export function getRecommendationPolicyErrorMessage(code, fallbackMessage = '') {
  return fallbackMessage || POLICY_ERROR_MESSAGES[code] || '';
}

export function createEmptyTargetRow(kind) {
  return buildTargetRow(kind);
}
