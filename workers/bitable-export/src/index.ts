import { logger } from '@api/common/logger/logger.js';
import { env } from '@shared/config/env.js';
import { runScheduledBitableExports } from '@shared/utils/bitableExport.js';
import { writeOperationLog } from '@shared/utils/operationLog.js';
import {
  hasReachedDailyTime,
  msUntilNextDailyTime,
  nextDailyTimeLocalString
} from '@shared/utils/schedule.js';

let running = false;

async function tick(): Promise<void> {
  if (running) {
    logger.warn('bitable_export_skip_overlap');
    return;
  }

  running = true;
  try {
    const results = await runScheduledBitableExports(logger);
    await writeOperationLog(
      {
        source: 'worker.bitable_export',
        action: 'scheduled_bitable_export_tick',
        target_type: 'bitable_export',
        target_key: `${env.feishuBitableScheduleHour}:${env.feishuBitableScheduleMinute}`,
        status: 'success',
        summary: '定时多维表格导出检查完成',
        detail_json: {
          report_hour: env.feishuBitableScheduleHour,
          report_minute: env.feishuBitableScheduleMinute,
          result_count: results.length
        }
      },
      logger
    );
  } catch (error) {
    logger.error('bitable_export_cycle_failed', {
      error: error instanceof Error ? error.message : String(error)
    });
    await writeOperationLog(
      {
        source: 'worker.bitable_export',
        action: 'scheduled_bitable_export_tick',
        target_type: 'bitable_export',
        target_key: `${env.feishuBitableScheduleHour}:${env.feishuBitableScheduleMinute}`,
        status: 'failed',
        summary: '定时多维表格导出检查失败',
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
  if (
    hasReachedDailyTime(
      env.feishuBitableScheduleHour,
      env.feishuBitableScheduleMinute,
      env.timezone
    )
  ) {
    await tick();
  } else {
    logger.info('bitable_export_wait_until_window', {
      timezone: env.timezone,
      report_hour: env.feishuBitableScheduleHour,
      report_minute: env.feishuBitableScheduleMinute
    });
  }

  const scheduleNext = (): void => {
    const delay = msUntilNextDailyTime(
      env.feishuBitableScheduleHour,
      env.feishuBitableScheduleMinute,
      env.timezone
    );
    logger.info('bitable_export_next_scheduled', {
      timezone: env.timezone,
      report_hour: env.feishuBitableScheduleHour,
      report_minute: env.feishuBitableScheduleMinute,
      delay_ms: delay,
      next_run_local: nextDailyTimeLocalString(
        env.feishuBitableScheduleHour,
        env.feishuBitableScheduleMinute,
        env.timezone
      )
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
  logger.error('bitable_export_bootstrap_failed', {
    error: error instanceof Error ? error.message : String(error)
  });
  process.exit(1);
});
