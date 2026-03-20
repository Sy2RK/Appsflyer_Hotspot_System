import { chQuery } from '@shared/utils/clickhouse.js';
import {
  createAlert,
  findRecentOpenAlertByFingerprint,
  listEnabledRulesWithApp,
  listOpenAlertsByRuleMetric,
  resolveOpenAlertsByRuleMetric
} from '@shared/utils/repositories.js';
import { MetricRule, Severity } from '@shared/types/rules.js';
import { md5Hex } from '@shared/utils/hash.js';
import { parseRuleDsl } from '@shared/utils/ruleParser.js';
import { addDays, addHours, floorToHour, median, parseWindow } from '@shared/utils/time.js';
import { sendAlertNotification } from '@shared/utils/notifier.js';
import { logger } from '@api/common/logger/logger.js';
import { explainAnomaly } from './explainEngine.js';

interface DetectionResult {
  status: 'normal' | 'spike' | 'drop' | 'zero';
  current: number;
  baseline: number;
  delta: number;
  deltaRatio: number;
  severity?: Severity;
}

function toCHDate(date: Date): string {
  return date.toISOString().slice(0, 19).replace('T', ' ');
}

function metricIdentity(metricRule: MetricRule): string {
  if (metricRule.metric === 'event_count' && metricRule.event_name) {
    return `${metricRule.metric}:${metricRule.event_name}`;
  }
  return metricRule.metric;
}

function resolveEventNameFilter(metricRule: MetricRule): string | null {
  if (metricRule.metric === 'revenue') {
    return '__all__';
  }
  if (metricRule.metric === 'purchase_count') {
    return 'purchase';
  }
  if (metricRule.metric === 'event_count' && metricRule.event_name) {
    return metricRule.event_name;
  }
  return null;
}

async function queryWindowMetricValue(params: {
  appKey: string;
  platform: string;
  metricRule: MetricRule;
  start: Date;
  end: Date;
}): Promise<number> {
  const eventNameFilter = resolveEventNameFilter(params.metricRule);
  const eventNameClause = eventNameFilter ? `AND event_name = {event_name:String}` : '';

  const rows = await chQuery<{ value: string }>(
    `SELECT toString(sum(value)) AS value
       FROM metrics_hourly FINAL
      WHERE app_key = {app_key:String}
        AND metric = {metric:String}
        ${eventNameClause}
        AND hour >= toDateTime({start:String})
        AND hour < toDateTime({end:String})
        AND platform = {platform:String}
        AND attribution = 'unknown'
        AND event_type = 'unknown'
        AND media_source = '__all__'
        AND country = '__all__'
        AND campaign = '__all__'`,
    {
      app_key: params.appKey,
      metric: params.metricRule.metric,
      event_name: eventNameFilter ?? '',
      platform: params.platform,
      start: toCHDate(params.start),
      end: toCHDate(params.end)
    }
  );

  return Number(rows[0]?.value ?? 0);
}

async function computeBaseline(params: {
  appKey: string;
  platform: string;
  metricRule: MetricRule;
  windowStart: Date;
  windowEnd: Date;
}): Promise<number> {
  const days = params.metricRule.baseline === 'median_14d_same_hour' ? 14 : 7;
  const samples: number[] = [];

  for (let day = 1; day <= days; day += 1) {
    const start = addDays(params.windowStart, -day);
    const end = addDays(params.windowEnd, -day);
    const value = await queryWindowMetricValue({
      appKey: params.appKey,
      platform: params.platform,
      metricRule: params.metricRule,
      start,
      end
    });
    samples.push(value);
  }

  if (samples.length === 0) {
    return 0;
  }

  if (params.metricRule.baseline === 'median_14d_same_hour') {
    return median(samples);
  }

  return samples.reduce((acc, n) => acc + n, 0) / samples.length;
}

function evaluateMetric(metricRule: MetricRule, current: number, baseline: number): DetectionResult {
  const delta = current - baseline;
  const absDelta = Math.abs(delta);

  if (current === 0 && baseline > metricRule.min_abs_delta) {
    return {
      status: 'zero',
      current,
      baseline,
      delta,
      deltaRatio: -1,
      severity: 'P0'
    };
  }

  if (baseline <= 0 && current > metricRule.min_abs_delta) {
    return {
      status: 'spike',
      current,
      baseline,
      delta,
      deltaRatio: 999,
      severity: metricRule.severity.spike
    };
  }

  if (current > baseline * metricRule.up_ratio && absDelta > metricRule.min_abs_delta) {
    return {
      status: 'spike',
      current,
      baseline,
      delta,
      deltaRatio: baseline === 0 ? 999 : delta / baseline,
      severity: metricRule.severity.spike
    };
  }

  if (current < baseline * metricRule.down_ratio && absDelta > metricRule.min_abs_delta) {
    return {
      status: 'drop',
      current,
      baseline,
      delta,
      deltaRatio: baseline === 0 ? -1 : delta / baseline,
      severity: metricRule.severity.drop
    };
  }

  return {
    status: 'normal',
    current,
    baseline,
    delta,
    deltaRatio: baseline === 0 ? 0 : delta / baseline
  };
}

export interface DetectorRunStats {
  runtimeMs: number;
  checkedRules: number;
  openedAlerts: number;
  resolvedAlerts: number;
  alertNotifySuccess: number;
  alertNotifyFailure: number;
}

function rulePlatforms(row: { ios_pull_app_id?: string | null; android_pull_app_id?: string | null }): string[] {
  const scopes = ['__all__'];
  if (String(row.ios_pull_app_id || '').trim()) {
    scopes.push('ios');
  }
  if (String(row.android_pull_app_id || '').trim()) {
    scopes.push('android');
  }
  return scopes;
}

export async function runDetectionCycle(): Promise<DetectorRunStats> {
  const cycleStart = Date.now();
  const now = new Date();

  const stats: DetectorRunStats = {
    runtimeMs: 0,
    checkedRules: 0,
    openedAlerts: 0,
    resolvedAlerts: 0,
    alertNotifySuccess: 0,
    alertNotifyFailure: 0
  };

  const rows = await listEnabledRulesWithApp();

  for (const row of rows) {
    const parsedRule = parseRuleDsl(row.rule_json);
    if (!parsedRule) {
      logger.warn('rule_parse_failed', { rule_id: row.id, app_key: row.app_key });
      continue;
    }

    const silenceMinutes = parsedRule.silence_minutes ?? 30;

    for (const metricRule of parsedRule.metrics) {
      for (const platform of rulePlatforms(row)) {
        stats.checkedRules += 1;
        try {
          const metricKey = metricIdentity(metricRule);
          const window = parseWindow(metricRule.window);
          const windowEnd = floorToHour(now);
          const windowStart = addHours(windowEnd, -window.hours);

          const current = await queryWindowMetricValue({
            appKey: row.app_key,
            platform,
            metricRule,
            start: windowStart,
            end: windowEnd
          });
          const baseline = await computeBaseline({
            appKey: row.app_key,
            platform,
            metricRule,
            windowStart,
            windowEnd
          });
          const result = evaluateMetric(metricRule, current, baseline);

          if (result.status === 'normal') {
            const openAlerts = await listOpenAlertsByRuleMetric(row.app_key, platform, row.id, metricKey, metricRule.window);
            if (openAlerts.length > 0) {
              const resolvedCount = await resolveOpenAlertsByRuleMetric(
                row.app_key,
                platform,
                row.id,
                metricKey,
                metricRule.window
              );
              stats.resolvedAlerts += resolvedCount;

              const notifyRes = await sendAlertNotification(
                {
                  title: `[Hotspot][RESOLVED] ${row.app_key}${platform === '__all__' ? '' : `/${platform}`} ${metricKey}`,
                  text: `rule=${row.name}\nplatform=${platform}\nwindow=${metricRule.window}\nresolved_alerts=${resolvedCount}\ncurrent=${current.toFixed(
                    2
                  )}\nbaseline=${baseline.toFixed(2)}`
                },
                row
              );

              if (notifyRes.ok) {
                stats.alertNotifySuccess += 1;
              } else {
                stats.alertNotifyFailure += 1;
              }
            }
            continue;
          }

          const explain = await explainAnomaly({
            appKey: row.app_key,
            platform,
            metricRule,
            windowStart,
            windowEnd,
            direction: result.status
          });

          const major = explain.top_contributors[0];
          const fingerprint = md5Hex(
            [
              row.app_key,
              platform,
              metricKey,
              metricRule.window,
              major?.dim ?? 'none',
              major?.key ?? 'none'
            ].join('|')
          );

          const suppressed = await findRecentOpenAlertByFingerprint(fingerprint, silenceMinutes);
          if (suppressed) {
            logger.info('alert_suppressed', {
              app_key: row.app_key,
              platform,
              rule_id: row.id,
              metric: metricKey,
              fingerprint,
              silence_minutes: silenceMinutes
            });
            continue;
          }

          const created = await createAlert({
            app_key: row.app_key,
            platform,
            rule_id: row.id,
            severity: result.severity ?? 'P2',
            status: 'open',
            metric: metricKey,
            window: metricRule.window,
            current_value: result.current,
            baseline_value: result.baseline,
            delta_value: result.delta,
            delta_ratio: result.deltaRatio,
            top_contributors: explain.top_contributors,
            explanation: explain.hypothesis,
            fingerprint
          });
          stats.openedAlerts += 1;

          const notifyRes = await sendAlertNotification(
            {
              title: `[Hotspot][${result.severity}] ${row.app_key}${platform === '__all__' ? '' : `/${platform}`} ${metricKey} ${result.status.toUpperCase()}`,
              text:
                `rule=${row.name}\n` +
                `platform=${platform}\n` +
                `window=${metricRule.window} (${toCHDate(windowStart)} -> ${toCHDate(windowEnd)})\n` +
                `current=${result.current.toFixed(2)} baseline=${result.baseline.toFixed(2)} ` +
                `delta=${result.delta.toFixed(2)} ratio=${result.deltaRatio.toFixed(4)}\n` +
                `fingerprint=${fingerprint}\n` +
                `top=${JSON.stringify(explain.top_contributors)}\n` +
                `explanation=${explain.hypothesis}\n` +
                `alert_id=${created.id}`
            },
            row
          );

          if (notifyRes.ok) {
            stats.alertNotifySuccess += 1;
          } else {
            stats.alertNotifyFailure += 1;
          }
        } catch (error) {
          logger.warn('rule_eval_failed', {
            app_key: row.app_key,
            rule_id: row.id,
            platform,
            metric: metricRule.metric,
            window: metricRule.window,
            error: error instanceof Error ? error.message : String(error)
          });
          continue;
        }
      }
    }
  }

  stats.runtimeMs = Date.now() - cycleStart;
  return stats;
}
