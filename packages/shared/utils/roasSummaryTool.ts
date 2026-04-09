import { env } from '../config/env.js';
import type { RecommendationPolicyConfigRecord, RecommendationPolicyRuleJson, RoasDataStatus } from '../types/models.js';
import { getDateStringInTimezone, shiftDateString } from './businessDate.js';
import { chQuery } from './clickhouse.js';
import {
  buildRecommendationPolicyKey,
  buildRecommendationPolicyMap,
  defaultRecommendationPolicyRule,
  normalizeRecommendationPolicyRule
} from './recommendationPolicies.js';
import { listRecommendationPolicyConfigs } from './repositories.js';
import {
  buildMatureRoasWindow,
  isRoasDataDisplayableStatus,
  resolveRoasCoverageRatio,
  resolveRoasDataStatus
} from './roasWindow.js';

const MAX_TOP_MEDIA_SOURCES = 5;

function hasText(value: unknown): boolean {
  return String(value ?? '').trim().length > 0;
}

function normalizePlatform(platform?: string): string | undefined {
  const value = String(platform ?? '')
    .trim()
    .toLowerCase();
  return value ? value : undefined;
}

function normalizeReportDate(reportDate?: string): string {
  const fallback = shiftDateString(getDateStringInTimezone(new Date(), env.timezone), -1);
  const raw = String(reportDate ?? '').trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : fallback;
}

function formatUsd(value: number): string {
  return `$${Number(value || 0).toFixed(2)}`;
}

function formatRatio(value: number): string {
  return `${(Math.max(0, Number(value || 0)) * 100).toFixed(1)}%`;
}

function formatRoas(value: number | null): string {
  return value != null && Number.isFinite(value) ? `${value.toFixed(2)}x` : '—';
}

function formatPlatformLabel(platform?: string | null): string {
  const value = normalizePlatform(platform || undefined);
  if (!value) {
    return 'all';
  }
  if (value === 'ios') {
    return 'iOS';
  }
  if (value === 'android') {
    return 'Android';
  }
  return value;
}

function formatRoasStatus(status: RoasDataStatus, coverageRatio: number, hasData: boolean): string {
  if (!hasData) {
    return '当前窗口暂无成熟价值数据';
  }
  if (status === 'complete') {
    return `数据完整（覆盖率 ${formatRatio(coverageRatio)}）`;
  }
  if (status === 'partial') {
    return `数据可采纳（覆盖率 ${formatRatio(coverageRatio)}，按已覆盖成本计算）`;
  }
  if (status === 'partial_low') {
    return `数据仅供参考（覆盖率 ${formatRatio(coverageRatio)}）`;
  }
  if (status === 'pending') {
    return `回收待补齐（覆盖率 ${formatRatio(coverageRatio)}）`;
  }
  return `暂无可用回收数据（覆盖率 ${formatRatio(coverageRatio)}）`;
}

interface MatureRoasAggregateRow {
  row_count: number;
  installs: number;
  total_cost: number;
  covered_cost: number;
  missing_cost: number;
  covered_revenue_d7: number;
  covered_purchase_count: number;
}

export interface MatureRoasTopSource {
  mediaSource: string;
  totalCost: number;
  coveredCost: number;
  missingCost: number;
  revenueD7: number;
  installs: number;
  roasDataStatus: RoasDataStatus;
  coverageRatio: number;
  currentRoas: number | null;
}

export interface MatureRoasPlatformSummary {
  platform: string | null;
  reportDate: string;
  roasWindow: {
    from: string;
    to: string;
  };
  rowCount: number;
  installs: number;
  totalCost: number;
  coveredCost: number;
  missingCost: number;
  revenueD7: number;
  purchaseCount: number;
  coverageRatio: number;
  roasDataStatus: RoasDataStatus;
  currentRoas: number | null;
  hasData: boolean;
  topMediaSources: MatureRoasTopSource[];
}

export interface MatureRoasContextPackResult {
  title: string;
  summaryMarkdown: string;
  structured: Record<string, unknown>;
  rowCount: number;
  appliedFilters: Record<string, unknown>;
}

async function listValuePlatforms(appKey: string): Promise<string[]> {
  const rows = await chQuery<Record<string, unknown>>(
    `SELECT DISTINCT platform
       FROM keyword_value_daily_metrics FINAL
      WHERE app_key = {appKey:String}
      ORDER BY platform ASC
      LIMIT 8`,
    { appKey }
  ).catch(() => []);
  return rows
    .map((row) => normalizePlatform(String(row.platform || '')))
    .filter((value): value is string => Boolean(value));
}

function resolvePolicyWindow(
  reportDate: string,
  policyRecord: RecommendationPolicyConfigRecord | null
): { policy: RecommendationPolicyRuleJson | null; from: string; to: string } {
  const policy = policyRecord ? normalizeRecommendationPolicyRule(policyRecord.rule_json) : null;
  const window = buildMatureRoasWindow(reportDate, policy);
  return {
    policy,
    from: window.from,
    to: window.to
  };
}

async function queryMatureRoasAggregate(input: {
  appKey: string;
  platform?: string;
  from: string;
  to: string;
}): Promise<MatureRoasAggregateRow> {
  const rows = await chQuery<Record<string, unknown>>(
    `SELECT
        count() AS row_count,
        sum(installs) AS installs_sum,
        sum(total_cost) AS total_cost_sum,
        sumIf(total_cost, revenue_source_missing != 1) AS covered_cost_sum,
        sumIf(total_cost, revenue_source_missing = 1) AS missing_cost_sum,
        sumIf(revenue_d7, revenue_source_missing != 1) AS covered_revenue_d7_sum,
        sumIf(purchase_count, revenue_source_missing != 1) AS covered_purchase_count_sum
      FROM keyword_value_daily_metrics FINAL
      WHERE app_key = {appKey:String}
        AND ({platform:String} = '' OR platform = {platform:String})
        AND install_date >= toDate({from:String})
        AND install_date <= toDate({to:String})`,
    {
      appKey: input.appKey,
      platform: input.platform || '',
      from: input.from,
      to: input.to
    }
  );
  const row = rows[0] ?? {};
  return {
    row_count: Number(row.row_count || 0),
    installs: Number(row.installs_sum || 0),
    total_cost: Number(row.total_cost_sum || 0),
    covered_cost: Number(row.covered_cost_sum || 0),
    missing_cost: Number(row.missing_cost_sum || 0),
    covered_revenue_d7: Number(row.covered_revenue_d7_sum || 0),
    covered_purchase_count: Number(row.covered_purchase_count_sum || 0)
  };
}

async function queryTopMediaSources(input: {
  appKey: string;
  platform?: string;
  from: string;
  to: string;
}): Promise<MatureRoasTopSource[]> {
  const rows = await chQuery<Record<string, unknown>>(
    `SELECT
        ifNull(nullIf(media_source, ''), 'unknown') AS media_source,
        sum(installs) AS installs_sum,
        sum(total_cost) AS total_cost_sum,
        sumIf(total_cost, revenue_source_missing != 1) AS covered_cost_sum,
        sumIf(total_cost, revenue_source_missing = 1) AS missing_cost_sum,
        sumIf(revenue_d7, revenue_source_missing != 1) AS covered_revenue_d7_sum
      FROM keyword_value_daily_metrics FINAL
      WHERE app_key = {appKey:String}
        AND ({platform:String} = '' OR platform = {platform:String})
        AND install_date >= toDate({from:String})
        AND install_date <= toDate({to:String})
      GROUP BY media_source
      ORDER BY total_cost_sum DESC, media_source ASC
      LIMIT ${MAX_TOP_MEDIA_SOURCES}`,
    {
      appKey: input.appKey,
      platform: input.platform || '',
      from: input.from,
      to: input.to
    }
  ).catch(() => []);
  return rows.map((row) => {
    const totalCost = Number(row.total_cost_sum || 0);
    const coveredCost = Number(row.covered_cost_sum || 0);
    const missingCost = Number(row.missing_cost_sum || 0);
    const revenueD7 = Number(row.covered_revenue_d7_sum || 0);
    const hasData = totalCost > 0 || coveredCost > 0 || missingCost > 0 || revenueD7 > 0;
    const coverageRatio = resolveRoasCoverageRatio({ coveredCost, missingCost });
    const roasDataStatus = resolveRoasDataStatus({
      hasWindowRows: hasData,
      hasSpend: totalCost > 0,
      coveredCost,
      missingCost
    });
    return {
      mediaSource: String(row.media_source || 'unknown'),
      totalCost,
      coveredCost,
      missingCost,
      revenueD7,
      installs: Number(row.installs_sum || 0),
      roasDataStatus,
      coverageRatio,
      currentRoas:
        isRoasDataDisplayableStatus(roasDataStatus) && coveredCost > 0 ? revenueD7 / coveredCost : null
    };
  });
}

async function buildPlatformSummary(input: {
  appKey: string;
  platform?: string;
  reportDate: string;
  policyRecord: RecommendationPolicyConfigRecord | null;
  roasWindowOverride?: { from: string; to: string };
}): Promise<MatureRoasPlatformSummary> {
  const platform = normalizePlatform(input.platform);
  const roasWindow = input.roasWindowOverride ?? resolvePolicyWindow(input.reportDate, input.policyRecord);
  const aggregate = await queryMatureRoasAggregate({
    appKey: input.appKey,
    platform,
    from: roasWindow.from,
    to: roasWindow.to
  });
  const topMediaSources = await queryTopMediaSources({
    appKey: input.appKey,
    platform,
    from: roasWindow.from,
    to: roasWindow.to
  });
  const hasData = aggregate.row_count > 0;
  const coverageRatio = resolveRoasCoverageRatio({
    coveredCost: aggregate.covered_cost,
    missingCost: aggregate.missing_cost
  });
  const roasDataStatus = resolveRoasDataStatus({
    hasWindowRows: hasData,
    hasSpend: aggregate.total_cost > 0,
    coveredCost: aggregate.covered_cost,
    missingCost: aggregate.missing_cost
  });
  return {
    platform: platform || null,
    reportDate: input.reportDate,
    roasWindow: {
      from: roasWindow.from,
      to: roasWindow.to
    },
    rowCount: aggregate.row_count,
    installs: aggregate.installs,
    totalCost: aggregate.total_cost,
    coveredCost: aggregate.covered_cost,
    missingCost: aggregate.missing_cost,
    revenueD7: aggregate.covered_revenue_d7,
    purchaseCount: aggregate.covered_purchase_count,
    coverageRatio,
    roasDataStatus,
    currentRoas:
      isRoasDataDisplayableStatus(roasDataStatus) && aggregate.covered_cost > 0
        ? aggregate.covered_revenue_d7 / aggregate.covered_cost
        : null,
    hasData,
    topMediaSources
  };
}

function buildTopMediaSourcesLine(rows: MatureRoasTopSource[]): string {
  if (rows.length === 0) {
    return '- Top 媒体源：当前窗口暂无聚合结果';
  }
  return `- Top 媒体源：${rows
    .map((row) => {
      const roasText = row.currentRoas != null ? `ROAS ${formatRoas(row.currentRoas)}` : 'ROAS 待补齐';
      return `${row.mediaSource}（成本 ${formatUsd(row.totalCost)} / ${roasText} / 覆盖率 ${formatRatio(row.coverageRatio)}）`;
    })
    .join('；')}`;
}

function buildPlatformSummaryLine(row: MatureRoasPlatformSummary): string {
  return `- ${formatPlatformLabel(row.platform)}：时间窗口 ${row.roasWindow.from} 至 ${row.roasWindow.to}；ROAS ${formatRoas(
    row.currentRoas
  )}；成本 ${formatUsd(row.totalCost)}；D7 收入 ${formatUsd(row.revenueD7)}；状态 ${formatRoasStatus(
    row.roasDataStatus,
    row.coverageRatio,
    row.hasData
  )}`;
}

async function resolvePlatformSummaries(input: {
  appKey: string;
  platform?: string;
  reportDate: string;
}): Promise<{
  platformSummaries: MatureRoasPlatformSummary[];
  overall: MatureRoasPlatformSummary | null;
  consistency: 'single' | 'consistent' | 'mixed';
}> {
  const normalizedPlatform = normalizePlatform(input.platform);
  const policyRows = await listRecommendationPolicyConfigs({
    appKey: input.appKey,
    engine: 'budget',
    enabled: true
  }).catch(() => []);
  const policyMap = buildRecommendationPolicyMap(policyRows);

  if (normalizedPlatform) {
    const policyRecord = policyMap.get(buildRecommendationPolicyKey(input.appKey, normalizedPlatform, 'budget')) ?? null;
    const overall = await buildPlatformSummary({
      appKey: input.appKey,
      platform: normalizedPlatform,
      reportDate: input.reportDate,
      policyRecord
    });
    return {
      platformSummaries: [overall],
      overall,
      consistency: 'single'
    };
  }

  const policyPlatforms = policyRows
    .map((row) => normalizePlatform(row.platform))
    .filter((value): value is string => Boolean(value));
  const valuePlatforms = await listValuePlatforms(input.appKey);
  const candidatePlatforms = Array.from(new Set([...policyPlatforms, ...valuePlatforms]));

  if (candidatePlatforms.length === 0) {
    const overall = await buildPlatformSummary({
      appKey: input.appKey,
      reportDate: input.reportDate,
      policyRecord: null
    });
    return {
      platformSummaries: overall.platform ? [overall] : [],
      overall,
      consistency: 'single'
    };
  }

  const platformSummaries = await Promise.all(
    candidatePlatforms.map((platform) =>
      buildPlatformSummary({
        appKey: input.appKey,
        platform,
        reportDate: input.reportDate,
        policyRecord: policyMap.get(buildRecommendationPolicyKey(input.appKey, platform, 'budget')) ?? null
      })
    )
  );
  if (platformSummaries.length === 1) {
    return {
      platformSummaries,
      overall: platformSummaries[0],
      consistency: 'single'
    };
  }
  const windowKeys = new Set(platformSummaries.map((row) => `${row.roasWindow.from}|${row.roasWindow.to}`));
  if (windowKeys.size === 1) {
    const overall = await buildPlatformSummary({
      appKey: input.appKey,
      reportDate: input.reportDate,
      policyRecord: null,
      roasWindowOverride: { ...platformSummaries[0].roasWindow }
    });
    return {
      platformSummaries,
      overall,
      consistency: 'consistent'
    };
  }
  return {
    platformSummaries,
    overall: null,
    consistency: 'mixed'
  };
}

export async function buildMatureRoasContextPack(input: {
  appKey: string;
  platform?: string;
  reportDate?: string;
}): Promise<MatureRoasContextPackResult> {
  const appKey = String(input.appKey || '').trim();
  if (!hasText(appKey)) {
    throw new Error('missing_app_key');
  }
  const reportDate = normalizeReportDate(input.reportDate);
  const { platformSummaries, overall, consistency } = await resolvePlatformSummaries({
    appKey,
    platform: input.platform,
    reportDate
  });

  const summaryLines = [
    '### 成熟窗口 ROAS',
    `- 应用：${appKey}${hasText(input.platform) ? ` / ${formatPlatformLabel(input.platform)}` : ''}`,
    `- 报告日期：${reportDate}`,
    '- 口径：与简报一致的成熟窗口 D7 ROAS，不是当日实时 ROAS。'
  ];

  if (overall) {
    summaryLines.push(`- 时间窗口：${overall.roasWindow.from} 至 ${overall.roasWindow.to}`);
    summaryLines.push(
      `- 当前 ROAS：${formatRoas(overall.currentRoas)}；成本 ${formatUsd(overall.totalCost)}；D7 收入 ${formatUsd(
        overall.revenueD7
      )}；购买 ${overall.purchaseCount.toFixed(0)}`
    );
    summaryLines.push(`- 数据状态：${formatRoasStatus(overall.roasDataStatus, overall.coverageRatio, overall.hasData)}`);
    summaryLines.push(buildTopMediaSourcesLine(overall.topMediaSources));
  } else {
    summaryLines.push('- 当前应用跨平台成熟窗口不一致，未合并成单一 ROAS；请按平台解读。');
    summaryLines.push(...platformSummaries.map((row) => buildPlatformSummaryLine(row)));
  }

  if (!overall && platformSummaries.length === 0) {
    const defaultWindow = buildMatureRoasWindow(reportDate, defaultRecommendationPolicyRule());
    summaryLines.push(`- 时间窗口：${defaultWindow.from} 至 ${defaultWindow.to}`);
    summaryLines.push('- 当前窗口暂无成熟价值数据。');
  }

  const structured = {
    appKey,
    platform: normalizePlatform(input.platform) || null,
    reportDate,
    consistency,
    summary: overall
      ? {
          reportDate: overall.reportDate,
          roasWindow: overall.roasWindow,
          installs: overall.installs,
          totalCost: overall.totalCost,
          coveredCost: overall.coveredCost,
          missingCost: overall.missingCost,
          revenueD7: overall.revenueD7,
          purchaseCount: overall.purchaseCount,
          coverageRatio: overall.coverageRatio,
          roasDataStatus: overall.roasDataStatus,
          currentRoas: overall.currentRoas,
          hasData: overall.hasData
        }
      : null,
    platformBreakdown: platformSummaries.map((row) => ({
      platform: row.platform,
      reportDate: row.reportDate,
      roasWindow: row.roasWindow,
      installs: row.installs,
      totalCost: row.totalCost,
      coveredCost: row.coveredCost,
      missingCost: row.missingCost,
      revenueD7: row.revenueD7,
      purchaseCount: row.purchaseCount,
      coverageRatio: row.coverageRatio,
      roasDataStatus: row.roasDataStatus,
      currentRoas: row.currentRoas,
      hasData: row.hasData,
      topMediaSources: row.topMediaSources
    }))
  } satisfies Record<string, unknown>;

  return {
    title: '成熟窗口 ROAS',
    summaryMarkdown: summaryLines.join('\n'),
    structured,
    rowCount:
      (overall?.topMediaSources.length || 0) +
      (overall ? 1 : 0) +
      platformSummaries.reduce((sum, row) => sum + row.topMediaSources.length, 0),
    appliedFilters: {
      appKey,
      platform: normalizePlatform(input.platform) || null,
      reportDate
    }
  };
}
