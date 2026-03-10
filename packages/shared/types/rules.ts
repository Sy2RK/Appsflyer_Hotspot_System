export type Severity = 'P0' | 'P1' | 'P2';

export type DrilldownDim =
  | 'media_source'
  | 'country'
  | 'campaign'
  | 'attribution'
  | 'event_type';

export interface MetricRule {
  metric: 'revenue' | 'event_count' | 'purchase_count' | string;
  event_name?: string;
  granularity: 'hour';
  window: string;
  baseline: 'avg_7d_same_hour' | 'median_14d_same_hour' | string;
  up_ratio: number;
  down_ratio: number;
  min_abs_delta: number;
  severity: {
    spike: Severity;
    drop: Severity;
  };
  drilldown_dims: DrilldownDim[];
}

export interface RuleDSL {
  timezone?: string;
  silence_minutes?: number;
  metrics: MetricRule[];
}

export interface ParsedWindow {
  hours: number;
  label: string;
}
