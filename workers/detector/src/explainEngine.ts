import { chQuery } from '@shared/utils/clickhouse.js';
import { MetricRule } from '@shared/types/rules.js';
import { addDays } from '@shared/utils/time.js';

export interface Contributor {
  dim: string;
  key: string;
  delta: number;
  pct: number;
}

export interface ExplainResult {
  top_contributors: Contributor[];
  hypothesis: string;
}

const DIM_EXPR: Record<string, string> = {
  media_source: "if(empty(media_source), 'unknown', media_source)",
  country: "if(empty(country), 'unknown', country)",
  campaign: "if(empty(campaign), 'unknown', campaign)",
  attribution: "if(empty(attribution), 'unknown', attribution)",
  event_type: "if(empty(event_type), 'unknown', event_type)"
};

function toCHDate(date: Date): string {
  return date.toISOString().slice(0, 19).replace('T', ' ');
}

function metricExpression(metricRule: MetricRule): string {
  if (metricRule.metric === 'revenue') {
    return 'sum(revenue)';
  }
  if (metricRule.metric === 'purchase_count') {
    return "toFloat64(countIf(event_name = 'purchase'))";
  }
  return 'toFloat64(count())';
}

function buildEventNameFilter(metricRule: MetricRule): string {
  if (metricRule.metric === 'purchase_count') {
    return "AND event_name = 'purchase'";
  }
  if (metricRule.metric === 'event_count' && metricRule.event_name) {
    return `AND event_name = '${metricRule.event_name.replace(/'/g, "''")}'`;
  }
  return '';
}

function listWindowHours(windowStart: Date, windowEnd: Date): number[] {
  const hours = new Set<number>();
  let cursor = new Date(windowStart);
  while (cursor < windowEnd) {
    hours.add(cursor.getHours());
    cursor = new Date(cursor.getTime() + 60 * 60 * 1000);
  }
  return [...hours.values()];
}

export async function explainAnomaly(params: {
  appKey: string;
  windowStart: Date;
  windowEnd: Date;
  metricRule: MetricRule;
  baselineDays?: number;
  topN?: number;
  direction: 'spike' | 'drop' | 'zero';
}): Promise<ExplainResult> {
  const { appKey, windowStart, windowEnd, metricRule, direction } = params;
  const baselineDays = params.baselineDays ?? 7;
  const topN = params.topN ?? 5;

  const baselineStart = addDays(windowStart, -baselineDays);
  const baselineEnd = windowStart;

  const metricExpr = metricExpression(metricRule);
  const eventNameFilter = buildEventNameFilter(metricRule);
  const hoursList = listWindowHours(windowStart, windowEnd);
  const hoursSql = hoursList.length ? hoursList.join(',') : '0';

  const items: Contributor[] = [];

  for (const dim of metricRule.drilldown_dims) {
    const dimExpr = DIM_EXPR[dim];
    if (!dimExpr) {
      continue;
    }

    const currentRows = await chQuery<{ dim_key: string; value: string }>(
      `SELECT
          ${dimExpr} AS dim_key,
          ${metricExpr} AS value
        FROM raw_events
       WHERE app_key = {app_key:String}
         AND event_time >= toDateTime({window_start:String})
         AND event_time < toDateTime({window_end:String})
         ${eventNameFilter}
       GROUP BY dim_key`,
      {
        app_key: appKey,
        window_start: toCHDate(windowStart),
        window_end: toCHDate(windowEnd)
      }
    );

    const baselineRows = await chQuery<{ dim_key: string; baseline_value: string }>(
      `SELECT
         dim_key,
         avg(v) AS baseline_value
       FROM (
         SELECT
           toDate(event_time) AS d,
           ${dimExpr} AS dim_key,
           ${metricExpr} AS v
         FROM raw_events
         WHERE app_key = {app_key:String}
           AND event_time >= toDateTime({baseline_start:String})
           AND event_time < toDateTime({baseline_end:String})
           AND toHour(event_time) IN (${hoursSql})
           ${eventNameFilter}
         GROUP BY d, dim_key
       )
       GROUP BY dim_key`,
      {
        app_key: appKey,
        baseline_start: toCHDate(baselineStart),
        baseline_end: toCHDate(baselineEnd)
      }
    );

    const baselineMap = new Map<string, number>();
    for (const row of baselineRows) {
      baselineMap.set(row.dim_key, Number(row.baseline_value ?? 0));
    }

    for (const row of currentRows) {
      const current = Number(row.value ?? 0);
      const baseline = baselineMap.get(row.dim_key) ?? 0;
      const delta = current - baseline;
      items.push({
        dim,
        key: row.dim_key,
        delta,
        pct: 0
      });
    }
  }

  const filtered = items.filter((item) => {
    if (direction === 'drop' || direction === 'zero') {
      return item.delta < 0;
    }
    return item.delta > 0;
  });

  const denominator = filtered.reduce((acc, item) => acc + Math.abs(item.delta), 0) || 1;

  filtered.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
  const top = filtered.slice(0, topN).map((item) => ({
    ...item,
    pct: Number((Math.abs(item.delta) / denominator).toFixed(4))
  }));

  const keySummary = top.slice(0, 2).map((x) => `${x.dim}:${x.key}`).join(' / ');
  const hypothesis =
    direction === 'spike'
      ? `增长主要来自 ${keySummary || 'unknown'}，建议检查预算、活动变更或外部曝光。`
      : `下降主要来自 ${keySummary || 'unknown'}，建议检查归因回传、投放状态或数据延迟。`;

  return {
    top_contributors: top,
    hypothesis
  };
}
