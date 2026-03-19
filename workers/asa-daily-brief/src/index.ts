import { env } from '@shared/config/env.js';
import { logger } from '@api/common/logger/logger.js';
import { runScheduledAsaKeywordBrief } from '@shared/utils/asaKeywords.js';
import { writeOperationLog } from '@shared/utils/operationLog.js';
import { hasReachedDailyHour, msUntilNextDailyHour, nextDailyHourLocalString } from '@shared/utils/schedule.js';

let running = false;

async function tick(): Promise<void> {
  if (running) {
    logger.warn('asa_daily_brief_skip_overlap');
    return;
  }

  running = true;
  try {
    await runScheduledAsaKeywordBrief(logger);
    await writeOperationLog(
      {
        source: 'worker.asa_daily_brief',
        action: 'scheduled_asa_daily_brief_tick',
        target_type: 'asa_daily_brief',
        target_key: String(env.asaDailyBriefReportHour),
        status: 'success',
        summary: '定时 ASA 简报检查完成',
        detail_json: {
          report_hour: env.asaDailyBriefReportHour
        }
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
        target_key: String(env.asaDailyBriefReportHour),
        status: 'failed',
        summary: '定时 ASA 简报检查失败',
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
  if (hasReachedDailyHour(env.asaDailyBriefReportHour, env.timezone)) {
    await tick();
  } else {
    logger.info('asa_daily_brief_wait_until_window', {
      timezone: env.timezone,
      report_hour: env.asaDailyBriefReportHour
    });
  }

  const scheduleNext = (): void => {
    const delay = msUntilNextDailyHour(env.asaDailyBriefReportHour, env.timezone);
    logger.info('asa_daily_brief_next_scheduled', {
      timezone: env.timezone,
      report_hour: env.asaDailyBriefReportHour,
      delay_ms: delay,
      next_run_local: nextDailyHourLocalString(env.asaDailyBriefReportHour, env.timezone)
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
  logger.error('asa_daily_brief_bootstrap_failed', {
    error: error instanceof Error ? error.message : String(error)
  });
  process.exit(1);
});
