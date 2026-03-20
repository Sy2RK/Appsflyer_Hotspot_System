import { env } from '@shared/config/env.js';
import { logger } from '@api/common/logger/logger.js';
import { runAsaKeywordCycle } from '@shared/utils/asaKeywords.js';
import { writeOperationLog } from '@shared/utils/operationLog.js';
import { getTzParts, hasReachedDailyTime, nextDailyTimeLocalString } from '@shared/utils/schedule.js';
import { getPullScheduleTarget } from '@shared/utils/runtimeSchedule.js';

let running = false;
let lastRunMarker = '';
let lastScheduleMarker = '';
const SCHEDULE_POLL_MS = 30 * 1000;

async function tick(): Promise<void> {
  if (running) {
    logger.warn('asa_keyword_cycle_skip_overlap');
    return;
  }
  running = true;
  try {
    const result = await runAsaKeywordCycle(env.asaKeywordBackfillDays, logger);
    logger.info('asa_keyword_cycle_result', { ...result });
    await writeOperationLog(
      {
        source: 'worker.asa_keywords',
        action: 'scheduled_asa_keyword_cycle',
        target_type: 'asa_keyword_cycle',
        target_key: 'runtime_pull_time',
        status: 'success',
        summary: `定时重算 ASA 关键词链路完成，回算 ${env.asaKeywordBackfillDays} 天`,
        detail_json: {
          ...result
        }
      },
      logger
    );
  } catch (error) {
    logger.error('asa_keyword_cycle_failed', {
      error: error instanceof Error ? error.message : String(error)
    });
    await writeOperationLog(
      {
        source: 'worker.asa_keywords',
        action: 'scheduled_asa_keyword_cycle',
        target_type: 'asa_keyword_cycle',
        target_key: 'runtime_pull_time',
        status: 'failed',
        summary: '定时重算 ASA 关键词链路失败',
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
  if (env.asaKeywordRunOnBoot) {
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
        logger.info('asa_keyword_next_scheduled', {
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
          logger.error('asa_keyword_schedule_loop_failed', {
            error: error instanceof Error ? error.message : String(error)
          });
        });
      }, SCHEDULE_POLL_MS);
    }
  };

  await scheduleLoop();
}

bootstrap().catch((error) => {
  logger.error('asa_keyword_bootstrap_failed', {
    error: error instanceof Error ? error.message : String(error)
  });
  process.exit(1);
});
