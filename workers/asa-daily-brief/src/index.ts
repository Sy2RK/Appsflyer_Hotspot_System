import crypto from 'crypto';
import { env } from '@shared/config/env.js';
import { logger } from '@api/common/logger/logger.js';
import { startJobLockHeartbeat } from '@shared/utils/jobLockHeartbeat.js';
import { runScheduledAsaKeywordBrief } from '@shared/utils/asaKeywords.js';
import { writeOperationLog } from '@shared/utils/operationLog.js';
import {
  getDefaultPullReadinessReportDate,
  isDownstreamReadyForAutomation,
  isPullReportReadyForDownstream
} from '@shared/utils/pullReadiness.js';
import { releaseJobLock, tryAcquireJobLock } from '@shared/utils/repositories.js';
import { getTzParts, hasReachedDailyTime, nextDailyTimeLocalString } from '@shared/utils/schedule.js';
import { isScheduledWorkerTimeoutError, withScheduledWorkerTimeout } from '@shared/utils/scheduledWorkerTimeout.js';
import {
  completeScheduledWorkerRun,
  failScheduledWorkerRun,
  getScheduledWorkerRunDecision,
  tryClaimScheduledWorkerRunAttempt
} from '@shared/utils/scheduledWorkerRun.js';
import { getPushScheduleTarget } from '@shared/utils/runtimeSchedule.js';

let running = false;
let lastScheduleMarker = '';
let lastRetryBlockMarker = '';
const SCHEDULE_POLL_MS = 30 * 1000;
const ASA_DAILY_BRIEF_WORKER_NAME = 'worker.asa_daily_brief';
const ASA_DAILY_BRIEF_JOB_LOCK = 'worker:asa_daily_brief:tick';
const ASA_DAILY_BRIEF_JOB_LOCK_TTL_MS = 5 * 60 * 1000;
const MAX_DAILY_RETRY_ATTEMPTS = 3;
const RETRY_COOLDOWN_MS = 15 * 60 * 1000;
const RETRY_POLICY = {
  max_attempts: MAX_DAILY_RETRY_ATTEMPTS,
  retry_cooldown_ms: RETRY_COOLDOWN_MS
} as const;

async function tick(runMarker: string): Promise<boolean> {
  if (running) {
    logger.warn('asa_daily_brief_skip_overlap');
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
      ASA_DAILY_BRIEF_JOB_LOCK,
      lockOwnerId,
      ASA_DAILY_BRIEF_JOB_LOCK_TTL_MS
    );
    if (!lockAcquired) {
      logger.warn('asa_daily_brief_skip_distributed_overlap');
      return false;
    }
    stopLockHeartbeat = startJobLockHeartbeat({
      lockName: ASA_DAILY_BRIEF_JOB_LOCK,
      ownerId: lockOwnerId,
      ttlMs: ASA_DAILY_BRIEF_JOB_LOCK_TTL_MS,
      logger,
      logPrefix: 'asa_daily_brief'
    });
    const claimDecision = await tryClaimScheduledWorkerRunAttempt(
      ASA_DAILY_BRIEF_WORKER_NAME,
      runMarker,
      RETRY_POLICY
    );
    if (!claimDecision.allowed) {
      logger.info('asa_daily_brief_attempt_claim_skipped', {
        run_marker: runMarker,
        reason: claimDecision.reason,
        remaining_attempts: claimDecision.remaining_attempts,
        next_allowed_at: claimDecision.next_allowed_at
      });
      return false;
    }
    attemptClaimed = true;
    const result = await withScheduledWorkerTimeout(
      ASA_DAILY_BRIEF_WORKER_NAME,
      env.scheduledWorkerMaxRuntimeMs,
      () => runScheduledAsaKeywordBrief(logger)
    );
    completed = result.completed;
    if (completed) {
      await completeScheduledWorkerRun(ASA_DAILY_BRIEF_WORKER_NAME, runMarker);
    } else {
      await failScheduledWorkerRun(
        ASA_DAILY_BRIEF_WORKER_NAME,
        runMarker,
        `asa_daily_brief_failed_count=${result.failed_count}`
      );
    }
    await writeOperationLog(
      {
        source: 'worker.asa_daily_brief',
        action: 'scheduled_asa_daily_brief_tick',
        target_type: 'asa_daily_brief',
        target_key: 'runtime_push_time',
        status: completed ? 'success' : 'failed',
        summary: completed ? '定时 ASA 简报检查完成' : '定时 ASA 简报检查未完成',
        detail_json: result
      },
      logger
    );
  } catch (error) {
    shouldExitAfterTimeout = isScheduledWorkerTimeoutError(error);
    if (attemptClaimed) {
      await failScheduledWorkerRun(
        ASA_DAILY_BRIEF_WORKER_NAME,
        runMarker,
        error instanceof Error ? error.message : String(error)
      );
    }
    logger.error('asa_daily_brief_tick_failed', {
      error: error instanceof Error ? error.message : String(error)
    });
    await writeOperationLog(
      {
        source: 'worker.asa_daily_brief',
        action: 'scheduled_asa_daily_brief_tick',
        target_type: 'asa_daily_brief',
        target_key: 'runtime_push_time',
        status: 'failed',
        summary: '定时 ASA 简报检查失败',
        detail_json: {
          error: error instanceof Error ? error.message : String(error)
        }
      },
      logger
    );
  } finally {
    stopLockHeartbeat?.();
    if (lockOwnerId) {
      await releaseJobLock(ASA_DAILY_BRIEF_JOB_LOCK, lockOwnerId);
    }
    running = false;
    if (shouldExitAfterTimeout) {
      logger.error('asa_daily_brief_process_exit_after_timeout', {
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
      const target = await getPushScheduleTarget();
      const now = new Date();
      const parts = getTzParts(now, env.timezone);
      const dateKey = `${parts.year}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`;
      const runMarker = `${dateKey}|${target.time}`;
      const scheduleMarker = `${runMarker}|${nextDailyTimeLocalString(target.hour, target.minute, env.timezone, now)}`;

      if (scheduleMarker !== lastScheduleMarker) {
        lastScheduleMarker = scheduleMarker;
        logger.info('asa_daily_brief_next_scheduled', {
          timezone: env.timezone,
          report_time: target.time,
          next_run_local: nextDailyTimeLocalString(target.hour, target.minute, env.timezone, now)
        });
      }

      if (hasReachedDailyTime(target.hour, target.minute, env.timezone, now)) {
        const reportDate = getDefaultPullReadinessReportDate(now, env.timezone);
        const readiness = await isPullReportReadyForDownstream(reportDate);
        if (!readiness.ready) {
          logger.info('asa_daily_brief_blocked_by_pull_gate', {
            report_date: reportDate,
            gate_status: readiness.status,
            reason: readiness.reason
          });
        } else {
          const downstreamGate = await isDownstreamReadyForAutomation(reportDate);
          if (!downstreamGate.ready) {
            logger.info('asa_daily_brief_blocked_by_downstream_gate', {
              report_date: reportDate,
              reason: downstreamGate.reason,
              budget_advisor: downstreamGate.budget_advisor,
              asa_keywords: downstreamGate.asa_keywords
            });
          } else {
            const decision = await getScheduledWorkerRunDecision(
              ASA_DAILY_BRIEF_WORKER_NAME,
              runMarker,
              RETRY_POLICY,
              now
            );
            if (!decision.allowed) {
              const blockMarker = `${runMarker}|${decision.reason}|${decision.next_allowed_at || 'none'}`;
              if (lastRetryBlockMarker !== blockMarker) {
                lastRetryBlockMarker = blockMarker;
                logger.warn('asa_daily_brief_run_suppressed', {
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
          logger.error('asa_daily_brief_schedule_loop_failed', {
            error: error instanceof Error ? error.message : String(error)
          });
        });
      }, SCHEDULE_POLL_MS);
    }
  };

  await scheduleLoop();
}

bootstrap().catch((error) => {
  logger.error('asa_daily_brief_bootstrap_failed', {
    error: error instanceof Error ? error.message : String(error)
  });
  process.exit(1);
});
