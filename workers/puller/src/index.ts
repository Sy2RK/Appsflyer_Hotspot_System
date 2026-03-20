import { env } from '@shared/config/env.js';
import { runPullCycle } from '@shared/utils/puller.js';
import { logger } from '@api/common/logger/logger.js';
import { writeOperationLog } from '@shared/utils/operationLog.js';
import { getTzParts, hasReachedDailyTime, nextDailyTimeLocalString } from '@shared/utils/schedule.js';
import { getPullScheduleTarget } from '@shared/utils/runtimeSchedule.js';

let running = false;
let firstCycle = true;
let lastRunMarker = '';
let lastScheduleMarker = '';
const SCHEDULE_POLL_MS = 30 * 1000;

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

async function tick(): Promise<void> {
  if (running) {
    logger.warn('puller_skip_overlap');
    return;
  }

  running = true;
  const backfillDays = firstCycle ? env.pullerBackfillDays : 1;

  try {
    const result = await runPullCycle(backfillDays, logger);
    await writeOperationLog(
      {
        source: 'worker.puller',
        action: 'scheduled_pull_cycle',
        target_type: 'pull_cycle',
        target_key: String(backfillDays),
        status: summarizePullCycleStatus(result),
        summary: `定时 Pull 完成，回填 ${backfillDays} 天`,
        detail_json: result
      },
      logger
    );
  } catch (error) {
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
    firstCycle = false;
    running = false;
  }
}

async function bootstrap(): Promise<void> {
  if (env.pullerRunOnBoot) {
    await tick();
    const target = await getPullScheduleTarget();
    const parts = getTzParts(new Date(), env.timezone);
    lastRunMarker = `${parts.year}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}|${target.time}`;
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

      if (hasReachedDailyTime(target.hour, target.minute, env.timezone, now) && lastRunMarker !== runMarker) {
        lastRunMarker = runMarker;
        await tick();
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
