import { MetricRule, RuleDSL } from '../types/rules.js';

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

const SUPPORTED_METRICS = new Set(['revenue', 'event_count', 'purchase_count']);
const SUPPORTED_WINDOWS = new Set(['last_1h', 'last_2h', 'last_3h']);
const SUPPORTED_BASELINES = new Set(['avg_7d_same_hour', 'median_14d_same_hour']);
const SUPPORTED_SEVERITIES = new Set(['P0', 'P1', 'P2']);
const SUPPORTED_DRILLDOWN_DIMS = new Set(['media_source', 'country', 'campaign', 'attribution', 'event_type']);

export interface RuleDslValidationResult {
  ok: boolean;
  value?: RuleDSL;
  error?: string;
}

function normalizeMetricRule(
  raw: unknown,
  index: number
): { ok: true; value: MetricRule } | { ok: false; error: string } {
  if (!isObject(raw)) {
    return { ok: false, error: `metrics[${index}] must be an object` };
  }

  const metric = typeof raw.metric === 'string' ? raw.metric.trim() : '';
  const granularity = raw.granularity === 'hour' ? 'hour' : null;
  const window = typeof raw.window === 'string' ? raw.window.trim() : '';
  const baseline = typeof raw.baseline === 'string' ? raw.baseline.trim() : '';
  const upRatio = typeof raw.up_ratio === 'number' ? raw.up_ratio : Number.NaN;
  const downRatio = typeof raw.down_ratio === 'number' ? raw.down_ratio : Number.NaN;
  const minAbsDelta = typeof raw.min_abs_delta === 'number' ? raw.min_abs_delta : Number.NaN;
  const severity = isObject(raw.severity)
    ? {
        spike: raw.severity.spike,
        drop: raw.severity.drop
      }
    : null;
  const drilldownDims = Array.isArray(raw.drilldown_dims)
    ? raw.drilldown_dims.filter(
        (dim): dim is MetricRule['drilldown_dims'][number] =>
          typeof dim === 'string' && SUPPORTED_DRILLDOWN_DIMS.has(dim)
      )
    : [];

  if (!metric || !granularity || !window || !baseline) {
    return { ok: false, error: `metrics[${index}] is missing required fields` };
  }

  if (!SUPPORTED_METRICS.has(metric)) {
    return { ok: false, error: `metrics[${index}].metric is not supported: ${metric}` };
  }

  if (!SUPPORTED_WINDOWS.has(window)) {
    return { ok: false, error: `metrics[${index}].window is not supported: ${window}` };
  }

  if (!SUPPORTED_BASELINES.has(baseline)) {
    return { ok: false, error: `metrics[${index}].baseline is not supported: ${baseline}` };
  }

  if (
    !severity ||
    !SUPPORTED_SEVERITIES.has(String(severity.spike)) ||
    !SUPPORTED_SEVERITIES.has(String(severity.drop))
  ) {
    return { ok: false, error: `metrics[${index}].severity contains unsupported values` };
  }

  if (!Number.isFinite(upRatio) || upRatio <= 0) {
    return { ok: false, error: `metrics[${index}].up_ratio must be a positive number` };
  }

  if (!Number.isFinite(downRatio) || downRatio < 0) {
    return { ok: false, error: `metrics[${index}].down_ratio must be a non-negative number` };
  }

  if (!Number.isFinite(minAbsDelta) || minAbsDelta < 0) {
    return { ok: false, error: `metrics[${index}].min_abs_delta must be a non-negative number` };
  }

  const eventName = typeof raw.event_name === 'string' ? raw.event_name.trim() : '';
  if (metric === 'event_count' && eventName === '') {
    return { ok: false, error: `metrics[${index}].event_name is required when metric=event_count` };
  }

  return {
    ok: true,
    value: {
      metric,
      event_name: eventName || undefined,
      granularity,
      window,
      baseline: baseline as MetricRule['baseline'],
      up_ratio: upRatio,
      down_ratio: downRatio,
      min_abs_delta: minAbsDelta,
      severity: {
        spike: severity.spike as MetricRule['severity']['spike'],
        drop: severity.drop as MetricRule['severity']['drop']
      },
      drilldown_dims: [...new Set(drilldownDims)]
    }
  };
}

export function validateRuleDsl(raw: unknown): RuleDslValidationResult {
  if (!isObject(raw)) {
    return { ok: false, error: 'rule_json must be an object' };
  }

  const metricsRaw = raw.metrics;
  if (!Array.isArray(metricsRaw) || metricsRaw.length === 0) {
    return { ok: false, error: 'rule_json.metrics must be a non-empty array' };
  }

  const metrics: MetricRule[] = [];
  for (const [index, item] of metricsRaw.entries()) {
    const normalized = normalizeMetricRule(item, index);
    if (!normalized.ok) {
      return normalized;
    }
    metrics.push(normalized.value);
  }

  if (typeof raw.silence_minutes !== 'undefined') {
    const silence = Number(raw.silence_minutes);
    if (!Number.isFinite(silence) || silence <= 0) {
      return { ok: false, error: 'rule_json.silence_minutes must be a positive number' };
    }
  }

  return {
    ok: true,
    value: {
      timezone: typeof raw.timezone === 'string' && raw.timezone.trim() ? raw.timezone.trim() : undefined,
      silence_minutes: typeof raw.silence_minutes === 'number' ? raw.silence_minutes : undefined,
      metrics
    }
  };
}

export function parseRuleDsl(raw: unknown): RuleDSL | null {
  const validated = validateRuleDsl(raw);
  return validated.ok ? validated.value ?? null : null;
}
