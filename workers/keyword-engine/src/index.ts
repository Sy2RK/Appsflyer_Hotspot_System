import crypto from 'crypto';
import { env } from '@shared/config/env.js';
import { logger } from '@api/common/logger/logger.js';
import { runKeywordEngineCycle } from '@shared/utils/keywordEngine.js';
import { writeOperationLog } from '@shared/utils/operationLog.js';
import { getDefaultPullReadinessReportDate, isPullReportReadyForDownstream } from '@shared/utils/pullReadiness.js';
import { releaseJobLock, tryAcquireJobLock } from '@shared/utils/repositories.js';

let running = false;
let firstCycle = true;
const KEYWORD_ENGINE_JOB_LOCK = 'worker:keyword_engine:cycle';
const KEYWORD_ENGINE_JOB_LOCK_TTL_MS = 2 * 60 * 60 * 1000;

async function tick(): Promise<void> {
  if (running) {
    logger.warn('keyword_engine_skip_overlap');
    return;
  }

  running = true;
  let lockOwnerId = '';
  const backfillDays = firstCycle
    ? env.keywordEngineInitialBackfillDays
    : env.keywordEngineRollingBackfillDays;
  try {
    const reportDate = getDefaultPullReadinessReportDate();
    const readiness = await isPullReportReadyForDownstream(reportDate);
    if (!readiness.ready) {
      logger.info('keyword_engine_blocked_by_pull_gate', {
        report_date: reportDate,
        gate_status: readiness.status,
        reason: readiness.reason
      });
      await writeOperationLog(
        {
          source: 'worker.keyword_engine',
          action: 'scheduled_keyword_cycle',
          target_type: 'keyword_cycle',
          target_key: String(backfillDays),
          status: 'skipped',
          summary: `关键词生命周期等待 Pull 完成 ${reportDate}`,
          detail_json: {
            report_date: reportDate,
            gate_status: readiness.status,
            reason: readiness.reason
          }
        },
        logger
      );
      return;
    }

    lockOwnerId = crypto.randomUUID();
    const lockAcquired = await tryAcquireJobLock(KEYWORD_ENGINE_JOB_LOCK, lockOwnerId, KEYWORD_ENGINE_JOB_LOCK_TTL_MS);
    if (!lockAcquired) {
      logger.warn('keyword_engine_skip_distributed_overlap', {
        backfill_days: backfillDays
      });
      return;
    }
    const result = await runKeywordEngineCycle(backfillDays, logger);
    logger.info('keyword_engine_cycle_result', {
      backfill_days: result.backfill_days,
      success_count: result.success_count,
      failed_count: result.failed_count,
      skipped_count: result.skipped_count,
      duration_ms: result.duration_ms
    });
    await writeOperationLog(
      {
        source: 'worker.keyword_engine',
        action: 'scheduled_keyword_cycle',
        target_type: 'keyword_cycle',
        target_key: String(backfillDays),
        status: 'success',
        summary: `定时关键词生命周期重算完成，回算 ${backfillDays} 天`,
        detail_json: result
      },
      logger
    );
  } catch (error) {
    logger.error('keyword_engine_cycle_failed', {
      backfill_days: backfillDays,
      error: error instanceof Error ? error.message : String(error)
    });
    await writeOperationLog(
      {
        source: 'worker.keyword_engine',
        action: 'scheduled_keyword_cycle',
        target_type: 'keyword_cycle',
        target_key: String(backfillDays),
        status: 'failed',
        summary: `定时关键词生命周期重算失败，回算 ${backfillDays} 天`,
        detail_json: {
          backfill_days: backfillDays,
          error: error instanceof Error ? error.message : String(error)
        }
      },
      logger
    );
  } finally {
    if (lockOwnerId) {
      await releaseJobLock(KEYWORD_ENGINE_JOB_LOCK, lockOwnerId);
    }
    firstCycle = false;
    running = false;
  }
}

async function bootstrap(): Promise<void> {
  await tick();
  setInterval(() => {
    void tick();
  }, env.keywordEngineIntervalMs);
}

bootstrap().catch((error) => {
  logger.error('keyword_engine_bootstrap_failed', {
    error: error instanceof Error ? error.message : String(error)
  });
  process.exit(1);
});
