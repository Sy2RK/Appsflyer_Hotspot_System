import crypto from 'crypto';
import { env } from '@shared/config/env.js';
import { logger } from '@api/common/logger/logger.js';
import { runKeywordEngineCycle } from '@shared/utils/keywordEngine.js';
import { writeOperationLog } from '@shared/utils/operationLog.js';
import { getDefaultPullReadinessReportDate, isPullReportReadyForDownstream } from '@shared/utils/pullReadiness.js';
import { releaseJobLock, tryAcquireJobLock } from '@shared/utils/repositories.js';
import { getTzParts, hasReachedDailyTime, nextDailyTimeLocalString } from '@shared/utils/schedule.js';
import {
  completeScheduledWorkerRun,
  failScheduledWorkerRun,
  getScheduledWorkerRunDecision,
  hasScheduledWorkerCompletedAnyRun,
  tryClaimScheduledWorkerRunAttempt
} from '@shared/utils/scheduledWorkerRun.js';
import {
  didKeywordEngineCycleComplete,
  resolveKeywordEngineBackfillDays
} from '@shared/utils/keywordEngineWorkerPolicy.js';
import { getPullScheduleTarget } from '@shared/utils/runtimeSchedule.js';

let running = false;
let lastScheduleMarker = '';
let lastRetryBlockMarker = '';
const SCHEDULE_POLL_MS = 30 * 1000;
const KEYWORD_ENGINE_WORKER_NAME = 'worker.keyword_engine';
const KEYWORD_ENGINE_JOB_LOCK = 'worker:keyword_engine:cycle';
const KEYWORD_ENGINE_JOB_LOCK_TTL_MS = 2 * 60 * 60 * 1000;
const MAX_DAILY_RETRY_ATTEMPTS = 3;
const RETRY_COOLDOWN_MS = 15 * 60 * 1000;
const RETRY_POLICY = {
  max_attempts: MAX_DAILY_RETRY_ATTEMPTS,
  retry_cooldown_ms: RETRY_COOLDOWN_MS
} as const;

async function tick(reportDate: string, runMarker: string): Promise<boolean> {
  if (running) {
    logger.warn('keyword_engine_skip_overlap');
    return false;
  }

  running = true;
  let lockOwnerId = '';
  let attemptClaimed = false;
  let backfillDays = env.keywordEngineRollingBackfillDays;
  try {
    const readiness = await isPullReportReadyForDownstream(reportDate);
    if (!readiness.ready) {
      logger.info('keyword_engine_blocked_by_pull_gate', {
        report_date: reportDate,
        gate_status: readiness.status,
        reason: readiness.reason
      });
      await writeOperationLog(
        {
          source: 'worker.keyword_engine',
          action: 'scheduled_keyword_cycle',
          target_type: 'keyword_cycle',
          target_key: reportDate,
          status: 'skipped',
          summary: `关键词生命周期等待 Pull 完成 ${reportDate}`,
          detail_json: {
            report_date: reportDate,
            gate_status: readiness.status,
            reason: readiness.reason
          }
        },
        logger
      );
      return false;
    }

    lockOwnerId = crypto.randomUUID();
    const lockAcquired = await tryAcquireJobLock(KEYWORD_ENGINE_JOB_LOCK, lockOwnerId, KEYWORD_ENGINE_JOB_LOCK_TTL_MS);
    if (!lockAcquired) {
      logger.warn('keyword_engine_skip_distributed_overlap');
      return false;
    }

    const claimDecision = await tryClaimScheduledWorkerRunAttempt(KEYWORD_ENGINE_WORKER_NAME, runMarker, RETRY_POLICY);
    if (!claimDecision.allowed) {
      logger.info('keyword_engine_attempt_claim_skipped', {
        report_date: reportDate,
        run_marker: runMarker,
        reason: claimDecision.reason,
        remaining_attempts: claimDecision.remaining_attempts,
        next_allowed_at: claimDecision.next_allowed_at
      });
      return false;
    }
    attemptClaimed = true;

    const hasCompletedRun = await hasScheduledWorkerCompletedAnyRun(KEYWORD_ENGINE_WORKER_NAME);
    backfillDays = resolveKeywordEngineBackfillDays(
      hasCompletedRun,
      env.keywordEngineInitialBackfillDays,
      env.keywordEngineRollingBackfillDays
    );
    const result = await runKeywordEngineCycle(backfillDays, logger);
    const completed = didKeywordEngineCycleComplete(result);

    if (completed) {
      await completeScheduledWorkerRun(KEYWORD_ENGINE_WORKER_NAME, runMarker);
    } else {
      await failScheduledWorkerRun(
        KEYWORD_ENGINE_WORKER_NAME,
        runMarker,
        `keyword_engine_failed_count=${result.failed_count}`
      );
    }

    logger.info('keyword_engine_cycle_result', {
      report_date: reportDate,
      backfill_days: result.backfill_days,
      success_count: result.success_count,
      failed_count: result.failed_count,
      skipped_count: result.skipped_count,
      duration_ms: result.duration_ms
    });
    await writeOperationLog(
      {
        source: 'worker.keyword_engine',
        action: 'scheduled_keyword_cycle',
        target_type: 'keyword_cycle',
        target_key: reportDate,
        status: completed ? 'success' : 'failed',
        summary: completed
          ? `定时关键词生命周期重算完成 ${reportDate}，回算 ${backfillDays} 天`
          : `定时关键词生命周期重算未完全完成 ${reportDate}，回算 ${backfillDays} 天`,
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
    if (attemptClaimed) {
      await failScheduledWorkerRun(
        KEYWORD_ENGINE_WORKER_NAME,
        runMarker,
        error instanceof Error ? error.message : String(error)
      );
    }
    logger.error('keyword_engine_cycle_failed', {
      report_date: reportDate,
      backfill_days: backfillDays,
      error: error instanceof Error ? error.message : String(error)
    });
    await writeOperationLog(
      {
        source: 'worker.keyword_engine',
        action: 'scheduled_keyword_cycle',
        target_type: 'keyword_cycle',
        target_key: reportDate,
        status: 'failed',
        summary: `定时关键词生命周期重算失败 ${reportDate}，回算 ${backfillDays} 天`,
        detail_json: {
          report_date: reportDate,
          backfill_days: backfillDays,
          error: error instanceof Error ? error.message : String(error)
        }
      },
      logger
    );
    return false;
  } finally {
    if (lockOwnerId) {
      await releaseJobLock(KEYWORD_ENGINE_JOB_LOCK, lockOwnerId);
    }
    running = false;
  }
}

async function bootstrap(): Promise<void> {
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
        logger.info('keyword_engine_next_scheduled', {
          timezone: env.timezone,
          report_time: target.time,
          next_run_local: nextDailyTimeLocalString(target.hour, target.minute, env.timezone, now)
        });
      }

      if (hasReachedDailyTime(target.hour, target.minute, env.timezone, now)) {
        const reportDate = getDefaultPullReadinessReportDate(now, env.timezone);
        const decision = await getScheduledWorkerRunDecision(KEYWORD_ENGINE_WORKER_NAME, runMarker, RETRY_POLICY, now);
        if (!decision.allowed) {
          const blockMarker = `${runMarker}|${decision.reason}|${decision.next_allowed_at || 'none'}`;
          if (lastRetryBlockMarker !== blockMarker) {
            lastRetryBlockMarker = blockMarker;
            logger.warn('keyword_engine_run_suppressed', {
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
    } finally {
      setTimeout(() => {
        scheduleLoop().catch((error) => {
          logger.error('keyword_engine_schedule_loop_failed', {
            error: error instanceof Error ? error.message : String(error)
          });
        });
      }, SCHEDULE_POLL_MS);
    }
  };

  await scheduleLoop();
}

bootstrap().catch((error) => {
  logger.error('keyword_engine_bootstrap_failed', {
    error: error instanceof Error ? error.message : String(error)
  });
  process.exit(1);
});
