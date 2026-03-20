import { logger } from '@api/common/logger/logger.js';
import { env } from '@shared/config/env.js';
import { runScheduledBitableExports } from '@shared/utils/bitableExport.js';
import { writeOperationLog } from '@shared/utils/operationLog.js';
import {
  getTzParts,
  hasReachedDailyTime,
  nextDailyTimeLocalString
} from '@shared/utils/schedule.js';
import { getBitableScheduleTarget } from '@shared/utils/runtimeSchedule.js';

let running = false;
let lastRunMarker = '';
let lastScheduleMarker = '';
const SCHEDULE_POLL_MS = 30 * 1000;

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
        target_key: 'runtime_push_time_plus_5m',
        status: 'success',
        summary: '定时多维表格导出检查完成',
        detail_json: {
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
        target_key: 'runtime_push_time_plus_5m',
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
  const scheduleLoop = async (): Promise<void> => {
    try {
      const target = await getBitableScheduleTarget();
      const now = new Date();
      const parts = getTzParts(now, env.timezone);
      const dateKey = `${parts.year}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`;
      const runMarker = `${dateKey}|${target.time}`;
      const scheduleMarker = `${runMarker}|${nextDailyTimeLocalString(target.hour, target.minute, env.timezone, now)}`;

      if (scheduleMarker !== lastScheduleMarker) {
        lastScheduleMarker = scheduleMarker;
        logger.info('bitable_export_next_scheduled', {
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
          logger.error('bitable_export_schedule_loop_failed', {
            error: error instanceof Error ? error.message : String(error)
          });
        });
      }, SCHEDULE_POLL_MS);
    }
  };

  await scheduleLoop();
}

bootstrap().catch((error) => {
  logger.error('bitable_export_bootstrap_failed', {
    error: error instanceof Error ? error.message : String(error)
  });
  process.exit(1);
});
