import { MetricRule, RuleDSL } from '../types/rules.js';

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function normalizeMetricRule(raw: unknown): MetricRule | null {
  if (!isObject(raw)) {
    return null;
  }

  const metric = typeof raw.metric === 'string' ? raw.metric : null;
  const granularity = raw.granularity === 'hour' ? 'hour' : null;
  const window = typeof raw.window === 'string' ? raw.window : null;
  const baseline = typeof raw.baseline === 'string' ? raw.baseline : null;
  const upRatio = typeof raw.up_ratio === 'number' ? raw.up_ratio : null;
  const downRatio = typeof raw.down_ratio === 'number' ? raw.down_ratio : null;
  const minAbsDelta = typeof raw.min_abs_delta === 'number' ? raw.min_abs_delta : null;
  const severity = isObject(raw.severity)
    ? {
        spike: raw.severity.spike,
        drop: raw.severity.drop
      }
    : null;
  const drilldownDims = Array.isArray(raw.drilldown_dims)
    ? raw.drilldown_dims.filter((d): d is MetricRule['drilldown_dims'][number] => typeof d === 'string')
    : [];

  if (!metric || !granularity || !window || !baseline || upRatio === null || downRatio === null || minAbsDelta === null) {
    return null;
  }

  if (
    !severity ||
    (severity.spike !== 'P0' && severity.spike !== 'P1' && severity.spike !== 'P2') ||
    (severity.drop !== 'P0' && severity.drop !== 'P1' && severity.drop !== 'P2')
  ) {
    return null;
  }

  return {
    metric,
    event_name: typeof raw.event_name === 'string' ? raw.event_name : undefined,
    granularity,
    window,
    baseline: baseline as MetricRule['baseline'],
    up_ratio: upRatio,
    down_ratio: downRatio,
    min_abs_delta: minAbsDelta,
    severity: {
      spike: severity.spike,
      drop: severity.drop
    },
    drilldown_dims: drilldownDims
  };
}

export function parseRuleDsl(raw: unknown): RuleDSL | null {
  if (!isObject(raw)) {
    return null;
  }

  const metricsRaw = raw.metrics;
  if (!Array.isArray(metricsRaw) || metricsRaw.length === 0) {
    return null;
  }

  const metrics: MetricRule[] = [];
  for (const item of metricsRaw) {
    const normalized = normalizeMetricRule(item);
    if (!normalized) {
      return null;
    }
    metrics.push(normalized);
  }

  return {
    timezone: typeof raw.timezone === 'string' ? raw.timezone : undefined,
    silence_minutes: typeof raw.silence_minutes === 'number' ? raw.silence_minutes : undefined,
    metrics
  };
}
