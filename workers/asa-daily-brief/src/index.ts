import crypto from 'crypto';
import { env } from '@shared/config/env.js';
import { logger } from '@api/common/logger/logger.js';
import { runScheduledAsaKeywordBrief } from '@shared/utils/asaKeywords.js';
import { writeOperationLog } from '@shared/utils/operationLog.js';
import { releaseJobLock, tryAcquireJobLock } from '@shared/utils/repositories.js';
import { getTzParts, hasReachedDailyTime, nextDailyTimeLocalString } from '@shared/utils/schedule.js';
import { getPushScheduleTarget } from '@shared/utils/runtimeSchedule.js';

let running = false;
let lastRunMarker = '';
let lastScheduleMarker = '';
const SCHEDULE_POLL_MS = 30 * 1000;
const ASA_DAILY_BRIEF_JOB_LOCK = 'worker:asa_daily_brief:tick';
const ASA_DAILY_BRIEF_JOB_LOCK_TTL_MS = 60 * 60 * 1000;

async function tick(): Promise<void> {
  if (running) {
    logger.warn('asa_daily_brief_skip_overlap');
    return;
  }

  running = true;
  let lockOwnerId = '';
  try {
    lockOwnerId = crypto.randomUUID();
    const lockAcquired = await tryAcquireJobLock(
      ASA_DAILY_BRIEF_JOB_LOCK,
      lockOwnerId,
      ASA_DAILY_BRIEF_JOB_LOCK_TTL_MS
    );
    if (!lockAcquired) {
      logger.warn('asa_daily_brief_skip_distributed_overlap');
      return;
    }
    await runScheduledAsaKeywordBrief(logger);
    await writeOperationLog(
      {
        source: 'worker.asa_daily_brief',
        action: 'scheduled_asa_daily_brief_tick',
        target_type: 'asa_daily_brief',
        target_key: 'runtime_push_time',
        status: 'success',
        summary: '定时 ASA 简报检查完成',
        detail_json: {}
      },
      logger
    );
  } catch (error) {
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
    if (lockOwnerId) {
      await releaseJobLock(ASA_DAILY_BRIEF_JOB_LOCK, lockOwnerId);
    }
    running = false;
  }
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

      if (hasReachedDailyTime(target.hour, target.minute, env.timezone, now) && lastRunMarker !== runMarker) {
        lastRunMarker = runMarker;
        await tick();
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
