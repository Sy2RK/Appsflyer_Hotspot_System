import { env } from '@shared/config/env.js';
import { logger } from '@api/common/logger/logger.js';
import { runAsaKeywordCycle } from '@shared/utils/asaKeywords.js';
import { writeOperationLog } from '@shared/utils/operationLog.js';

let running = false;

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
        target_key: String(env.asaKeywordBackfillDays),
        status: 'success',
        summary: `定时重算 ASA 关键词链路，回算 ${env.asaKeywordBackfillDays} 天`,
        detail_json: { ...result }
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
        target_key: String(env.asaKeywordBackfillDays),
        status: 'failed',
        summary: `定时重算 ASA 关键词链路失败，回算 ${env.asaKeywordBackfillDays} 天`,
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
  } else {
    logger.info('asa_keyword_cycle_skip_boot');
  }
  setInterval(() => {
    void tick();
  }, env.asaKeywordIntervalMs);
}

bootstrap().catch((error) => {
  logger.error('asa_keyword_bootstrap_failed', {
    error: error instanceof Error ? error.message : String(error)
  });
  process.exit(1);
});
