import { chQuery } from './clickhouse.js';

export interface AfDashboardCampaignMetric {
  app_key: string;
  platform: string;
  campaign: string;
  window_from: string;
  window_to: string;
  cost: number;
  attributions: number;
  clicks: number;
  impressions: number;
  ecpi: number;
  source_api: 'daily_report_v5';
  source_surface: 'daily_report';
  roas_tool_status: 'not_available_in_daily_report';
}

export function afDashboardCampaignKey(input: {
  appKey: string;
  platform: string;
  campaign: string;
}): string {
  return [
    String(input.appKey || '').trim(),
    String(input.platform || '').trim().toLowerCase(),
    String(input.campaign || '').trim()
  ].join('|');
}

function cleanText(value: unknown): string {
  return String(value || '').trim();
}

function cleanPlatform(value: unknown): string {
  return cleanText(value).toLowerCase();
}

function numberValue(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export async function queryAfDashboardDailyCampaignMetrics(input: {
  reportDate: string;
  appKey?: string | null;
  platform?: string | null;
  campaigns?: string[];
}): Promise<Map<string, AfDashboardCampaignMetric>> {
  const reportDate = cleanText(input.reportDate);
  const campaigns = Array.from(new Set((input.campaigns || []).map(cleanText).filter(Boolean)));
  if (!/^\d{4}-\d{2}-\d{2}$/.test(reportDate)) {
    return new Map();
  }
  if (campaigns.length === 0) {
    return new Map();
  }

  const clauses = [`date = toDate({report_date:String})`, `has({campaigns:Array(String)}, campaign)`];
  const params: Record<string, unknown> = {
    report_date: reportDate,
    campaigns
  };
  const appKey = cleanText(input.appKey);
  const platform = cleanPlatform(input.platform);
  if (appKey) {
    clauses.push(`app_key = {app_key:String}`);
    params.app_key = appKey;
  }
  if (platform) {
    clauses.push(`lowerUTF8(platform) = {platform:String}`);
    params.platform = platform;
  }

  const rows = await chQuery<Record<string, unknown>>(
    `SELECT
        app_key,
        platform,
        campaign,
        sum(installs_latest) AS attributions,
        sum(clicks_latest) AS clicks,
        sum(impressions_latest) AS impressions,
        sum(total_cost_latest) AS cost,
        if(sum(installs_latest) > 0, sum(total_cost_latest) / sum(installs_latest), 0) AS ecpi
      FROM (
        SELECT
          app_key,
          lowerUTF8(platform) AS platform,
          country,
          media_source,
          campaign,
          argMax(toFloat64(installs), ingest_time) AS installs_latest,
          argMax(toFloat64(clicks), ingest_time) AS clicks_latest,
          argMax(toFloat64(impressions), ingest_time) AS impressions_latest,
          argMax(toFloat64(total_cost), ingest_time) AS total_cost_latest
        FROM pull_aggregate_daily
        WHERE ${clauses.join(' AND ')}
        GROUP BY app_key, platform, country, media_source, campaign
      )
      GROUP BY app_key, platform, campaign`,
    params
  );

  const metrics = new Map<string, AfDashboardCampaignMetric>();
  for (const row of rows) {
    const metric: AfDashboardCampaignMetric = {
      app_key: cleanText(row.app_key),
      platform: cleanPlatform(row.platform) || 'unknown',
      campaign: cleanText(row.campaign),
      window_from: reportDate,
      window_to: reportDate,
      cost: numberValue(row.cost),
      attributions: numberValue(row.attributions),
      clicks: numberValue(row.clicks),
      impressions: numberValue(row.impressions),
      ecpi: numberValue(row.ecpi),
      source_api: 'daily_report_v5',
      source_surface: 'daily_report',
      roas_tool_status: 'not_available_in_daily_report'
    };
    metrics.set(
      afDashboardCampaignKey({
        appKey: metric.app_key,
        platform: metric.platform,
        campaign: metric.campaign
      }),
      metric
    );
  }

  return metrics;
}
