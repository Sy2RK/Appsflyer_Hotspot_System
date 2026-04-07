import crypto from 'crypto';
import { env } from '@shared/config/env.js';
import { logger } from '@api/common/logger/logger.js';
import { runAsaKeywordCycle } from '@shared/utils/asaKeywords.js';
import {
  didAsaKeywordCycleComplete,
  summarizeAsaKeywordCycleStatus
} from '@shared/utils/asaKeywordWorkerPolicy.js';
import { startJobLockHeartbeat } from '@shared/utils/jobLockHeartbeat.js';
import { writeOperationLog } from '@shared/utils/operationLog.js';
import { getDefaultPullReadinessReportDate, isPullReportReadyForDownstream } from '@shared/utils/pullReadiness.js';
import { releaseJobLock, tryAcquireJobLock } from '@shared/utils/repositories.js';
import { getTzParts, hasReachedDailyTime, nextDailyTimeLocalString } from '@shared/utils/schedule.js';
import { isScheduledWorkerTimeoutError, withScheduledWorkerTimeout } from '@shared/utils/scheduledWorkerTimeout.js';
import {
  completeScheduledWorkerRun,
  failScheduledWorkerRun,
  getScheduledWorkerRunDecision,
  tryClaimScheduledWorkerRunAttempt
} from '@shared/utils/scheduledWorkerRun.js';
import { getPullScheduleTarget } from '@shared/utils/runtimeSchedule.js';

let running = false;
let lastScheduleMarker = '';
let lastRetryBlockMarker = '';
const SCHEDULE_POLL_MS = 30 * 1000;
const ASA_KEYWORD_WORKER_NAME = 'worker.asa_keywords';
const ASA_KEYWORD_JOB_LOCK = 'worker:asa_keywords:cycle';
const ASA_KEYWORD_JOB_LOCK_TTL_MS = 5 * 60 * 1000;
const MAX_DAILY_RETRY_ATTEMPTS = 3;
const RETRY_COOLDOWN_MS = 15 * 60 * 1000;
const RETRY_POLICY = {
  max_attempts: MAX_DAILY_RETRY_ATTEMPTS,
  retry_cooldown_ms: RETRY_COOLDOWN_MS
} as const;

function summarizeAsaKeywordCycleMessage(
  reportDate: string,
  result: {
    failed_slice_count: number;
    retryable_failed_slice_count?: number;
    terminal_failed_slice_count?: number;
  }
): string {
  const completed = didAsaKeywordCycleComplete(result);
  if (result.failed_slice_count === 0) {
    return `定时重算 ASA 关键词链路完成 ${reportDate}，回算 ${env.asaKeywordBackfillDays} 天`;
  }
  if (completed) {
    const terminalFailedCount =
      typeof result.terminal_failed_slice_count === 'number'
        ? result.terminal_failed_slice_count
        : result.failed_slice_count;
    return `定时重算 ASA 关键词链路完成（${terminalFailedCount} 个切片获取失败，已按降级结果继续） ${reportDate}，回算 ${env.asaKeywordBackfillDays} 天`;
  }
  return `定时重算 ASA 关键词链路未完全完成 ${reportDate}，回算 ${env.asaKeywordBackfillDays} 天`;
}

async function tick(reportDate: string, runMarker: string): Promise<boolean> {
  if (running) {
    logger.warn('asa_keyword_cycle_skip_overlap');
    return false;
  }
  running = true;
  let lockOwnerId = '';
  let stopLockHeartbeat: (() => void) | null = null;
  let attemptClaimed = false;
  let shouldExitAfterTimeout = false;
  try {
    lockOwnerId = crypto.randomUUID();
    const lockAcquired = await tryAcquireJobLock(ASA_KEYWORD_JOB_LOCK, lockOwnerId, ASA_KEYWORD_JOB_LOCK_TTL_MS);
    if (!lockAcquired) {
      logger.warn('asa_keyword_cycle_skip_distributed_overlap');
      return false;
    }
    stopLockHeartbeat = startJobLockHeartbeat({
      lockName: ASA_KEYWORD_JOB_LOCK,
      ownerId: lockOwnerId,
      ttlMs: ASA_KEYWORD_JOB_LOCK_TTL_MS,
      logger,
      logPrefix: 'asa_keyword'
    });
    const claimDecision = await tryClaimScheduledWorkerRunAttempt(ASA_KEYWORD_WORKER_NAME, runMarker, RETRY_POLICY);
    if (!claimDecision.allowed) {
      logger.info('asa_keyword_attempt_claim_skipped', {
        report_date: reportDate,
        run_marker: runMarker,
        reason: claimDecision.reason,
        remaining_attempts: claimDecision.remaining_attempts,
        next_allowed_at: claimDecision.next_allowed_at
      });
      return false;
    }
    attemptClaimed = true;
    const result = await withScheduledWorkerTimeout(
      ASA_KEYWORD_WORKER_NAME,
      env.scheduledWorkerMaxRuntimeMs,
      () => runAsaKeywordCycle(env.asaKeywordBackfillDays, logger)
    );
    logger.info('asa_keyword_cycle_result', { report_date: reportDate, ...result });
    const completed = didAsaKeywordCycleComplete(result);
    if (completed) {
      await completeScheduledWorkerRun(ASA_KEYWORD_WORKER_NAME, runMarker);
    } else {
      await failScheduledWorkerRun(
        ASA_KEYWORD_WORKER_NAME,
        runMarker,
        `asa_keyword_retryable_failed_slices=${result.retryable_failed_slice_count}`
      );
    }
    await writeOperationLog(
      {
        source: 'worker.asa_keywords',
        action: 'scheduled_asa_keyword_cycle',
        target_type: 'asa_keyword_cycle',
        target_key: reportDate,
        status: summarizeAsaKeywordCycleStatus(result),
        summary: summarizeAsaKeywordCycleMessage(reportDate, result),
        detail_json: {
          report_date: reportDate,
          completed,
          ...result
        }
      },
      logger
    );
    return completed;
  } catch (error) {
    shouldExitAfterTimeout = isScheduledWorkerTimeoutError(error);
    if (attemptClaimed) {
      await failScheduledWorkerRun(
        ASA_KEYWORD_WORKER_NAME,
        runMarker,
        error instanceof Error ? error.message : String(error)
      );
    }
    logger.error('asa_keyword_cycle_failed', {
      report_date: reportDate,
      error: error instanceof Error ? error.message : String(error)
    });
    await writeOperationLog(
      {
        source: 'worker.asa_keywords',
        action: 'scheduled_asa_keyword_cycle',
        target_type: 'asa_keyword_cycle',
        target_key: reportDate,
        status: 'failed',
        summary: `定时重算 ASA 关键词链路失败 ${reportDate}`,
        detail_json: {
          report_date: reportDate,
          error: error instanceof Error ? error.message : String(error)
        }
      },
      logger
    );
    return false;
  } finally {
    stopLockHeartbeat?.();
    if (lockOwnerId) {
      await releaseJobLock(ASA_KEYWORD_JOB_LOCK, lockOwnerId);
    }
    running = false;
    if (shouldExitAfterTimeout) {
      logger.error('asa_keyword_process_exit_after_timeout', {
        report_date: reportDate,
        timeout_ms: env.scheduledWorkerMaxRuntimeMs
      });
      process.exit(1);
    }
  }
}

async function bootstrap(): Promise<void> {
  if (env.asaKeywordRunOnBoot) {
    const now = new Date();
    const reportDate = getDefaultPullReadinessReportDate(now, env.timezone);
    const target = await getPullScheduleTarget();
    const parts = getTzParts(now, env.timezone);
    const runMarker = `${parts.year}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}|${target.time}`;
    const readiness = await isPullReportReadyForDownstream(reportDate);
    if (!readiness.ready) {
      logger.info('asa_keyword_cycle_blocked_by_pull_gate', {
        report_date: reportDate,
        gate_status: readiness.status,
        reason: readiness.reason
      });
    } else {
      const decision = await getScheduledWorkerRunDecision(ASA_KEYWORD_WORKER_NAME, runMarker, RETRY_POLICY, now);
      if (decision.allowed) {
        lastRetryBlockMarker = '';
        await tick(reportDate, runMarker);
      }
    }
  }

  const scheduleLoop = async (): Promise<void> => {
    try {
      const target = await getPullScheduleTarget();
      const now = new Date();
      const parts = getTzParts(now, env.timezone);
      const dateKey = `${parts.year}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`;
      const runMarker = `${dateKey}|${target.time}`;
      const scheduleMarker = `${runMarker}|${nextDailyTimeLocalString(target.hour, target.minute, env.timezone, now)}`;

      if (scheduleMarker !== lastScheduleMarker) {
        lastScheduleMarker = scheduleMarker;
        logger.info('asa_keyword_next_scheduled', {
          timezone: env.timezone,
          report_time: target.time,
          next_run_local: nextDailyTimeLocalString(target.hour, target.minute, env.timezone, now)
        });
      }

      if (hasReachedDailyTime(target.hour, target.minute, env.timezone, now)) {
        const reportDate = getDefaultPullReadinessReportDate(now, env.timezone);
        const readiness = await isPullReportReadyForDownstream(reportDate);
        if (!readiness.ready) {
          logger.info('asa_keyword_cycle_blocked_by_pull_gate', {
            report_date: reportDate,
            gate_status: readiness.status,
            reason: readiness.reason
          });
        } else {
          const decision = await getScheduledWorkerRunDecision(ASA_KEYWORD_WORKER_NAME, runMarker, RETRY_POLICY, now);
          if (!decision.allowed) {
            const blockMarker = `${runMarker}|${decision.reason}|${decision.next_allowed_at || 'none'}`;
            if (lastRetryBlockMarker !== blockMarker) {
              lastRetryBlockMarker = blockMarker;
              logger.warn('asa_keyword_run_suppressed', {
                report_date: reportDate,
                run_marker: runMarker,
                reason: decision.reason,
                remaining_attempts: decision.remaining_attempts,
                next_allowed_at: decision.next_allowed_at
              });
            }
            return;
          }
          lastRetryBlockMarker = '';
          await tick(reportDate, runMarker);
        }
      }
    } finally {
      setTimeout(() => {
        scheduleLoop().catch((error) => {
          logger.error('asa_keyword_schedule_loop_failed', {
            error: error instanceof Error ? error.message : String(error)
          });
        });
      }, SCHEDULE_POLL_MS);
    }
  };

  await scheduleLoop();
}

bootstrap().catch((error) => {
  logger.error('asa_keyword_bootstrap_failed', {
    error: error instanceof Error ? error.message : String(error)
  });
  process.exit(1);
});
