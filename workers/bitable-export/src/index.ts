import crypto from 'crypto';
import { logger } from '@api/common/logger/logger.js';
import { env } from '@shared/config/env.js';
import { startJobLockHeartbeat } from '@shared/utils/jobLockHeartbeat.js';
import { runScheduledBitableExports } from '@shared/utils/bitableExport.js';
import { writeOperationLog } from '@shared/utils/operationLog.js';
import {
  getDefaultPullReadinessReportDate,
  isDownstreamReadyForAutomation,
  isPullReportReadyForDownstream
} from '@shared/utils/pullReadiness.js';
import { releaseJobLock, tryAcquireJobLock } from '@shared/utils/repositories.js';
import {
  getTzParts,
  hasReachedDailyTime,
  nextDailyTimeLocalString
} from '@shared/utils/schedule.js';
import { isScheduledWorkerTimeoutError, withScheduledWorkerTimeout } from '@shared/utils/scheduledWorkerTimeout.js';
import {
  completeScheduledWorkerRun,
  failScheduledWorkerRun,
  getScheduledWorkerRunDecision,
  tryClaimScheduledWorkerRunAttempt
} from '@shared/utils/scheduledWorkerRun.js';
import { getBitableScheduleTarget } from '@shared/utils/runtimeSchedule.js';

let running = false;
let lastScheduleMarker = '';
let lastRetryBlockMarker = '';
const SCHEDULE_POLL_MS = 30 * 1000;
const BITABLE_EXPORT_WORKER_NAME = 'worker.bitable_export';
const BITABLE_EXPORT_JOB_LOCK = 'worker:bitable_export:tick';
const BITABLE_EXPORT_JOB_LOCK_TTL_MS = 5 * 60 * 1000;
const MAX_DAILY_RETRY_ATTEMPTS = 3;
const RETRY_COOLDOWN_MS = 15 * 60 * 1000;
const RETRY_POLICY = {
  max_attempts: MAX_DAILY_RETRY_ATTEMPTS,
  retry_cooldown_ms: RETRY_COOLDOWN_MS
} as const;

async function tick(runMarker: string): Promise<boolean> {
  if (running) {
    logger.warn('bitable_export_skip_overlap');
    return false;
  }

  running = true;
  let lockOwnerId = '';
  let stopLockHeartbeat: (() => void) | null = null;
  let attemptClaimed = false;
  let completed = false;
  let shouldExitAfterTimeout = false;
  try {
    lockOwnerId = crypto.randomUUID();
    const lockAcquired = await tryAcquireJobLock(
      BITABLE_EXPORT_JOB_LOCK,
      lockOwnerId,
      BITABLE_EXPORT_JOB_LOCK_TTL_MS
    );
    if (!lockAcquired) {
      logger.warn('bitable_export_skip_distributed_overlap');
      return false;
    }
    stopLockHeartbeat = startJobLockHeartbeat({
      lockName: BITABLE_EXPORT_JOB_LOCK,
      ownerId: lockOwnerId,
      ttlMs: BITABLE_EXPORT_JOB_LOCK_TTL_MS,
      logger,
      logPrefix: 'bitable_export'
    });
    const claimDecision = await tryClaimScheduledWorkerRunAttempt(
      BITABLE_EXPORT_WORKER_NAME,
      runMarker,
      RETRY_POLICY
    );
    if (!claimDecision.allowed) {
      logger.info('bitable_export_attempt_claim_skipped', {
        run_marker: runMarker,
        reason: claimDecision.reason,
        remaining_attempts: claimDecision.remaining_attempts,
        next_allowed_at: claimDecision.next_allowed_at
      });
      return false;
    }
    attemptClaimed = true;
    const result = await withScheduledWorkerTimeout(
      BITABLE_EXPORT_WORKER_NAME,
      env.scheduledWorkerMaxRuntimeMs,
      () => runScheduledBitableExports(logger)
    );
    completed = result.completed;
    if (completed) {
      await completeScheduledWorkerRun(BITABLE_EXPORT_WORKER_NAME, runMarker);
    } else {
      await failScheduledWorkerRun(
        BITABLE_EXPORT_WORKER_NAME,
        runMarker,
        result.error || `bitable_export_failed_count=${result.failed_count}`
      );
    }
    await writeOperationLog(
      {
        source: 'worker.bitable_export',
        action: 'scheduled_bitable_export_tick',
        target_type: 'bitable_export',
        target_key: 'runtime_push_time_plus_5m',
        status: completed ? 'success' : 'failed',
        summary: completed ? '定时多维表格导出检查完成' : '定时多维表格导出检查未完成',
        detail_json: result
      },
      logger
    );
  } catch (error) {
    shouldExitAfterTimeout = isScheduledWorkerTimeoutError(error);
    if (attemptClaimed) {
      await failScheduledWorkerRun(
        BITABLE_EXPORT_WORKER_NAME,
        runMarker,
        error instanceof Error ? error.message : String(error)
      );
    }
    logger.error('bitable_export_cycle_failed', {
      error: error instanceof Error ? error.message : String(error)
    });
    await writeOperationLog(
      {
        source: 'worker.bitable_export',
        action: 'scheduled_bitable_export_tick',
        target_type: 'bitable_export',
        target_key: 'runtime_push_time_plus_5m',
        status: 'failed',
        summary: '定时多维表格导出检查失败',
        detail_json: {
          error: error instanceof Error ? error.message : String(error)
        }
      },
      logger
    );
  } finally {
    stopLockHeartbeat?.();
    if (lockOwnerId) {
      await releaseJobLock(BITABLE_EXPORT_JOB_LOCK, lockOwnerId);
    }
    running = false;
    if (shouldExitAfterTimeout) {
      logger.error('bitable_export_process_exit_after_timeout', {
        run_marker: runMarker,
        timeout_ms: env.scheduledWorkerMaxRuntimeMs
      });
      process.exit(1);
    }
  }

  return completed;
}

async function bootstrap(): Promise<void> {
  const scheduleLoop = async (): Promise<void> => {
    try {
      const target = await getBitableScheduleTarget();
      const now = new Date();
      const parts = getTzParts(now, env.timezone);
      const dateKey = `${parts.year}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`;
      const runMarker = `${dateKey}|${target.time}`;
      const scheduleMarker = `${runMarker}|${nextDailyTimeLocalString(target.hour, target.minute, env.timezone, now)}`;

      if (scheduleMarker !== lastScheduleMarker) {
        lastScheduleMarker = scheduleMarker;
        logger.info('bitable_export_next_scheduled', {
          timezone: env.timezone,
          report_time: target.time,
          next_run_local: nextDailyTimeLocalString(target.hour, target.minute, env.timezone, now)
        });
      }

      if (hasReachedDailyTime(target.hour, target.minute, env.timezone, now)) {
        const reportDate = getDefaultPullReadinessReportDate(now, env.timezone);
        const readiness = await isPullReportReadyForDownstream(reportDate);
        if (!readiness.ready) {
          logger.info('bitable_export_blocked_by_pull_gate', {
            report_date: reportDate,
            gate_status: readiness.status,
            reason: readiness.reason
          });
        } else {
          const downstreamGate = await isDownstreamReadyForAutomation(reportDate);
          if (!downstreamGate.ready) {
            logger.info('bitable_export_blocked_by_downstream_gate', {
              report_date: reportDate,
              reason: downstreamGate.reason,
              budget_advisor: downstreamGate.budget_advisor,
              asa_keywords: downstreamGate.asa_keywords
            });
          } else {
            const decision = await getScheduledWorkerRunDecision(
              BITABLE_EXPORT_WORKER_NAME,
              runMarker,
              RETRY_POLICY,
              now
            );
            if (!decision.allowed) {
              const blockMarker = `${runMarker}|${decision.reason}|${decision.next_allowed_at || 'none'}`;
              if (lastRetryBlockMarker !== blockMarker) {
                lastRetryBlockMarker = blockMarker;
                logger.warn('bitable_export_run_suppressed', {
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
            await tick(runMarker);
          }
        }
      }
    } finally {
      setTimeout(() => {
        scheduleLoop().catch((error) => {
          logger.error('bitable_export_schedule_loop_failed', {
            error: error instanceof Error ? error.message : String(error)
          });
        });
      }, SCHEDULE_POLL_MS);
    }
  };

  await scheduleLoop();
}

bootstrap().catch((error) => {
  logger.error('bitable_export_bootstrap_failed', {
    error: error instanceof Error ? error.message : String(error)
  });
  process.exit(1);
});
