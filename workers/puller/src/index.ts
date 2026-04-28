import crypto from 'crypto';
import { env } from '@shared/config/env.js';
import { runPullCycle } from '@shared/utils/puller.js';
import { logger } from '@api/common/logger/logger.js';
import { startJobLockHeartbeat } from '@shared/utils/jobLockHeartbeat.js';
import { writeOperationLog } from '@shared/utils/operationLog.js';
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
let lastReconcileMarker = '';
const SCHEDULE_POLL_MS = 30 * 1000;
const RECONCILE_START_HOUR = 10;
const RECONCILE_END_HOUR = 18;
const RECONCILE_INTERVAL_MINUTES = 30;
const PULLER_WORKER_NAME = 'worker.puller';
const PULLER_JOB_LOCK = 'worker:puller:tick';
const PULLER_JOB_LOCK_TTL_MS = 5 * 60 * 1000;
const MAX_DAILY_RETRY_ATTEMPTS = 3;
const RETRY_COOLDOWN_MS = 15 * 60 * 1000;
const RETRY_POLICY = {
  max_attempts: MAX_DAILY_RETRY_ATTEMPTS,
  retry_cooldown_ms: RETRY_COOLDOWN_MS
} as const;

function summarizePullCycleStatus(result: { success_count: number; failed_count: number; skipped_count: number }): 'success' | 'failed' | 'info' | 'skipped' {
  if (result.success_count > 0 && result.failed_count === 0 && result.skipped_count === 0) {
    return 'success';
  }
  if (result.success_count === 0 && result.failed_count === 0 && result.skipped_count > 0) {
    return 'skipped';
  }
  if (result.success_count === 0 && result.failed_count > 0 && result.skipped_count === 0) {
    return 'failed';
  }
  return 'info';
}

function didPullCycleComplete(result: { retryable_failed_count?: number; failed_count: number }): boolean {
  const retryableFailedCount =
    typeof result.retryable_failed_count === 'number'
      ? result.retryable_failed_count
      : result.failed_count;
  return Number(retryableFailedCount) === 0;
}

function buildReconcileRunMarker(dateKey: string, hour: number, minute: number): string | null {
  if (hour < RECONCILE_START_HOUR || hour >= RECONCILE_END_HOUR) {
    return null;
  }
  const bucketMinute = Math.floor(minute / RECONCILE_INTERVAL_MINUTES) * RECONCILE_INTERVAL_MINUTES;
  if (minute !== bucketMinute) {
    return null;
  }
  return `${dateKey}|reconcile:${String(hour).padStart(2, '0')}:${String(bucketMinute).padStart(2, '0')}`;
}

async function tick(runMarker: string): Promise<boolean> {
  if (running) {
    logger.warn('puller_skip_overlap');
    return false;
  }

  running = true;
  const backfillDays = Math.max(1, Math.floor(env.pullerBackfillDays));
  let lockOwnerId = '';
  let stopLockHeartbeat: (() => void) | null = null;
  let attemptClaimed = false;
  let completed = false;
  let shouldExitAfterTimeout = false;

  try {
    lockOwnerId = crypto.randomUUID();
    const lockAcquired = await tryAcquireJobLock(PULLER_JOB_LOCK, lockOwnerId, PULLER_JOB_LOCK_TTL_MS);
    if (!lockAcquired) {
      logger.warn('puller_skip_distributed_overlap');
      return false;
    }
    stopLockHeartbeat = startJobLockHeartbeat({
      lockName: PULLER_JOB_LOCK,
      ownerId: lockOwnerId,
      ttlMs: PULLER_JOB_LOCK_TTL_MS,
      logger,
      logPrefix: 'puller'
    });
    const claimDecision = await tryClaimScheduledWorkerRunAttempt(PULLER_WORKER_NAME, runMarker, RETRY_POLICY);
    if (!claimDecision.allowed) {
      logger.info('puller_attempt_claim_skipped', {
        run_marker: runMarker,
        reason: claimDecision.reason,
        remaining_attempts: claimDecision.remaining_attempts,
        next_allowed_at: claimDecision.next_allowed_at
      });
      return false;
    }
    attemptClaimed = true;
    const result = await withScheduledWorkerTimeout(PULLER_WORKER_NAME, env.scheduledWorkerMaxRuntimeMs, () =>
      runPullCycle(backfillDays, logger)
    );
    completed = didPullCycleComplete(result);
    if (completed) {
      await completeScheduledWorkerRun(PULLER_WORKER_NAME, runMarker);
    } else {
      await failScheduledWorkerRun(PULLER_WORKER_NAME, runMarker, `pull_cycle_failed_count=${result.failed_count}`);
    }
    await writeOperationLog(
      {
        source: 'worker.puller',
        action: 'scheduled_pull_cycle',
        target_type: 'pull_cycle',
        target_key: String(backfillDays),
        status: summarizePullCycleStatus(result),
        summary: `定时 Pull 完成，回填 ${backfillDays} 天`,
        detail_json: {
          ...result,
          completed
        }
      },
      logger
    );
  } catch (error) {
    shouldExitAfterTimeout = isScheduledWorkerTimeoutError(error);
    if (attemptClaimed) {
      await failScheduledWorkerRun(
        PULLER_WORKER_NAME,
        runMarker,
        error instanceof Error ? error.message : String(error)
      );
    }
    logger.error('puller_cycle_failed', {
      backfill_days: backfillDays,
      error: error instanceof Error ? error.message : String(error)
    });
    await writeOperationLog(
      {
        source: 'worker.puller',
        action: 'scheduled_pull_cycle',
        target_type: 'pull_cycle',
        target_key: String(backfillDays),
        status: 'failed',
        summary: `定时 Pull 失败，回填 ${backfillDays} 天`,
        detail_json: {
          backfill_days: backfillDays,
          error: error instanceof Error ? error.message : String(error)
        }
      },
      logger
    );
  } finally {
    stopLockHeartbeat?.();
    if (lockOwnerId) {
      await releaseJobLock(PULLER_JOB_LOCK, lockOwnerId);
    }
    running = false;
    if (shouldExitAfterTimeout) {
      logger.error('puller_process_exit_after_timeout', {
        run_marker: runMarker,
        timeout_ms: env.scheduledWorkerMaxRuntimeMs
      });
      process.exit(1);
    }
  }

  return completed;
}

async function bootstrap(): Promise<void> {
  if (env.pullerRunOnBoot) {
    const target = await getPullScheduleTarget();
    const now = new Date();
    const parts = getTzParts(now, env.timezone);
    const runMarker = `${parts.year}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}|${target.time}`;
    const decision = await getScheduledWorkerRunDecision(PULLER_WORKER_NAME, runMarker, RETRY_POLICY, now);
    if (decision.allowed) {
      lastRetryBlockMarker = '';
      await tick(runMarker);
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
        logger.info('puller_next_scheduled', {
          timezone: env.timezone,
          report_time: target.time,
          next_run_local: nextDailyTimeLocalString(target.hour, target.minute, env.timezone, now)
        });
      }

      if (hasReachedDailyTime(target.hour, target.minute, env.timezone, now)) {
        const decision = await getScheduledWorkerRunDecision(PULLER_WORKER_NAME, runMarker, RETRY_POLICY, now);
        if (!decision.allowed) {
          const blockMarker = `${runMarker}|${decision.reason}|${decision.next_allowed_at || 'none'}`;
          if (lastRetryBlockMarker !== blockMarker) {
            lastRetryBlockMarker = blockMarker;
            logger.warn('puller_run_suppressed', {
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

	      const reconcileMarker = buildReconcileRunMarker(dateKey, parts.hour, parts.minute);
	      if (reconcileMarker && reconcileMarker !== lastReconcileMarker) {
	        lastReconcileMarker = reconcileMarker;
	        logger.info('puller_reconcile_started', {
	          run_marker: reconcileMarker,
	          backfill_days: Math.max(1, Math.floor(env.pullerBackfillDays))
	        });
	        await tick(reconcileMarker);
	      }
	    } finally {
      setTimeout(() => {
        scheduleLoop().catch((error) => {
          logger.error('puller_schedule_loop_failed', {
            error: error instanceof Error ? error.message : String(error)
          });
        });
      }, SCHEDULE_POLL_MS);
    }
  };

  await scheduleLoop();
}

bootstrap().catch((error) => {
  logger.error('puller_bootstrap_failed', {
    error: error instanceof Error ? error.message : String(error)
  });
  process.exit(1);
});
