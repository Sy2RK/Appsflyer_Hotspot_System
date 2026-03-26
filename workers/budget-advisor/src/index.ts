import crypto from 'crypto';
import { env } from '@shared/config/env.js';
import { logger } from '@api/common/logger/logger.js';
import { runBudgetAdvisorCycle } from '@shared/utils/budgetAdvisor.js';
import { writeOperationLog } from '@shared/utils/operationLog.js';
import { releaseJobLock, tryAcquireJobLock } from '@shared/utils/repositories.js';

let running = false;
const BUDGET_ADVISOR_JOB_LOCK = 'worker:budget_advisor:cycle';
const BUDGET_ADVISOR_JOB_LOCK_TTL_MS = 2 * 60 * 60 * 1000;

async function tick(): Promise<void> {
  if (running) {
    logger.warn('budget_advisor_skip_overlap');
    return;
  }
  running = true;
  let lockOwnerId = '';
  try {
    lockOwnerId = crypto.randomUUID();
    const lockAcquired = await tryAcquireJobLock(BUDGET_ADVISOR_JOB_LOCK, lockOwnerId, BUDGET_ADVISOR_JOB_LOCK_TTL_MS);
    if (!lockAcquired) {
      logger.warn('budget_advisor_skip_distributed_overlap');
      return;
    }
    const result = await runBudgetAdvisorCycle(env.budgetAdvisorLookbackDays, logger);
    logger.info('budget_advisor_cycle_result', {
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
        target_key: String(env.budgetAdvisorLookbackDays),
        status: 'success',
        summary: `定时预算建议生成完成，回看 ${env.budgetAdvisorLookbackDays} 天`,
        detail_json: result
      },
      logger
    );
  } catch (error) {
    logger.error('budget_advisor_cycle_failed', {
      error: error instanceof Error ? error.message : String(error)
    });
    await writeOperationLog(
      {
        source: 'worker.budget_advisor',
        action: 'scheduled_budget_cycle',
        target_type: 'budget_cycle',
        target_key: String(env.budgetAdvisorLookbackDays),
        status: 'failed',
        summary: `定时预算建议生成失败，回看 ${env.budgetAdvisorLookbackDays} 天`,
        detail_json: {
          error: error instanceof Error ? error.message : String(error)
        }
      },
      logger
    );
  } finally {
    if (lockOwnerId) {
      await releaseJobLock(BUDGET_ADVISOR_JOB_LOCK, lockOwnerId);
    }
    running = false;
  }
}

async function bootstrap(): Promise<void> {
  await tick();
  setInterval(() => {
    void tick();
  }, env.budgetAdvisorIntervalMs);
}

bootstrap().catch((error) => {
  logger.error('budget_advisor_bootstrap_failed', {
    error: error instanceof Error ? error.message : String(error)
  });
  process.exit(1);
});
