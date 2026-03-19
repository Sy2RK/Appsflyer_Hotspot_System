import { env } from '@shared/config/env.js';
import { runPullCycle } from '@shared/utils/puller.js';
import { logger } from '@api/common/logger/logger.js';
import { writeOperationLog } from '@shared/utils/operationLog.js';
import { hasReachedDailyHour, msUntilNextDailyHour, nextDailyHourLocalString } from '@shared/utils/schedule.js';

let running = false;
let firstCycle = true;

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
  } else if (hasReachedDailyHour(env.pullerReportHour, env.timezone)) {
    await tick();
  } else {
    logger.info('puller_skip_boot_cycle', {
      run_on_boot: false,
      report_hour: env.pullerReportHour
    });
  }

  const scheduleNext = (): void => {
    const delay = msUntilNextDailyHour(env.pullerReportHour, env.timezone);
    logger.info('puller_next_scheduled', {
      timezone: env.timezone,
      report_hour: env.pullerReportHour,
      delay_ms: delay,
      next_run_local: nextDailyHourLocalString(env.pullerReportHour, env.timezone)
    });
    setTimeout(async () => {
      try {
        await tick();
      } finally {
        scheduleNext();
      }
    }, delay);
  };

  scheduleNext();
}

bootstrap().catch((error) => {
  logger.error('puller_bootstrap_failed', {
    error: error instanceof Error ? error.message : String(error)
  });
  process.exit(1);
});
