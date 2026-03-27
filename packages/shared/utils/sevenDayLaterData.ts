import type { RecommendationType } from '../types/models.js';
import { env } from '../config/env.js';
import { chQuery } from './clickhouse.js';
import { getDateStringInTimezone } from './businessDate.js';
import { pgQuery } from './postgres.js';

export const SEVEN_DAY_LATER_FIELD_LABEL = '七天后数据';

export interface SevenDayLaterLookupRow {
  recommendation_type: RecommendationType;
  recommendation_id: number;
  report_date: string;
  app_key: string;
  platform_raw: string;
  media_source: string;
  item_name: string;
  match_type?: string;
  campaign?: string;
  adset?: string;
}

interface BudgetSevenDayMetricRow {
  target_date: string;
  app_key: string;
  platform_raw: string;
  media_source: string;
  item_name: string;
  match_type: string;
  installs: number;
  total_cost: number;
}

interface AsaSevenDayMetricRow {
  target_date: string;
  app_key: string;
  platform_raw: string;
  item_name: string;
  campaign: string;
  adset: string;
  installs: number;
  total_cost: number;
  purchase_count: number;
  revenue_d7: number;
}

function escapeSqlLiteral(value: string): string {
  return `'${String(value || '').replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

function addDays(dateString: string, days: number): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateString || '').trim());
  if (!match) {
    return '';
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const value = new Date(Date.UTC(year, month - 1, day + days));
  const yyyy = value.getUTCFullYear();
  const mm = String(value.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(value.getUTCDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

function formatUsd(value: number): string {
  return `$${Number(value || 0).toFixed(2)}`;
}

export function getSevenDayLaterTodayDateString(now = new Date()): string {
  return getDateStringInTimezone(now, env.timezone);
}

function formatBudgetSevenDayText(targetDate: string, installs: number, totalCost: number): string {
  const ecpi = installs > 0 ? totalCost / installs : 0;
  return `D+7 ${targetDate}｜安装 ${installs.toFixed(0)}｜花费 ${formatUsd(totalCost)}｜eCPI ${formatUsd(ecpi)}`;
}

function formatAsaSevenDayText(
  targetDate: string,
  installs: number,
  totalCost: number,
  purchaseCount: number,
  revenueD7: number
): string {
  const cpp = purchaseCount > 0 ? totalCost / purchaseCount : 0;
  const d7Roas = totalCost > 0 ? revenueD7 / totalCost : 0;
  return `D+7 ${targetDate}｜安装 ${installs.toFixed(0)}｜花费 ${formatUsd(totalCost)}｜CPP ${formatUsd(cpp)}｜购买 ${purchaseCount.toFixed(0)}｜ROAS ${d7Roas.toFixed(2)}`;
}

function budgetMetricKey(row: {
  target_date: string;
  app_key: string;
  platform_raw: string;
  media_source: string;
  item_name: string;
  match_type: string;
}): string {
  return [
    row.target_date,
    row.app_key,
    row.platform_raw,
    row.media_source,
    row.item_name,
    row.match_type
  ].map((item) => String(item || '').trim()).join('|');
}

function asaMetricKey(row: {
  target_date: string;
  app_key: string;
  platform_raw: string;
  item_name: string;
  campaign: string;
  adset: string;
}): string {
  return [
    row.target_date,
    row.app_key,
    row.platform_raw,
    row.item_name,
    row.campaign,
    row.adset
  ].map((item) => String(item || '').trim()).join('|');
}

async function loadBudgetSevenDayMetrics(lookups: SevenDayLaterLookupRow[]): Promise<Map<string, string>> {
  const budgetLookups = lookups.filter((row) => row.recommendation_type === 'budget');
  if (budgetLookups.length === 0) {
    return new Map();
  }

  const targetDates = Array.from(new Set(budgetLookups.map((row) => addDays(row.report_date, 7)).filter(Boolean)));
  const appKeys = Array.from(new Set(budgetLookups.map((row) => row.app_key).filter(Boolean)));
  const platformValues = Array.from(new Set(budgetLookups.map((row) => String(row.platform_raw || '').trim().toLowerCase()).filter(Boolean)));
  if (targetDates.length === 0 || appKeys.length === 0 || platformValues.length === 0) {
    return new Map();
  }

  const rows = await chQuery<BudgetSevenDayMetricRow>(
    `SELECT
        toString(date) AS target_date,
        app_key,
        lowerUTF8(platform) AS platform_raw,
        media_source,
        keyword AS item_name,
        match_type,
        sum(toFloat64(installs)) AS installs,
        sum(toFloat64(total_cost)) AS total_cost
       FROM keyword_daily_metrics FINAL
      WHERE date IN (${targetDates.map(escapeSqlLiteral).join(', ')})
        AND app_key IN (${appKeys.map(escapeSqlLiteral).join(', ')})
        AND lowerUTF8(platform) IN (${platformValues.map(escapeSqlLiteral).join(', ')})
      GROUP BY target_date, app_key, platform_raw, media_source, item_name, match_type`
  );

  const metricMap = new Map(rows.map((row) => [budgetMetricKey(row), row]));
  const today = getSevenDayLaterTodayDateString();
  const result = new Map<string, string>();

  for (const lookup of budgetLookups) {
    const targetDate = addDays(lookup.report_date, 7);
    const recordKey = `${lookup.recommendation_type}:${lookup.recommendation_id}`;
    if (!targetDate) {
      result.set(recordKey, '');
      continue;
    }
    const metric = metricMap.get(
      budgetMetricKey({
        target_date: targetDate,
        app_key: lookup.app_key,
        platform_raw: String(lookup.platform_raw || '').trim().toLowerCase(),
        media_source: lookup.media_source,
        item_name: lookup.item_name,
        match_type: String(lookup.match_type || '').trim()
      })
    );
    if (metric) {
      result.set(recordKey, formatBudgetSevenDayText(targetDate, Number(metric.installs || 0), Number(metric.total_cost || 0)));
      continue;
    }
    result.set(recordKey, targetDate <= today ? `D+7 ${targetDate}｜暂无相关数据` : '');
  }

  return result;
}

async function loadAsaSevenDayMetrics(lookups: SevenDayLaterLookupRow[]): Promise<Map<string, string>> {
  const asaLookups = lookups.filter((row) => row.recommendation_type === 'asa_keyword');
  if (asaLookups.length === 0) {
    return new Map();
  }

  const targetDates = Array.from(new Set(asaLookups.map((row) => addDays(row.report_date, 7)).filter(Boolean)));
  const appKeys = Array.from(new Set(asaLookups.map((row) => row.app_key).filter(Boolean)));
  const platformValues = Array.from(new Set(asaLookups.map((row) => String(row.platform_raw || '').trim().toLowerCase()).filter(Boolean)));
  if (targetDates.length === 0 || appKeys.length === 0 || platformValues.length === 0) {
    return new Map();
  }

  const rows = await chQuery<AsaSevenDayMetricRow>(
    `SELECT
        toString(date) AS target_date,
        app_key,
        lowerUTF8(platform) AS platform_raw,
        keyword AS item_name,
        campaign,
        adset,
        sum(toFloat64(installs)) AS installs,
        sum(toFloat64(total_cost)) AS total_cost,
        sum(toFloat64(purchase_count)) AS purchase_count,
        sum(toFloat64(revenue_d7)) AS revenue_d7
       FROM asa_keyword_daily_metrics_v2 FINAL
      WHERE date IN (${targetDates.map(escapeSqlLiteral).join(', ')})
        AND app_key IN (${appKeys.map(escapeSqlLiteral).join(', ')})
        AND lowerUTF8(platform) IN (${platformValues.map(escapeSqlLiteral).join(', ')})
      GROUP BY target_date, app_key, platform_raw, item_name, campaign, adset`
  );

  const metricMap = new Map(rows.map((row) => [asaMetricKey(row), row]));
  const today = getSevenDayLaterTodayDateString();
  const result = new Map<string, string>();

  for (const lookup of asaLookups) {
    const targetDate = addDays(lookup.report_date, 7);
    const recordKey = `${lookup.recommendation_type}:${lookup.recommendation_id}`;
    if (!targetDate) {
      result.set(recordKey, '');
      continue;
    }
    const metric = metricMap.get(
      asaMetricKey({
        target_date: targetDate,
        app_key: lookup.app_key,
        platform_raw: String(lookup.platform_raw || '').trim().toLowerCase(),
        item_name: lookup.item_name,
        campaign: String(lookup.campaign || '').trim(),
        adset: String(lookup.adset || '').trim()
      })
    );
    if (metric) {
      result.set(
        recordKey,
        formatAsaSevenDayText(
          targetDate,
          Number(metric.installs || 0),
          Number(metric.total_cost || 0),
          Number(metric.purchase_count || 0),
          Number(metric.revenue_d7 || 0)
        )
      );
      continue;
    }
    result.set(recordKey, targetDate <= today ? `D+7 ${targetDate}｜暂无相关数据` : '');
  }

  return result;
}

export async function loadSevenDayLaterLookupRowsForRecommendations(
  recommendations: Array<{ recommendation_type: RecommendationType; recommendation_id: number }>
): Promise<SevenDayLaterLookupRow[]> {
  const budgetIds = recommendations
    .filter((row) => row.recommendation_type === 'budget' && Number.isFinite(Number(row.recommendation_id)))
    .map((row) => Number(row.recommendation_id));
  const asaIds = recommendations
    .filter((row) => row.recommendation_type === 'asa_keyword' && Number.isFinite(Number(row.recommendation_id)))
    .map((row) => Number(row.recommendation_id));

  const rows: SevenDayLaterLookupRow[] = [];

  if (budgetIds.length > 0) {
    const result = await pgQuery<SevenDayLaterLookupRow>(
      `SELECT
          'budget'::text AS recommendation_type,
          id AS recommendation_id,
          date::text AS report_date,
          app_key,
          platform AS platform_raw,
          media_source,
          keyword AS item_name,
          match_type,
          ''::text AS campaign,
          ''::text AS adset
         FROM budget_recommendations
        WHERE id = ANY($1::bigint[])`,
      [budgetIds]
    );
    rows.push(...result.rows);
  }

  if (asaIds.length > 0) {
    const result = await pgQuery<SevenDayLaterLookupRow>(
      `SELECT
          'asa_keyword'::text AS recommendation_type,
          id AS recommendation_id,
          date::text AS report_date,
          app_key,
          platform AS platform_raw,
          'Apple Search Ads'::text AS media_source,
          keyword AS item_name,
          ''::text AS match_type,
          campaign,
          adset
         FROM asa_keyword_recommendations
        WHERE id = ANY($1::bigint[])`,
      [asaIds]
    );
    rows.push(...result.rows);
  }

  return rows;
}

export async function querySevenDayLaterDataForLookupRows(
  lookups: SevenDayLaterLookupRow[]
): Promise<Map<string, string>> {
  if (lookups.length === 0) {
    return new Map();
  }
  const [budgetMap, asaMap] = await Promise.all([
    loadBudgetSevenDayMetrics(lookups),
    loadAsaSevenDayMetrics(lookups)
  ]);
  return new Map([...budgetMap.entries(), ...asaMap.entries()]);
}
