import { env } from '@shared/config/env.js';
import { runScheduledDailyBrief } from '@shared/utils/dailyBrief.js';
import { logger } from '@api/common/logger/logger.js';
import { writeOperationLog } from '@shared/utils/operationLog.js';
import { getTzParts, hasReachedDailyTime, nextDailyTimeLocalString } from '@shared/utils/schedule.js';
import { getPushScheduleTarget } from '@shared/utils/runtimeSchedule.js';

let running = false;
let lastRunMarker = '';
let lastScheduleMarker = '';
const SCHEDULE_POLL_MS = 30 * 1000;

async function tick(): Promise<void> {
  if (running) {
    logger.warn('daily_brief_skip_overlap');
    return;
  }

  running = true;
  try {
    await runScheduledDailyBrief(logger);
    await writeOperationLog(
      {
        source: 'worker.daily_brief',
        action: 'scheduled_daily_brief_tick',
        target_type: 'daily_brief',
        target_key: 'runtime_push_time',
        status: 'success',
        summary: '定时每日报告检查完成',
        detail_json: {}
      },
      logger
    );
  } catch (error) {
    logger.error('daily_brief_cycle_failed', {
      error: error instanceof Error ? error.message : String(error)
    });
    await writeOperationLog(
      {
        source: 'worker.daily_brief',
        action: 'scheduled_daily_brief_tick',
        target_type: 'daily_brief',
        target_key: 'runtime_push_time',
        status: 'failed',
        summary: '定时每日报告检查失败',
        detail_json: {
          error: error instanceof Error ? error.message : String(error)
        }
      },
      logger
    );
  } finally {
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
        logger.info('daily_brief_next_scheduled', {
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
          logger.error('daily_brief_schedule_loop_failed', {
            error: error instanceof Error ? error.message : String(error)
          });
        });
      }, SCHEDULE_POLL_MS);
    }
  };

  await scheduleLoop();
}

bootstrap().catch((error) => {
  logger.error('daily_brief_bootstrap_failed', {
    error: error instanceof Error ? error.message : String(error)
  });
  process.exit(1);
});
