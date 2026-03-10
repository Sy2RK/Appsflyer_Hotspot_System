import { env } from '@shared/config/env.js';
import { runScheduledDailyBrief } from '@shared/utils/dailyBrief.js';
import { logger } from '@api/common/logger/logger.js';
import { writeOperationLog } from '@shared/utils/operationLog.js';

let running = false;

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
        target_key: String(env.dailyBriefReportHour),
        status: 'success',
        summary: '定时每日报告检查完成',
        detail_json: {
          report_hour: env.dailyBriefReportHour
        }
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
        target_key: String(env.dailyBriefReportHour),
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
  await tick();
  setInterval(() => {
    void tick();
  }, env.dailyBriefIntervalMs);
}

bootstrap().catch((error) => {
  logger.error('daily_brief_bootstrap_failed', {
    error: error instanceof Error ? error.message : String(error)
  });
  process.exit(1);
});
