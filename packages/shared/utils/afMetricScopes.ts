import { env } from '../config/env.js';
import { getDateStringInTimezone, shiftDateString } from './businessDate.js';

export type AfMetricScope =
  | 'dashboard_selected_window'
  | 'daily_push_d1'
  | 'recent_unstable_window'
  | 'retro_window'
  | 'mature_d7_roas'
  | 'raw_realtime_window'
  | 'decision_window';

export type AfSourceSurface =
  | 'master_pivot'
  | 'daily_report'
  | 'cohort_api'
  | 'raw_realtime'
  | 'system_derived';

export interface AfMetricScopeDefinition {
  scope: AfMetricScope;
  source_surface: AfSourceSurface;
  purpose: string;
  window_policy: string;
  dashboard_comparable: boolean;
}

export interface AfMetricScopeMeta {
  metric_scope: AfMetricScope;
  source_surface: AfSourceSurface;
  window_from: string;
  window_to: string;
  timezone: string;
  currency: string;
  is_provisional: boolean;
  scope_definition: AfMetricScopeDefinition;
}

// AppsFlyer dashboard parity baseline, confirmed from the current UI screenshots:
// View type = User Acquisition, date = the selected inclusive dashboard window,
// Campaign = the row campaign, Media source/Geo/Adset = All unless the operator
// explicitly filters them. Dashboard eCPI is Cost / Attributions. Mature Cohort
// ROAS and recommendation 3/7-day eCPI are decision metrics and must not be
// presented as this dashboard-selected current performance.
export const AF_METRIC_SCOPE_REGISTRY: Record<AfMetricScope, AfMetricScopeDefinition> = {
  dashboard_selected_window: {
    scope: 'dashboard_selected_window',
    source_surface: 'master_pivot',
    purpose: 'AppsFlyer dashboard or Pivot comparable reporting for the selected date range.',
    window_policy: 'Use the exact selected inclusive date range in the app preferred timezone and currency.',
    dashboard_comparable: true
  },
  daily_push_d1: {
    scope: 'daily_push_d1',
    source_surface: 'master_pivot',
    purpose: 'Daily 10:00 push and Bitable export for the previous business date.',
    window_policy: 'Default to D-1; mark as provisional until AppsFlyer freshness stabilizes.',
    dashboard_comparable: true
  },
  recent_unstable_window: {
    scope: 'recent_unstable_window',
    source_surface: 'master_pivot',
    purpose: 'Trailing dates that AppsFlyer may still restate after the first morning pull.',
    window_policy: 'D-1 through D-7 should be reconciled repeatedly by checksum and source freshness.',
    dashboard_comparable: true
  },
  retro_window: {
    scope: 'retro_window',
    source_surface: 'master_pivot',
    purpose: 'Historical restatement coverage for dashboard lookbacks such as 7/14/30 days.',
    window_policy: 'D-8 through D-35 should be refreshed daily at low traffic hours.',
    dashboard_comparable: true
  },
  mature_d7_roas: {
    scope: 'mature_d7_roas',
    source_surface: 'cohort_api',
    purpose: 'Mature D7 ROAS and CPP decisioning.',
    window_policy: 'Use mature install dates only; exclude the latest 7 days by default.',
    dashboard_comparable: false
  },
  raw_realtime_window: {
    scope: 'raw_realtime_window',
    source_surface: 'raw_realtime',
    purpose: 'Realtime observation and event backfill support.',
    window_policy: 'Use raw or push arrival windows; never present as final dashboard parity.',
    dashboard_comparable: false
  },
  decision_window: {
    scope: 'decision_window',
    source_surface: 'system_derived',
    purpose: 'Recommendation current metrics such as current eCPI, spend, and install volume.',
    window_policy: 'Use policy-defined decision windows and label separately from official dashboard metrics.',
    dashboard_comparable: false
  }
};

function parseDateString(value: string): Date | null {
  const text = String(value || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    return null;
  }
  const parsed = new Date(`${text}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) ? parsed : null;
}

export function daysBetweenDates(from: string, to: string): number | null {
  const left = parseDateString(from);
  const right = parseDateString(to);
  if (!left || !right) {
    return null;
  }
  return Math.round((right.getTime() - left.getTime()) / (24 * 60 * 60 * 1000));
}

export function daysBackFromBusinessToday(
  date: string,
  now = new Date(),
  timezone = env.timezone
): number | null {
  return daysBetweenDates(date, getDateStringInTimezone(now, timezone));
}

export function classifyAfSyncScope(
  windowTo: string,
  now = new Date(),
  timezone = env.timezone
): AfMetricScope {
  const daysBack = daysBackFromBusinessToday(windowTo, now, timezone);
  if (daysBack == null || daysBack <= 0) {
    return 'recent_unstable_window';
  }
  if (daysBack <= 7) {
    return 'recent_unstable_window';
  }
  if (daysBack <= 35) {
    return 'retro_window';
  }
  return 'dashboard_selected_window';
}

export function isAfWindowProvisional(
  windowTo: string,
  now = new Date(),
  timezone = env.timezone
): boolean {
  const daysBack = daysBackFromBusinessToday(windowTo, now, timezone);
  return daysBack == null || daysBack <= 2;
}

export function getDefaultDailyPushWindow(now = new Date(), timezone = env.timezone): {
  from: string;
  to: string;
} {
  const today = getDateStringInTimezone(now, timezone);
  const reportDate = shiftDateString(today, -1);
  return { from: reportDate, to: reportDate };
}

export function buildAfMetricScopeMeta(input: {
  metricScope: AfMetricScope;
  sourceSurface?: AfSourceSurface;
  windowFrom: string;
  windowTo: string;
  timezone?: string;
  currency?: string;
  isProvisional?: boolean;
}): AfMetricScopeMeta {
  const definition = AF_METRIC_SCOPE_REGISTRY[input.metricScope];
  const sourceSurface = input.sourceSurface ?? definition.source_surface;
  const displayTimezone = input.timezone ?? 'preferred';
  const calculationTimezone = displayTimezone === 'preferred' ? env.timezone : displayTimezone;
  return {
    metric_scope: input.metricScope,
    source_surface: sourceSurface,
    window_from: input.windowFrom,
    window_to: input.windowTo,
    timezone: displayTimezone,
    currency: input.currency ?? 'preferred',
    is_provisional:
      input.isProvisional ?? isAfWindowProvisional(input.windowTo, new Date(), calculationTimezone),
    scope_definition: {
      ...definition,
      source_surface: sourceSurface
    }
  };
}

export function compatibleSnapshotScopes(metricScope: AfMetricScope): AfMetricScope[] {
  if (metricScope === 'dashboard_selected_window' || metricScope === 'daily_push_d1') {
    return ['dashboard_selected_window', 'daily_push_d1', 'recent_unstable_window', 'retro_window'];
  }
  return [metricScope];
}
