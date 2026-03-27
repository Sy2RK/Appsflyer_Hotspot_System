import crypto from 'crypto';
import { env } from '@shared/config/env.js';
import { logger } from '@api/common/logger/logger.js';
import { runAsaKeywordCycle } from '@shared/utils/asaKeywords.js';
import { writeOperationLog } from '@shared/utils/operationLog.js';
import { getDefaultPullReadinessReportDate, isPullReportReadyForDownstream } from '@shared/utils/pullReadiness.js';
import { releaseJobLock, tryAcquireJobLock } from '@shared/utils/repositories.js';
import { getTzParts, hasReachedDailyTime, nextDailyTimeLocalString } from '@shared/utils/schedule.js';
import { getPullScheduleTarget } from '@shared/utils/runtimeSchedule.js';

let running = false;
let lastRunMarker = '';
let lastScheduleMarker = '';
const SCHEDULE_POLL_MS = 30 * 1000;
const ASA_KEYWORD_JOB_LOCK = 'worker:asa_keywords:cycle';
const ASA_KEYWORD_JOB_LOCK_TTL_MS = 3 * 60 * 60 * 1000;

async function tick(reportDate: string): Promise<boolean> {
  if (running) {
    logger.warn('asa_keyword_cycle_skip_overlap');
    return false;
  }
  running = true;
  let lockOwnerId = '';
  try {
    lockOwnerId = crypto.randomUUID();
    const lockAcquired = await tryAcquireJobLock(ASA_KEYWORD_JOB_LOCK, lockOwnerId, ASA_KEYWORD_JOB_LOCK_TTL_MS);
    if (!lockAcquired) {
      logger.warn('asa_keyword_cycle_skip_distributed_overlap');
      return false;
    }
    const result = await runAsaKeywordCycle(env.asaKeywordBackfillDays, logger);
    logger.info('asa_keyword_cycle_result', { report_date: reportDate, ...result });
    await writeOperationLog(
      {
        source: 'worker.asa_keywords',
        action: 'scheduled_asa_keyword_cycle',
        target_type: 'asa_keyword_cycle',
        target_key: reportDate,
        status: 'success',
        summary: `定时重算 ASA 关键词链路完成 ${reportDate}，回算 ${env.asaKeywordBackfillDays} 天`,
        detail_json: {
          report_date: reportDate,
          ...result
        }
      },
      logger
    );
    return true;
  } catch (error) {
    logger.error('asa_keyword_cycle_failed', {
      report_date: reportDate,
      error: error instanceof Error ? error.message : String(error)
    });
    await writeOperationLog(
      {
        source: 'worker.asa_keywords',
        action: 'scheduled_asa_keyword_cycle',
        target_type: 'asa_keyword_cycle',
        target_key: reportDate,
        status: 'failed',
        summary: `定时重算 ASA 关键词链路失败 ${reportDate}`,
        detail_json: {
          report_date: reportDate,
          error: error instanceof Error ? error.message : String(error)
        }
      },
      logger
    );
    return false;
  } finally {
    if (lockOwnerId) {
      await releaseJobLock(ASA_KEYWORD_JOB_LOCK, lockOwnerId);
    }
    running = false;
  }
}

async function bootstrap(): Promise<void> {
  if (env.asaKeywordRunOnBoot) {
    const now = new Date();
    const reportDate = getDefaultPullReadinessReportDate(now, env.timezone);
    const readiness = await isPullReportReadyForDownstream(reportDate);
    if (!readiness.ready) {
      logger.info('asa_keyword_cycle_blocked_by_pull_gate', {
        report_date: reportDate,
        gate_status: readiness.status,
        reason: readiness.reason
      });
    } else {
      const didRun = await tick(reportDate);
      const target = await getPullScheduleTarget();
      const parts = getTzParts(now, env.timezone);
      if (didRun) {
        lastRunMarker = `${parts.year}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}|${target.time}`;
      }
    }
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
        const reportDate = getDefaultPullReadinessReportDate(now, env.timezone);
        const readiness = await isPullReportReadyForDownstream(reportDate);
        if (!readiness.ready) {
          logger.info('asa_keyword_cycle_blocked_by_pull_gate', {
            report_date: reportDate,
            gate_status: readiness.status,
            reason: readiness.reason
          });
        } else {
          const didRun = await tick(reportDate);
          if (didRun) {
            lastRunMarker = runMarker;
          }
        }
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
