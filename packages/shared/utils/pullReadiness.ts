import { env } from '../config/env.js';
import { getPreviousDateString, shiftDateString } from './businessDate.js';
import {
  getActiveJobLock,
  getLatestOperationLogEntry,
  getPullReportReadiness,
  PullReportReadinessRecord,
  PullReportReadinessStatus,
  getScheduledWorkerRun
} from './repositories.js';
import type { OperationLogRecord } from '../types/models.js';
import { getPullScheduleTarget } from './runtimeSchedule.js';

const DEFAULT_SOURCE_REPORT = 'daily_report_v5';
const BUDGET_ADVISOR_JOB_LOCK = 'worker:budget_advisor:cycle';
const ASA_KEYWORD_JOB_LOCK = 'worker:asa_keywords:cycle';

const BUDGET_ADVISOR_COMPLETION = {
  worker_name: 'worker.budget_advisor',
  source: 'worker.budget_advisor',
  action: 'scheduled_budget_cycle',
  target_type: 'budget_cycle',
  lock_name: BUDGET_ADVISOR_JOB_LOCK
} as const;

const ASA_KEYWORD_COMPLETION = {
  worker_name: 'worker.asa_keywords',
  source: 'worker.asa_keywords',
  action: 'scheduled_asa_keyword_cycle',
  target_type: 'asa_keyword_cycle',
  lock_name: ASA_KEYWORD_JOB_LOCK
} as const;

const KEYWORD_ENGINE_JOB_LOCK = 'worker:keyword_engine:cycle';

const KEYWORD_ENGINE_COMPLETION = {
  worker_name: 'worker.keyword_engine',
  source: 'worker.keyword_engine',
  action: 'scheduled_keyword_cycle',
  target_type: 'keyword_cycle',
  lock_name: KEYWORD_ENGINE_JOB_LOCK
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
  keyword_engine: DownstreamTaskGateStatus;
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
  runMarker: string,
  task: {
    worker_name: string;
    source: string;
    action: string;
    target_type: string;
    lock_name: string;
  }
): Promise<DownstreamTaskGateStatus> {
  const [activeLock, completionLog, scheduledRun] = await Promise.all([
    getActiveJobLock(task.lock_name),
    getLatestOperationLogEntry({
      source: task.source,
      action: task.action,
      target_type: task.target_type,
      target_key: reportDate
    }),
    getScheduledWorkerRun(task.worker_name, runMarker)
  ]);

  if (activeLock || scheduledRun?.status === 'running') {
    return {
      ready: false,
      running: true,
      completion_status:
        (completionLog?.status as OperationLogRecord['status'] | undefined) ??
        ((scheduledRun?.status === 'failed' ? 'failed' : undefined) as OperationLogRecord['status'] | undefined) ??
        'missing',
      completion_at: completionLog?.created_at ?? scheduledRun?.updated_at ?? null,
      summary: completionLog?.summary ?? scheduledRun?.last_error ?? null,
      reason: 'running'
    };
  }

  if (scheduledRun?.status === 'completed' && scheduledRun.completed_at) {
    const successLog = completionLog?.status === 'success' ? completionLog : null;
    return {
      ready: true,
      running: false,
      completion_status: 'success',
      completion_at: successLog?.created_at ?? scheduledRun.completed_at,
      summary: successLog?.summary ?? 'scheduled_worker_run_completed',
      reason: successLog ? 'completed' : 'completed_without_log'
    };
  }

  if (scheduledRun?.status === 'failed') {
    const failedLog = completionLog?.status === 'failed' ? completionLog : null;
    return {
      ready: false,
      running: false,
      completion_status: 'failed',
      completion_at: failedLog?.created_at ?? scheduledRun.updated_at ?? null,
      summary: failedLog?.summary ?? scheduledRun.last_error ?? null,
      reason: failedLog ? 'last_completion_failed' : 'last_completion_failed'
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
  const pullTarget = await getPullScheduleTarget();
  const runMarker = `${shiftDateString(reportDate, 1)}|${pullTarget.time}`;
  const [keywordEngine, budgetAdvisor, asaKeywords] = await Promise.all([
    getDownstreamTaskGateStatus(reportDate, runMarker, KEYWORD_ENGINE_COMPLETION),
    getDownstreamTaskGateStatus(reportDate, runMarker, BUDGET_ADVISOR_COMPLETION),
    getDownstreamTaskGateStatus(reportDate, runMarker, ASA_KEYWORD_COMPLETION)
  ]);

  const firstBlocked =
    (!keywordEngine.ready && `keyword_engine_${keywordEngine.reason}`) ||
    (!budgetAdvisor.ready && `budget_advisor_${budgetAdvisor.reason}`) ||
    (!asaKeywords.ready && `asa_keywords_${asaKeywords.reason}`) ||
    'downstream_ready';

  return {
    ready: keywordEngine.ready && budgetAdvisor.ready && asaKeywords.ready,
    report_date: reportDate,
    reason: firstBlocked,
    keyword_engine: keywordEngine,
    budget_advisor: budgetAdvisor,
    asa_keywords: asaKeywords
  };
}
