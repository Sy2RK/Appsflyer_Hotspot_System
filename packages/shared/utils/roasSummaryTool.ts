import { env } from '../config/env.js';
import type { RecommendationPolicyConfigRecord, RecommendationPolicyRuleJson, RoasDataStatus } from '../types/models.js';
import { getDateStringInTimezone, shiftDateString } from './businessDate.js';
import { buildAsaRoasWindow, queryAsaKeywordMatureSummary } from './asaKeywords.js';
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
  calculateRoasDeviationRatio,
  isRoasDataDisplayableStatus,
  resolveRoasPrimarySource,
  resolveRoasWarningCode,
  resolveRoasCoverageRatio,
  resolveRoasDataStatus
} from './roasWindow.js';

const MAX_TOP_MEDIA_SOURCES = 5;
export type MatureRoasScope = 'budget' | 'asa';

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

function normalizeRoasScope(scope?: string): MatureRoasScope {
  return String(scope || '')
    .trim()
    .toLowerCase() === 'asa'
    ? 'asa'
    : 'budget';
}

function formatUsd(value: number): string {
  return `$${Number(value || 0).toFixed(2)}`;
}

function formatRatio(value: number): string {
  return `${(Math.max(0, Number(value || 0)) * 100).toFixed(1)}%`;
}

function formatRoas(value: number | null): string {
  return value != null && Number.isFinite(value) ? `${(Math.max(0, value) * 100).toFixed(2)}%` : '—';
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
  af_covered_cost: number;
  af_weighted_roas: number;
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
  afCohortRoas: number | null;
  localDerivedRoas: number | null;
  roasPrimarySource: 'af_cohort' | 'local_fallback';
  roasWarningCode: 'none' | 'af_missing' | 'af_vs_local_mismatch' | 'af_grain_unavailable';
  roasDeviationRatio: number | null;
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
  afCohortRoas: number | null;
  localDerivedRoas: number | null;
  roasPrimarySource: 'af_cohort' | 'local_fallback';
  roasWarningCode: 'none' | 'af_missing' | 'af_vs_local_mismatch' | 'af_grain_unavailable';
  roasDeviationRatio: number | null;
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

async function listBudgetValuePlatforms(appKey: string): Promise<string[]> {
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

async function listAsaValuePlatforms(appKey: string): Promise<string[]> {
  const rows = await chQuery<Record<string, unknown>>(
    `SELECT DISTINCT platform
       FROM asa_keyword_daily_metrics_v2 FINAL
      WHERE app_key = {appKey:String}
      ORDER BY platform ASC
      LIMIT 8`,
    { appKey }
  ).catch(() => []);
  return rows
    .map((row) => normalizePlatform(String(row.platform || '')))
    .filter((value): value is string => Boolean(value));
}

function resolveBudgetPolicyWindow(
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
        sumIf(total_cost, af_cohort_roas_missing != 1) AS af_covered_cost_sum,
        sumIf(total_cost * af_cohort_roas, af_cohort_roas_missing != 1) AS af_weighted_roas_sum,
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
    af_covered_cost: Number(row.af_covered_cost_sum || 0),
    af_weighted_roas: Number(row.af_weighted_roas_sum || 0),
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
        sumIf(total_cost, af_cohort_roas_missing != 1) AS af_covered_cost_sum,
        sumIf(total_cost * af_cohort_roas, af_cohort_roas_missing != 1) AS af_weighted_roas_sum,
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
    const afCoveredCost = Number(row.af_covered_cost_sum || 0);
    const afCohortRoas = afCoveredCost > 0 ? Number(row.af_weighted_roas_sum || 0) / afCoveredCost : null;
    const localDerivedRoas = coveredCost > 0 ? revenueD7 / coveredCost : null;
    const roasPrimarySource = resolveRoasPrimarySource({ afCohortRoas, localDerivedRoas });
    const roasWarningCode = resolveRoasWarningCode({ afCohortRoas, localDerivedRoas });
    const roasDeviationRatio = calculateRoasDeviationRatio(afCohortRoas, localDerivedRoas);
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
        roasPrimarySource === 'af_cohort'
          ? afCohortRoas
          : isRoasDataDisplayableStatus(roasDataStatus)
            ? localDerivedRoas
            : null,
      afCohortRoas,
      localDerivedRoas,
      roasPrimarySource,
      roasWarningCode,
      roasDeviationRatio
    };
  });
}

async function buildBudgetPlatformSummary(input: {
  appKey: string;
  platform?: string;
  reportDate: string;
  policyRecord: RecommendationPolicyConfigRecord | null;
  roasWindowOverride?: { from: string; to: string };
}): Promise<MatureRoasPlatformSummary> {
  const platform = normalizePlatform(input.platform);
  const roasWindow = input.roasWindowOverride ?? resolveBudgetPolicyWindow(input.reportDate, input.policyRecord);
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
  const afCohortRoas = aggregate.af_covered_cost > 0 ? aggregate.af_weighted_roas / aggregate.af_covered_cost : null;
  const localDerivedRoas =
    isRoasDataDisplayableStatus(roasDataStatus) && aggregate.covered_cost > 0
      ? aggregate.covered_revenue_d7 / aggregate.covered_cost
      : null;
  const roasPrimarySource = resolveRoasPrimarySource({ afCohortRoas, localDerivedRoas });
  const roasWarningCode = resolveRoasWarningCode({ afCohortRoas, localDerivedRoas });
  const roasDeviationRatio = calculateRoasDeviationRatio(afCohortRoas, localDerivedRoas);
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
      roasPrimarySource === 'af_cohort'
        ? afCohortRoas
        : isRoasDataDisplayableStatus(roasDataStatus)
          ? localDerivedRoas
          : null,
    afCohortRoas,
    localDerivedRoas,
    roasPrimarySource,
    roasWarningCode,
    roasDeviationRatio,
    hasData,
    topMediaSources
  };
}

function buildAsaTopMediaSources(summary: MatureRoasPlatformSummary): MatureRoasTopSource[] {
  if (!summary.hasData) {
    return [];
  }
  return [
    {
      mediaSource: 'Apple Search Ads',
      totalCost: summary.totalCost,
      coveredCost: summary.coveredCost,
      missingCost: summary.missingCost,
      revenueD7: summary.revenueD7,
      installs: summary.installs,
      roasDataStatus: summary.roasDataStatus,
      coverageRatio: summary.coverageRatio,
      currentRoas: summary.currentRoas,
      afCohortRoas: summary.afCohortRoas,
      localDerivedRoas: summary.localDerivedRoas,
      roasPrimarySource: summary.roasPrimarySource,
      roasWarningCode: summary.roasWarningCode,
      roasDeviationRatio: summary.roasDeviationRatio
    }
  ];
}

async function buildAsaPlatformSummary(input: {
  appKey: string;
  platform?: string;
  reportDate: string;
  policyRecord: RecommendationPolicyConfigRecord | null;
  roasWindowOverride?: { from: string; to: string };
}): Promise<MatureRoasPlatformSummary> {
  const platform = normalizePlatform(input.platform);
  const policy = input.policyRecord ? normalizeRecommendationPolicyRule(input.policyRecord.rule_json) : null;
  const roasWindow = input.roasWindowOverride ?? buildAsaRoasWindow(input.reportDate, policy);
  const summary = await queryAsaKeywordMatureSummary({
    appKey: input.appKey,
    platform,
    from: roasWindow.from,
    to: roasWindow.to
  });
  const totalCost = Number(summary.total_cost || 0);
  const coverageRatio = Number(summary.roas_coverage_ratio || 0);
  const coveredCost = totalCost > 0 ? totalCost * coverageRatio : 0;
  const missingCost = totalCost > 0 ? Math.max(0, totalCost - coveredCost) : 0;
  const hasData =
    Number(summary.keyword_count || 0) > 0 ||
    Number(summary.installs || 0) > 0 ||
    totalCost > 0 ||
    Number(summary.revenue_d7 || 0) > 0;
  const platformSummary: MatureRoasPlatformSummary = {
    platform: platform || null,
    reportDate: input.reportDate,
    roasWindow: {
      from: roasWindow.from,
      to: roasWindow.to
    },
    rowCount: Number(summary.keyword_count || 0),
    installs: Number(summary.installs || 0),
    totalCost,
    coveredCost,
    missingCost,
    revenueD7: Number(summary.revenue_d7 || 0),
    purchaseCount: Number(summary.purchase_count || 0),
    coverageRatio,
    roasDataStatus: summary.roas_data_status,
    currentRoas:
      (summary.roas_primary_source === 'af_cohort' ? summary.af_cohort_roas : summary.local_derived_roas) != null
        ? Number(summary.roas_primary_source === 'af_cohort' ? summary.af_cohort_roas : summary.local_derived_roas)
        : isRoasDataDisplayableStatus(summary.roas_data_status) && coveredCost > 0
          ? Number(summary.revenue_d7 || 0) / coveredCost
          : null,
    afCohortRoas: summary.af_cohort_roas,
    localDerivedRoas: summary.local_derived_roas,
    roasPrimarySource: summary.roas_primary_source,
    roasWarningCode: summary.roas_warning_code,
    roasDeviationRatio: summary.roas_deviation_ratio,
    hasData,
    topMediaSources: []
  };
  platformSummary.topMediaSources = buildAsaTopMediaSources(platformSummary);
  return platformSummary;
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
  )}；来源 ${row.roasPrimarySource === 'af_cohort' ? 'AF Cohort' : 'Fallback'}；成本 ${formatUsd(row.totalCost)}；D7 收入 ${formatUsd(row.revenueD7)}；状态 ${formatRoasStatus(
    row.roasDataStatus,
    row.coverageRatio,
    row.hasData
  )}`;
}

async function resolvePlatformSummaries(input: {
  appKey: string;
  scope?: MatureRoasScope;
  platform?: string;
  reportDate: string;
}): Promise<{
  platformSummaries: MatureRoasPlatformSummary[];
  overall: MatureRoasPlatformSummary | null;
  consistency: 'single' | 'consistent' | 'mixed';
}> {
  const scope = normalizeRoasScope(input.scope);
  const normalizedPlatform = normalizePlatform(input.platform);
  const policyRows = await listRecommendationPolicyConfigs({
    appKey: input.appKey,
    engine: scope,
    enabled: true
  }).catch(() => []);
  const policyMap = buildRecommendationPolicyMap(policyRows);
  const buildSummary = (args: {
    appKey: string;
    platform?: string;
    reportDate: string;
    policyRecord: RecommendationPolicyConfigRecord | null;
    roasWindowOverride?: { from: string; to: string };
  }) => (scope === 'asa' ? buildAsaPlatformSummary(args) : buildBudgetPlatformSummary(args));

  if (normalizedPlatform) {
    const policyRecord = policyMap.get(buildRecommendationPolicyKey(input.appKey, normalizedPlatform, scope)) ?? null;
    const overall = await buildSummary({
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
  const valuePlatforms = scope === 'asa' ? await listAsaValuePlatforms(input.appKey) : await listBudgetValuePlatforms(input.appKey);
  const candidatePlatforms = Array.from(new Set([...policyPlatforms, ...valuePlatforms]));

  if (candidatePlatforms.length === 0) {
    const overall = await buildSummary({
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
      buildSummary({
        appKey: input.appKey,
        platform,
        reportDate: input.reportDate,
        policyRecord: policyMap.get(buildRecommendationPolicyKey(input.appKey, platform, scope)) ?? null
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
    const overall = await buildSummary({
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
  scope?: MatureRoasScope;
  platform?: string;
  reportDate?: string;
}): Promise<MatureRoasContextPackResult> {
  const appKey = String(input.appKey || '').trim();
  if (!hasText(appKey)) {
    throw new Error('missing_app_key');
  }
  const scope = normalizeRoasScope(input.scope);
  const reportDate = normalizeReportDate(input.reportDate);
  const { platformSummaries, overall, consistency } = await resolvePlatformSummaries({
    appKey,
    scope,
    platform: input.platform,
    reportDate
  });

  const summaryLines = [
    '### 成熟窗口 ROAS',
    `- 应用：${appKey}${hasText(input.platform) ? ` / ${formatPlatformLabel(input.platform)}` : ''}`,
    `- 报告日期：${reportDate}`,
    scope === 'asa'
      ? '- 口径：与 ASA 简报 / ASA 看板一致的成熟窗口 D7 ROAS，不是当日实时 ROAS。'
      : '- 口径：与每日简报 / 预算建议一致的成熟窗口 D7 ROAS，不是当日实时 ROAS。'
  ];

  if (overall) {
    summaryLines.push(`- 时间窗口：${overall.roasWindow.from} 至 ${overall.roasWindow.to}`);
    summaryLines.push(
      `- 当前 ROAS：${formatRoas(overall.currentRoas)}；成本 ${formatUsd(overall.totalCost)}；D7 收入 ${formatUsd(
        overall.revenueD7
      )}；购买 ${overall.purchaseCount.toFixed(0)}；来源 ${overall.roasPrimarySource === 'af_cohort' ? 'AF Cohort' : 'Fallback'}`
    );
    if (overall.roasWarningCode !== 'none') {
      summaryLines.push(
        `- ROAS 说明：${
          overall.roasWarningCode === 'af_missing'
            ? 'AF Cohort 缺失，当前已回退到本地派生值。'
            : overall.roasWarningCode === 'af_vs_local_mismatch'
              ? 'AF 与本地派生 ROAS 偏差较大，当前主展示仍为 AF Cohort，并建议暂停自动动作。'
              : '当前粒度无 AF 官方 ROAS，已回退到本地派生值。'
        }`
      );
    }
    summaryLines.push(`- 数据状态：${formatRoasStatus(overall.roasDataStatus, overall.coverageRatio, overall.hasData)}`);
    summaryLines.push(buildTopMediaSourcesLine(overall.topMediaSources));
  } else {
    summaryLines.push('- 当前应用跨平台成熟窗口不一致，未合并成单一 ROAS；请按平台解读。');
    summaryLines.push(...platformSummaries.map((row) => buildPlatformSummaryLine(row)));
  }

  if (!overall && platformSummaries.length === 0) {
    const defaultWindow =
      scope === 'asa'
        ? buildAsaRoasWindow(reportDate, null)
        : buildMatureRoasWindow(reportDate, defaultRecommendationPolicyRule());
    summaryLines.push(`- 时间窗口：${defaultWindow.from} 至 ${defaultWindow.to}`);
    summaryLines.push('- 当前窗口暂无成熟价值数据。');
  }

  const structured = {
    appKey,
    scope,
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
          afCohortRoas: overall.afCohortRoas,
          localDerivedRoas: overall.localDerivedRoas,
          roasPrimarySource: overall.roasPrimarySource,
          roasWarningCode: overall.roasWarningCode,
          roasDeviationRatio: overall.roasDeviationRatio,
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
      afCohortRoas: row.afCohortRoas,
      localDerivedRoas: row.localDerivedRoas,
      roasPrimarySource: row.roasPrimarySource,
      roasWarningCode: row.roasWarningCode,
      roasDeviationRatio: row.roasDeviationRatio,
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
      scope,
      platform: normalizePlatform(input.platform) || null,
      reportDate
    }
  };
}
