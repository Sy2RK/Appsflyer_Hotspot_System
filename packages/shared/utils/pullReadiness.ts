import { env } from '../config/env.js';
import { getPreviousDateString } from './businessDate.js';
import {
  getActiveJobLock,
  getLatestOperationLogEntry,
  getPullReportReadiness,
  PullReportReadinessRecord,
  PullReportReadinessStatus
} from './repositories.js';
import type { OperationLogRecord } from '../types/models.js';

const DEFAULT_SOURCE_REPORT = 'daily_report_v5';
const BUDGET_ADVISOR_JOB_LOCK = 'worker:budget_advisor:cycle';
const ASA_KEYWORD_JOB_LOCK = 'worker:asa_keywords:cycle';

const BUDGET_ADVISOR_COMPLETION = {
  source: 'worker.budget_advisor',
  action: 'scheduled_budget_cycle',
  target_type: 'budget_cycle',
  lock_name: BUDGET_ADVISOR_JOB_LOCK
} as const;

const ASA_KEYWORD_COMPLETION = {
  source: 'worker.asa_keywords',
  action: 'scheduled_asa_keyword_cycle',
  target_type: 'asa_keyword_cycle',
  lock_name: ASA_KEYWORD_JOB_LOCK
} as const;

export interface PullReadinessCheckResult {
  ready: boolean;
  report_date: string;
  source_report: string;
  status: PullReportReadinessStatus;
  reason: string;
  record: PullReportReadinessRecord | null;
}

export interface DownstreamTaskGateStatus {
  ready: boolean;
  running: boolean;
  completion_status: OperationLogRecord['status'] | 'missing';
  completion_at: string | null;
  summary: string | null;
  reason: string;
}

export interface DownstreamAutomationGateResult {
  ready: boolean;
  report_date: string;
  reason: string;
  budget_advisor: DownstreamTaskGateStatus;
  asa_keywords: DownstreamTaskGateStatus;
}

export function getDefaultPullReadinessReportDate(now = new Date(), timeZone = env.timezone): string {
  return getPreviousDateString(1, now, timeZone);
}

export async function isPullReportReadyForDownstream(
  reportDate: string,
  sourceReport = DEFAULT_SOURCE_REPORT
): Promise<PullReadinessCheckResult> {
  const record = await getPullReportReadiness(reportDate, sourceReport);
  if (!record) {
    return {
      ready: false,
      report_date: reportDate,
      source_report: sourceReport,
      status: 'pending',
      reason: 'pull_report_readiness_missing',
      record: null
    };
  }

  if (record.status === 'ready') {
    return {
      ready: true,
      report_date: reportDate,
      source_report: sourceReport,
      status: record.status,
      reason: 'pull_report_ready',
      record
    };
  }

  const fallbackReason = record.status === 'blocked' ? 'pull_report_blocked' : 'pull_report_pending';
  return {
    ready: false,
    report_date: reportDate,
    source_report: sourceReport,
    status: record.status,
    reason: record.last_error_summary || fallbackReason,
    record
  };
}

async function getDownstreamTaskGateStatus(
  reportDate: string,
  task: {
    source: string;
    action: string;
    target_type: string;
    lock_name: string;
  }
): Promise<DownstreamTaskGateStatus> {
  const [activeLock, completionLog] = await Promise.all([
    getActiveJobLock(task.lock_name),
    getLatestOperationLogEntry({
      source: task.source,
      action: task.action,
      target_type: task.target_type,
      target_key: reportDate
    })
  ]);

  if (activeLock) {
    return {
      ready: false,
      running: true,
      completion_status: (completionLog?.status as OperationLogRecord['status'] | undefined) ?? 'missing',
      completion_at: completionLog?.created_at ?? null,
      summary: completionLog?.summary ?? null,
      reason: 'running'
    };
  }

  if (!completionLog) {
    return {
      ready: false,
      running: false,
      completion_status: 'missing',
      completion_at: null,
      summary: null,
      reason: 'missing_completion_log'
    };
  }

  if (completionLog.status !== 'success') {
    return {
      ready: false,
      running: false,
      completion_status: completionLog.status,
      completion_at: completionLog.created_at,
      summary: completionLog.summary,
      reason: `last_completion_${completionLog.status}`
    };
  }

  return {
    ready: true,
    running: false,
    completion_status: completionLog.status,
    completion_at: completionLog.created_at,
    summary: completionLog.summary,
    reason: 'completed'
  };
}

export async function isDownstreamReadyForAutomation(
  reportDate: string
): Promise<DownstreamAutomationGateResult> {
  const [budgetAdvisor, asaKeywords] = await Promise.all([
    getDownstreamTaskGateStatus(reportDate, BUDGET_ADVISOR_COMPLETION),
    getDownstreamTaskGateStatus(reportDate, ASA_KEYWORD_COMPLETION)
  ]);

  const firstBlocked =
    (!budgetAdvisor.ready && `budget_advisor_${budgetAdvisor.reason}`) ||
    (!asaKeywords.ready && `asa_keywords_${asaKeywords.reason}`) ||
    'downstream_ready';

  return {
    ready: budgetAdvisor.ready && asaKeywords.ready,
    report_date: reportDate,
    reason: firstBlocked,
    budget_advisor: budgetAdvisor,
    asa_keywords: asaKeywords
  };
}
