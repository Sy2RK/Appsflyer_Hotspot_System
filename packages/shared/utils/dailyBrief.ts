import { env } from '../config/env.js';
import { chQuery } from './clickhouse.js';
import { sendAlertNotification, sendFeishuInteractiveCardNotification, type NotificationResult } from './notifier.js';
import {
  getDailyBriefDispatch,
  listAlerts,
  listApps,
  upsertDailyBriefDispatch
} from './repositories.js';
import { pgQuery } from './postgres.js';

interface LoggerLike {
  info: (message: string, meta?: Record<string, unknown>) => void;
  warn: (message: string, meta?: Record<string, unknown>) => void;
  error: (message: string, meta?: Record<string, unknown>) => void;
}

interface DailyBriefAppMetrics {
  app_key: string;
  installs: number;
  clicks: number;
  total_cost: number;
  blended_ecpi: number;
}

interface DailyBriefBudgetHighlight {
  app_key: string;
  platform: string;
  keyword: string;
  action: string;
  change_ratio: number;
  current_ecpi: number;
  target_ecpi: number;
  confidence: number;
}

interface DailyBriefAlertHighlight {
  app_key: string;
  severity: string;
  metric: string;
  delta_value: number;
  status: string;
  explanation: string;
}

interface DailyBriefActionItem {
  priority: 'P0' | 'P1' | 'P2';
  category: 'alert' | 'budget' | 'data';
  title: string;
  detail: string;
}

const DAILY_BRIEF_BUDGET_MAX_ITEMS = 30;
const DAILY_BRIEF_BUDGET_MIN_CONFIDENCE = 0.8;
const DAILY_BRIEF_BUDGET_MIN_DELTA_RATIO = 0.25;

interface FeishuCardPayload {
  config: {
    wide_screen_mode: boolean;
    enable_forward: boolean;
  };
  header: {
    template: 'blue' | 'green' | 'orange' | 'red' | 'grey';
    title: {
      tag: 'plain_text';
      content: string;
    };
  };
  elements: Array<Record<string, unknown>>;
}

export interface DailyBriefPreview {
  report_date: string;
  title: string;
  text: string;
  today_judgment: string;
  render_mode: 'interactive' | 'text_fallback';
  feishu_card_payload: FeishuCardPayload;
  summary: {
    app_count: number;
    apps_with_data: number;
    total_installs: number;
    total_clicks: number;
    total_cost: number;
    blended_ecpi: number;
    open_alerts: number;
    pending_budget_actions: number;
  };
  app_rows: Array<DailyBriefAppMetrics & { display_name: string; open_alerts: number; pending_budget_actions: number }>;
  apps: Array<DailyBriefAppMetrics & { display_name: string; open_alerts: number; pending_budget_actions: number }>;
  budget_highlights: DailyBriefBudgetHighlight[];
  alert_highlights: DailyBriefAlertHighlight[];
  action_items: DailyBriefActionItem[];
}

export interface DailyBriefSendResult {
  ok: boolean;
  skipped: boolean;
  report: DailyBriefPreview;
  notify: NotificationResult;
  dispatch: Awaited<ReturnType<typeof upsertDailyBriefDispatch>>;
}

function numberValue(raw: unknown): number {
  const value = Number(raw);
  return Number.isFinite(value) ? value : 0;
}

function getTzParts(date: Date, timeZone: string): { year: number; month: number; day: number; hour: number } {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    hourCycle: 'h23'
  });
  const parts = formatter.formatToParts(date);
  const pick = (type: string): number => Number(parts.find((item) => item.type === type)?.value ?? 0);
  return {
    year: pick('year'),
    month: pick('month'),
    day: pick('day'),
    hour: pick('hour')
  };
}

function toDateString(year: number, month: number, day: number): string {
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function shiftDateString(dateString: string, days: number): string {
  const [year, month, day] = dateString.split('-').map(Number);
  const value = new Date(Date.UTC(year, month - 1, day));
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

export function getDailyBriefDefaultReportDate(now = new Date(), timeZone = env.timezone): string {
  const parts = getTzParts(now, timeZone);
  const today = toDateString(parts.year, parts.month, parts.day);
  return shiftDateString(today, -1);
}

export function getCurrentHourInTimezone(now = new Date(), timeZone = env.timezone): number {
  return getTzParts(now, timeZone).hour;
}

async function queryAppMetrics(reportDate: string): Promise<DailyBriefAppMetrics[]> {
  const rows = await chQuery<Record<string, unknown>>(
    `SELECT
        app_key,
        sum(installs_latest) AS installs,
        sum(clicks_latest) AS clicks,
        sum(total_cost_latest) AS total_cost,
        if(sum(installs_latest) > 0, sum(total_cost_latest) / sum(installs_latest), 0) AS blended_ecpi
      FROM (
        SELECT
          app_key,
          platform,
          country,
          media_source,
          campaign,
          argMax(toFloat64(installs), ingest_time) AS installs_latest,
          argMax(toFloat64(clicks), ingest_time) AS clicks_latest,
          argMax(toFloat64(total_cost), ingest_time) AS total_cost_latest
        FROM pull_aggregate_daily
        WHERE date = toDate({report_date:String})
        GROUP BY app_key, platform, country, media_source, campaign
      )
      GROUP BY app_key
      ORDER BY total_cost DESC, installs DESC, app_key ASC`,
    { report_date: reportDate }
  );

  return rows.map((row) => ({
    app_key: String(row.app_key || ''),
    installs: numberValue(row.installs),
    clicks: numberValue(row.clicks),
    total_cost: numberValue(row.total_cost),
    blended_ecpi: numberValue(row.blended_ecpi)
  }));
}

async function queryPendingBudgetHighlights(reportDate: string): Promise<DailyBriefBudgetHighlight[]> {
  const result = await pgQuery<DailyBriefBudgetHighlight>(
    `SELECT app_key, platform, keyword, action, change_ratio, current_ecpi, target_ecpi, confidence
       FROM budget_recommendations
      WHERE date = $1::date
        AND status = 'pending'
        AND action <> 'hold'
      ORDER BY ABS(current_ecpi - target_ecpi) DESC, confidence DESC, updated_at DESC
      LIMIT 50`,
    [reportDate]
  );
  return result.rows.filter(isSignificantBudgetHighlight).slice(0, DAILY_BRIEF_BUDGET_MAX_ITEMS);
}

async function queryPendingBudgetCounts(reportDate: string): Promise<Map<string, number>> {
  const result = await pgQuery<{ app_key: string; total: string }>(
    `SELECT app_key, to_char(count(*), 'FM999999999999999') AS total
       FROM budget_recommendations
      WHERE date = $1::date
        AND status = 'pending'
      GROUP BY app_key`,
    [reportDate]
  );
  return new Map(result.rows.map((row) => [row.app_key, Number(row.total || 0)]));
}

async function queryOpenAlertCounts(): Promise<Map<string, number>> {
  const result = await pgQuery<{ app_key: string; total: string }>(
    `SELECT app_key, to_char(count(*), 'FM999999999999999') AS total
       FROM alerts
      WHERE status = 'open'
      GROUP BY app_key`
  );
  return new Map(result.rows.map((row) => [row.app_key, Number(row.total || 0)]));
}

function formatUsd(value: number): string {
  return `$${value.toFixed(2)}`;
}

function actionLabel(action: string): string {
  if (action === 'increase') return '上调';
  if (action === 'decrease') return '下调';
  if (action === 'pause') return '暂停';
  return '保持';
}

function actionEmoji(action: string): string {
  if (action === 'increase') return '✅';
  if (action === 'decrease') return '🔻';
  if (action === 'pause') return '⏸️';
  return '➖';
}

function priorityEmoji(priority: DailyBriefActionItem['priority']): string {
  if (priority === 'P0') return '🚨';
  if (priority === 'P1') return '⚠️';
  return '💡';
}

function budgetDeltaRatio(row: Pick<DailyBriefBudgetHighlight, 'current_ecpi' | 'target_ecpi'>): number {
  const base = Math.max(Math.abs(Number(row.target_ecpi) || 0), 0.01);
  return Math.abs((Number(row.current_ecpi) || 0) - (Number(row.target_ecpi) || 0)) / base;
}

function isSignificantBudgetHighlight(row: DailyBriefBudgetHighlight): boolean {
  return (
    Number(row.confidence) >= DAILY_BRIEF_BUDGET_MIN_CONFIDENCE &&
    budgetDeltaRatio(row) >= DAILY_BRIEF_BUDGET_MIN_DELTA_RATIO
  );
}

function cardMarkdown(content: string): { tag: 'lark_md'; content: string } {
  return { tag: 'lark_md', content };
}

function metricLabel(metric: string): string {
  if (metric === 'revenue') return '收入';
  if (metric === 'event_count') return '事件数';
  if (metric === 'purchase_count') return '购买数';
  return metric || '-';
}

function severityRank(severity: string): number {
  if (severity === 'P0') return 0;
  if (severity === 'P1') return 1;
  if (severity === 'P2') return 2;
  return 3;
}

function trimSentence(value: string, limit = 56): string {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (!text) {
    return '';
  }
  return text.length > limit ? `${text.slice(0, limit)}...` : text;
}

function buildActionItems(params: {
  appRows: Array<DailyBriefAppMetrics & { display_name: string; open_alerts: number; pending_budget_actions: number }>;
  budgetHighlights: DailyBriefBudgetHighlight[];
  alertRows: DailyBriefAlertHighlight[];
  displayNameMap: Map<string, string>;
  summary: DailyBriefPreview['summary'];
}): DailyBriefActionItem[] {
  const items: DailyBriefActionItem[] = [];

  const alertCandidates = [...params.alertRows].sort((a, b) => severityRank(a.severity) - severityRank(b.severity));
  for (const row of alertCandidates.slice(0, 3)) {
    const appName = params.displayNameMap.get(row.app_key) || row.app_key;
    items.push({
      priority: row.severity === 'P0' ? 'P0' : 'P1',
      category: 'alert',
      title: `${appName} 存在 ${row.severity} 异常，优先排查 ${metricLabel(row.metric)}`,
      detail: `先检查 AppsFlyer 归因、ASA 投放变更和事件上报链路；当前偏差 ${row.delta_value.toFixed(2)}，原因摘要：${trimSentence(row.explanation, 72) || '暂无解释'}`
    });
  }

  for (const row of params.budgetHighlights.slice(0, 3)) {
    if (row.action === 'hold') {
      continue;
    }
    const appName = params.displayNameMap.get(row.app_key) || row.app_key;
    const action = actionLabel(row.action);
    const ratio = `${Math.abs(row.change_ratio * 100).toFixed(0)}%`;
    items.push({
      priority: row.action === 'pause' ? 'P0' : 'P2',
      category: 'budget',
      title: `${appName} / ${row.platform || 'unknown'} 建议${action}关键词预算 ${ratio}`,
      detail: `关键词 ${row.keyword} 当前 eCPI ${formatUsd(row.current_ecpi)}，目标 ${formatUsd(row.target_ecpi)}，置信度 ${(row.confidence * 100).toFixed(0)}%。执行前确认最近 24 小时未重复调价。`
    });
  }

  const zeroInstallHighSpend = params.appRows
    .filter((row) => row.total_cost >= 50 && row.installs <= 0)
    .sort((a, b) => b.total_cost - a.total_cost)
    .slice(0, 2);
  for (const row of zeroInstallHighSpend) {
    items.push({
      priority: 'P1',
      category: 'data',
      title: `${row.display_name} 出现“有成本无安装”`,
      detail: `当日成本 ${formatUsd(row.total_cost)}，安装 0。建议核对 Pull 回传、AppsFlyer 数据窗口和投放侧是否存在未归因或上报延迟。`
    });
  }

  if (items.length === 0) {
    items.push({
      priority: 'P2',
      category: 'data',
      title: '当前未发现需要立即处理的异常动作',
      detail: `当日未恢复告警 ${params.summary.open_alerts} 条，待处理预算建议 ${params.summary.pending_budget_actions} 条。建议按常规节奏复核高花费应用与新增关键词表现。`
    });
  }

  return items.slice(0, 6);
}

function buildTodayJudgment(summary: DailyBriefPreview['summary']): string {
  if (summary.open_alerts > 0) {
    return '当前仍有未恢复异常，建议先处理 P0/P1 告警，再执行预算动作。';
  }
  if (summary.pending_budget_actions > 0) {
    return '数据链路整体稳定，今日重点放在预算建议执行与效果复核。';
  }
  if (summary.apps_with_data === 0) {
    return '当日暂无 Pull 汇总数据，先核对 Pull 链路与 AppsFlyer 返回状态。';
  }
  return '当日未发现高优先级异常，建议继续观察高花费应用与新增关键词表现。';
}

function buildDailyBriefInteractiveCard(params: {
  reportDate: string;
  title: string;
  summary: DailyBriefPreview['summary'];
  appRows: Array<DailyBriefAppMetrics & { display_name: string; open_alerts: number; pending_budget_actions: number }>;
  budgetHighlights: DailyBriefBudgetHighlight[];
  alertRows: DailyBriefAlertHighlight[];
  actionItems: DailyBriefActionItem[];
  displayNameMap: Map<string, string>;
  todayJudgment: string;
  existingSentAt?: string | null;
}): FeishuCardPayload {
  const appOverview =
    params.appRows.length > 0
      ? params.appRows
          .slice(0, 6)
          .map(
            (row) =>
              `• **${row.display_name}**（${row.app_key}）\n安装 ${row.installs.toFixed(0)} ｜ 点击 ${row.clicks.toFixed(0)} ｜ 成本 ${formatUsd(row.total_cost)} ｜ eCPI ${formatUsd(row.blended_ecpi)} ｜ 告警 ${row.open_alerts} ｜ 预算 ${row.pending_budget_actions}`
          )
          .join('\n')
      : '• 当前日期暂无 Pull 汇总数据。';

  const budgetOverview =
    params.budgetHighlights.length > 0
      ? params.budgetHighlights
          .map(
            (row) =>
              `${actionEmoji(row.action)} **${params.displayNameMap.get(row.app_key) || row.app_key}** / ${row.platform || 'unknown'}\n${row.keyword}\n${actionLabel(row.action)} ${Math.abs(row.change_ratio * 100).toFixed(0)}% ｜ 当前 eCPI ${formatUsd(row.current_ecpi)} ｜ 目标 ${formatUsd(row.target_ecpi)} ｜ 置信度 ${(row.confidence * 100).toFixed(0)}%`
          )
          .join('\n\n')
      : '暂无待处理预算动作。';

  const alertOverview =
    params.alertRows.length > 0
      ? params.alertRows
          .map(
            (row) =>
              `• **${params.displayNameMap.get(row.app_key) || row.app_key}** / ${row.severity} / ${metricLabel(row.metric)}\nΔ ${row.delta_value.toFixed(2)} ｜ ${trimSentence(row.explanation, 72) || '暂无解释'}`
          )
          .join('\n\n')
      : '当前没有未恢复告警。';

  const actionOverview = params.actionItems
    .map(
      (item, index) =>
        `${index + 1}. ${priorityEmoji(item.priority)} **[${item.priority}] ${item.title}**\n${item.detail}`
    )
    .join('\n\n');

  const elements: Array<Record<string, unknown>> = [
    {
      tag: 'div',
      text: cardMarkdown(`📅 **报告日期**\n${params.reportDate}`)
    },
    {
      tag: 'div',
      fields: [
        { is_short: true, text: cardMarkdown(`**应用覆盖**\n${params.summary.apps_with_data}/${params.summary.app_count}`) },
        { is_short: true, text: cardMarkdown(`**综合 eCPI**\n${formatUsd(params.summary.blended_ecpi)}`) },
        { is_short: true, text: cardMarkdown(`**安装**\n${params.summary.total_installs.toFixed(0)}`) },
        { is_short: true, text: cardMarkdown(`**点击**\n${params.summary.total_clicks.toFixed(0)}`) },
        { is_short: true, text: cardMarkdown(`**成本**\n${formatUsd(params.summary.total_cost)}`) },
        { is_short: true, text: cardMarkdown(`**待处理预算**\n${params.summary.pending_budget_actions}`) }
      ]
    },
    { tag: 'hr' },
    {
      tag: 'div',
      text: cardMarkdown(`🧭 **今日判断**\n${params.todayJudgment}`)
    },
    { tag: 'hr' },
    {
      tag: 'div',
      text: cardMarkdown(`📦 **应用概览**\n${appOverview}`)
    },
    { tag: 'hr' },
    {
      tag: 'div',
      text: cardMarkdown(`🎯 **预算动作（超过阈值，共 ${params.budgetHighlights.length} 条）**\n${budgetOverview}`)
    },
    {
      tag: 'div',
      text: cardMarkdown(`⚠️ **未恢复告警 Top 5**\n${alertOverview}`)
    },
    { tag: 'hr' },
    {
      tag: 'div',
      text: cardMarkdown(`🛠️ **建议操作**\n${actionOverview}`)
    }
  ];

  if (params.existingSentAt) {
    elements.push({ tag: 'hr' });
    elements.push({
      tag: 'note',
      elements: [cardMarkdown(`📝 已于 ${new Date(params.existingSentAt).toLocaleString()} 发送过一次`)]
    });
  }

  return {
    config: {
      wide_screen_mode: true,
      enable_forward: true
    },
    header: {
      template: params.summary.open_alerts > 0 ? 'orange' : 'blue',
      title: {
        tag: 'plain_text',
        content: `📊 ${params.title}`
      }
    },
    elements
  };
}

export async function buildDailyBriefPreview(reportDate = getDailyBriefDefaultReportDate()): Promise<DailyBriefPreview> {
  const [apps, appMetrics, openAlertCounts, pendingBudgetCounts, budgetHighlights, alertHighlights, existingDispatch] =
    await Promise.all([
      listApps(),
      queryAppMetrics(reportDate),
      queryOpenAlertCounts(),
      queryPendingBudgetCounts(reportDate),
      queryPendingBudgetHighlights(reportDate),
      listAlerts({ status: 'open', limit: 5 }),
      getDailyBriefDispatch(reportDate)
    ]);

  const displayNameMap = new Map(
    apps.map((app) => [
      app.app_key,
      String(app.display_name || app.app_key).trim() || app.app_key.replaceAll('-', ' ')
    ])
  );

  const appRows = appMetrics.map((row) => ({
    ...row,
    display_name: displayNameMap.get(row.app_key) || row.app_key.replaceAll('-', ' '),
    open_alerts: openAlertCounts.get(row.app_key) ?? 0,
    pending_budget_actions: pendingBudgetCounts.get(row.app_key) ?? 0
  }));

  const summary = {
    app_count: apps.length,
    apps_with_data: appRows.length,
    total_installs: appRows.reduce((sum, row) => sum + row.installs, 0),
    total_clicks: appRows.reduce((sum, row) => sum + row.clicks, 0),
    total_cost: appRows.reduce((sum, row) => sum + row.total_cost, 0),
    blended_ecpi: 0,
    open_alerts: Array.from(openAlertCounts.values()).reduce((sum, value) => sum + value, 0),
    pending_budget_actions: Array.from(pendingBudgetCounts.values()).reduce((sum, value) => sum + value, 0)
  };
  summary.blended_ecpi = summary.total_installs > 0 ? summary.total_cost / summary.total_installs : 0;

  const alertRows: DailyBriefAlertHighlight[] = alertHighlights.map((row) => ({
    app_key: row.app_key,
    severity: row.severity,
    metric: row.metric,
    delta_value: row.delta_value,
    status: row.status,
    explanation: row.explanation
  }));

  const actionItems = buildActionItems({
    appRows,
    budgetHighlights,
    alertRows,
    displayNameMap,
    summary
  });
  const todayJudgment = buildTodayJudgment(summary);
  const cardPayload = buildDailyBriefInteractiveCard({
    reportDate,
    title: `${env.dailyBriefTitlePrefix}｜${reportDate}`,
    summary,
    appRows,
    budgetHighlights,
    alertRows,
    actionItems,
    displayNameMap,
    todayJudgment,
    existingSentAt: existingDispatch?.status === 'sent' ? existingDispatch.sent_at : null
  });

  const lines: string[] = [];
  lines.push(`报告日期：${reportDate}`);
  lines.push('');
  lines.push('【核心概览】');
  lines.push(
    `- 应用覆盖：${summary.apps_with_data}/${summary.app_count}`
  );
  lines.push(
    `- 核心指标：安装 ${summary.total_installs.toFixed(0)} ｜ 点击 ${summary.total_clicks.toFixed(0)} ｜ 成本 ${formatUsd(summary.total_cost)} ｜ 综合 eCPI ${formatUsd(summary.blended_ecpi)}`
  );
  lines.push(`- 风险状态：未恢复告警 ${summary.open_alerts} 条 ｜ 待处理预算建议 ${summary.pending_budget_actions} 条`);

  lines.push('');
  lines.push('【今日判断】');
  lines.push(`- ${todayJudgment}`);

  if (appRows.length > 0) {
    lines.push('');
    lines.push('【应用概览】');
    for (const row of appRows.slice(0, 8)) {
      lines.push(
        `- ${row.display_name} (${row.app_key})：安装 ${row.installs.toFixed(0)}，点击 ${row.clicks.toFixed(0)}，成本 ${formatUsd(row.total_cost)}，eCPI ${formatUsd(row.blended_ecpi)}，未恢复告警 ${row.open_alerts}，待处理预算 ${row.pending_budget_actions}`
      );
    }
  } else {
    lines.push('');
    lines.push('【应用概览】');
    lines.push('- 当前日期暂无 Pull 汇总数据。');
  }

  if (budgetHighlights.length > 0) {
    lines.push('');
    lines.push(`【预算动作（超过阈值，共 ${budgetHighlights.length} 条）】`);
    for (const row of budgetHighlights) {
      lines.push(
        `- ${displayNameMap.get(row.app_key) || row.app_key} / ${row.platform || 'unknown'} / ${row.keyword}：${actionLabel(row.action)} ${Math.abs(row.change_ratio * 100).toFixed(0)}%，当前 eCPI ${formatUsd(row.current_ecpi)}，目标 ${formatUsd(row.target_ecpi)}，置信度 ${(row.confidence * 100).toFixed(0)}%`
      );
    }
  }

  if (alertRows.length > 0) {
    lines.push('');
    lines.push('【未恢复告警 Top 5】');
    for (const row of alertRows) {
      lines.push(
        `- ${displayNameMap.get(row.app_key) || row.app_key} / ${row.severity} / ${metricLabel(row.metric)}：Δ ${row.delta_value.toFixed(2)}，${row.explanation.slice(0, 48)}`
      );
    }
  }

  lines.push('');
  lines.push('【建议操作】');
  actionItems.forEach((item, index) => {
    lines.push(`${index + 1}. [${item.priority}] ${item.title}`);
    lines.push(`   - ${item.detail}`);
  });

  if (existingDispatch?.status === 'sent' && existingDispatch.sent_at) {
    lines.push('');
    lines.push('【发送记录】');
    lines.push(`- 该日期日报已在 ${new Date(existingDispatch.sent_at).toLocaleString()} 发送过一次。`);
  }

  return {
    report_date: reportDate,
    title: `${env.dailyBriefTitlePrefix}｜${reportDate}`,
    text: lines.join('\n'),
    today_judgment: todayJudgment,
    render_mode: 'interactive',
    feishu_card_payload: cardPayload,
    summary,
    app_rows: appRows,
    apps: appRows,
    budget_highlights: budgetHighlights,
    alert_highlights: alertRows,
    action_items: actionItems
  };
}

export async function sendDailyBrief(
  reportDate = getDailyBriefDefaultReportDate(),
  options?: { force?: boolean; manualTriggered?: boolean }
): Promise<DailyBriefSendResult> {
  const preview = await buildDailyBriefPreview(reportDate);
  const existing = await getDailyBriefDispatch(reportDate);
  if (existing?.status === 'sent' && !options?.force) {
    return {
      ok: true,
      skipped: true,
      report: preview,
      notify: { ok: true, status: 200, render_mode: 'interactive' },
      dispatch: existing
    };
  }

  const cardNotify = await sendFeishuInteractiveCardNotification({
    title: preview.title,
    text: preview.text,
    feishuCardPayload: preview.feishu_card_payload,
    extra: {
      report_date: preview.report_date,
      report_type: 'daily_brief'
    }
  });
  const notify = cardNotify.ok
    ? cardNotify
    : await sendAlertNotification({
        title: preview.title,
        text: preview.text,
        extra: {
          report_date: preview.report_date,
          report_type: 'daily_brief'
        }
      });
  if (!cardNotify.ok && notify.ok) {
    notify.render_mode = 'text_fallback';
  }

  const dispatch = await upsertDailyBriefDispatch({
    report_date: reportDate,
    title: preview.title,
    content: preview.text,
    payload_json: preview,
    status: notify.ok ? 'sent' : 'failed',
    manual_triggered: options?.manualTriggered ?? false,
    last_error: notify.ok ? null : notify.error ?? `status_${String(notify.status ?? 'unknown')}`,
    sent_at: notify.ok ? new Date().toISOString() : null
  });

  return {
    ok: notify.ok,
    skipped: false,
    report: preview,
    notify,
    dispatch
  };
}

export async function runScheduledDailyBrief(logger: LoggerLike): Promise<void> {
  if (!env.dailyBriefEnabled) {
    logger.info('daily_brief_disabled');
    return;
  }

  const currentHour = getCurrentHourInTimezone(new Date(), env.timezone);
  if (currentHour < env.dailyBriefReportHour) {
    logger.info('daily_brief_skip_before_window', {
      current_hour: currentHour,
      report_hour: env.dailyBriefReportHour
    });
    return;
  }

  const reportDate = getDailyBriefDefaultReportDate(new Date(), env.timezone);
  const existing = await getDailyBriefDispatch(reportDate);
  if (existing?.status === 'sent') {
    logger.info('daily_brief_skip_already_sent', {
      report_date: reportDate,
      sent_at: existing.sent_at
    });
    return;
  }

  const result = await sendDailyBrief(reportDate, { force: false, manualTriggered: false });
  if (result.ok) {
    logger.info('daily_brief_sent', {
      report_date: reportDate,
      skipped: result.skipped
    });
    return;
  }

  logger.error('daily_brief_send_failed', {
    report_date: reportDate,
    error: result.notify.error ?? `status_${String(result.notify.status ?? 'unknown')}`
  });
}
