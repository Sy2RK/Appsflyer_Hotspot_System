import type { AppConfigRecord } from '../types/models.js';
import { shiftDateString } from './businessDate.js';
import type { AfExpectedSnapshotComponent } from './appsflyerOfficialSnapshots.js';

function cleanText(value: string | null | undefined): string {
  return String(value || '').trim();
}

function normalizePlatform(value: string | null | undefined): string {
  return cleanText(value).toLowerCase();
}

export function buildDateRangeInclusive(from: string, to: string): string[] {
  const start = cleanText(from);
  const end = cleanText(to);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end) || start > end) {
    return [];
  }
  const dates: string[] = [];
  for (let current = start; current <= end; current = shiftDateString(current, 1)) {
    dates.push(current);
  }
  return dates;
}

export function buildDailyReportExpectedComponents(
  apps: AppConfigRecord[],
  input: {
    from: string;
    to: string;
    appKey?: string | null;
    platform?: string | null;
  }
): AfExpectedSnapshotComponent[] {
  const appKey = cleanText(input.appKey);
  const platform = normalizePlatform(input.platform);
  const dates = buildDateRangeInclusive(input.from, input.to);
  const components: AfExpectedSnapshotComponent[] = [];
  for (const app of apps) {
    if (appKey && app.app_key !== appKey) {
      continue;
    }
    const targets = [
      { platform: 'ios', appId: cleanText(app.ios_pull_app_id) },
      { platform: 'android', appId: cleanText(app.android_pull_app_id) }
    ].filter((target) => target.appId && (!platform || target.platform === platform));
    for (const date of dates) {
      for (const target of targets) {
        components.push({
          source_api: 'daily_report_v5',
          app_key: app.app_key,
          platform: target.platform,
          app_id: target.appId,
          window_from: date,
          window_to: date
        });
      }
    }
  }
  return components;
}

export function buildAsaMasterExpectedComponents(
  apps: AppConfigRecord[],
  input: {
    from: string;
    to: string;
    appKey?: string | null;
    platform?: string | null;
  }
): AfExpectedSnapshotComponent[] {
  const appKey = cleanText(input.appKey);
  const platform = normalizePlatform(input.platform) || 'ios';
  if (platform !== 'ios') {
    return [];
  }
  const dates = buildDateRangeInclusive(input.from, input.to);
  const components: AfExpectedSnapshotComponent[] = [];
  for (const app of apps) {
    if (appKey && app.app_key !== appKey) {
      continue;
    }
    const appId = cleanText(app.ios_pull_app_id);
    if (!appId) {
      continue;
    }
    for (const date of dates) {
      components.push({
        source_api: 'master_api_v4',
        app_key: app.app_key,
        platform: 'ios',
        app_id: appId,
        window_from: date,
        window_to: date
      });
    }
  }
  return components;
}
