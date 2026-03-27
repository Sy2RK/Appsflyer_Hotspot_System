import crypto from 'crypto';
import { env } from '@shared/config/env.js';
import { logger } from '@api/common/logger/logger.js';
import { runBudgetAdvisorCycle } from '@shared/utils/budgetAdvisor.js';
import { writeOperationLog } from '@shared/utils/operationLog.js';
import { getDefaultPullReadinessReportDate, isPullReportReadyForDownstream } from '@shared/utils/pullReadiness.js';
import { releaseJobLock, tryAcquireJobLock } from '@shared/utils/repositories.js';
import { getTzParts, hasReachedDailyTime, nextDailyTimeLocalString } from '@shared/utils/schedule.js';
import { getPullScheduleTarget } from '@shared/utils/runtimeSchedule.js';

let running = false;
let lastRunMarker = '';
let lastScheduleMarker = '';
const SCHEDULE_POLL_MS = 30 * 1000;
const BUDGET_ADVISOR_JOB_LOCK = 'worker:budget_advisor:cycle';
const BUDGET_ADVISOR_JOB_LOCK_TTL_MS = 2 * 60 * 60 * 1000;

async function tick(reportDate: string): Promise<boolean> {
  if (running) {
    logger.warn('budget_advisor_skip_overlap');
    return false;
  }
  running = true;
  let lockOwnerId = '';
  try {
    const readiness = await isPullReportReadyForDownstream(reportDate);
    if (!readiness.ready) {
      logger.info('budget_advisor_blocked_by_pull_gate', {
        report_date: reportDate,
        gate_status: readiness.status,
        reason: readiness.reason
      });
      await writeOperationLog(
        {
          source: 'worker.budget_advisor',
          action: 'scheduled_budget_cycle',
          target_type: 'budget_cycle',
          target_key: '',
          status: 'skipped',
          summary: `预算建议等待 Pull 完成 ${reportDate}`,
          detail_json: {
            report_date: reportDate,
            gate_status: readiness.status,
            reason: readiness.reason
          }
        },
        logger
      );
      return false;
    }

    lockOwnerId = crypto.randomUUID();
    const lockAcquired = await tryAcquireJobLock(BUDGET_ADVISOR_JOB_LOCK, lockOwnerId, BUDGET_ADVISOR_JOB_LOCK_TTL_MS);
    if (!lockAcquired) {
      logger.warn('budget_advisor_skip_distributed_overlap');
      return false;
    }
    const result = await runBudgetAdvisorCycle(env.budgetAdvisorLookbackDays, logger);
    logger.info('budget_advisor_cycle_result', {
      report_date: reportDate,
      generated_total: result.generated_total,
      success_count: result.success_count,
      failed_count: result.failed_count,
      skipped_count: result.skipped_count,
      duration_ms: result.duration_ms
    });
    await writeOperationLog(
      {
        source: 'worker.budget_advisor',
        action: 'scheduled_budget_cycle',
        target_type: 'budget_cycle',
        target_key: reportDate,
        status: 'success',
        summary: `定时预算建议生成完成 ${reportDate}，回看 ${env.budgetAdvisorLookbackDays} 天`,
        detail_json: {
          report_date: reportDate,
          ...result
        }
      },
      logger
    );
    return true;
  } catch (error) {
    logger.error('budget_advisor_cycle_failed', {
      report_date: reportDate,
      error: error instanceof Error ? error.message : String(error)
    });
    await writeOperationLog(
      {
        source: 'worker.budget_advisor',
        action: 'scheduled_budget_cycle',
        target_type: 'budget_cycle',
        target_key: reportDate,
        status: 'failed',
        summary: `定时预算建议生成失败 ${reportDate}，回看 ${env.budgetAdvisorLookbackDays} 天`,
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
      await releaseJobLock(BUDGET_ADVISOR_JOB_LOCK, lockOwnerId);
    }
    running = false;
  }
}

async function bootstrap(): Promise<void> {
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
        logger.info('budget_advisor_next_scheduled', {
          timezone: env.timezone,
          report_time: target.time,
          next_run_local: nextDailyTimeLocalString(target.hour, target.minute, env.timezone, now)
        });
      }

      if (hasReachedDailyTime(target.hour, target.minute, env.timezone, now) && lastRunMarker !== runMarker) {
        const reportDate = getDefaultPullReadinessReportDate(now, env.timezone);
        const didRun = await tick(reportDate);
        if (didRun) {
          lastRunMarker = runMarker;
        }
      }
    } finally {
      setTimeout(() => {
        scheduleLoop().catch((error) => {
          logger.error('budget_advisor_schedule_loop_failed', {
            error: error instanceof Error ? error.message : String(error)
          });
        });
      }, SCHEDULE_POLL_MS);
    }
  };

  await scheduleLoop();
}

bootstrap().catch((error) => {
  logger.error('budget_advisor_bootstrap_failed', {
    error: error instanceof Error ? error.message : String(error)
  });
  process.exit(1);
});
