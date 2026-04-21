import crypto from 'crypto';
import { logger } from '@api/common/logger/logger.js';
import { env } from '@shared/config/env.js';
import { activeBitableExportSourceTypes } from '@shared/utils/bitableExport.js';
import { runBitableFeedbackSync } from '@shared/utils/recommendationFeedback.js';
import { releaseJobLock, tryAcquireJobLock } from '@shared/utils/repositories.js';

const WORKER_LOCK = 'worker:bitable_feedback_sync:tick';
const WORKER_LOCK_TTL_MS = 30 * 60 * 1000;

let running = false;

async function tick(): Promise<void> {
  if (!env.feishuBitableEnabled) {
    return;
  }
  if (running) {
    logger.warn('bitable_feedback_sync_skip_overlap');
    return;
  }

  running = true;
  let ownerId = '';
  try {
    ownerId = crypto.randomUUID();
    const acquired = await tryAcquireJobLock(WORKER_LOCK, ownerId, WORKER_LOCK_TTL_MS);
    if (!acquired) {
      logger.warn('bitable_feedback_sync_skip_distributed_overlap');
      return;
    }
    for (const sourceType of activeBitableExportSourceTypes()) {
      await runBitableFeedbackSync(sourceType, logger, 'worker.bitable_feedback_sync');
    }
  } catch (error) {
    logger.error('bitable_feedback_sync_failed', {
      error: error instanceof Error ? error.message : String(error)
    });
  } finally {
    if (ownerId) {
      await releaseJobLock(WORKER_LOCK, ownerId);
    }
    running = false;
  }
}

async function loop(): Promise<void> {
  await tick();
  setTimeout(() => {
    loop().catch((error) => {
      logger.error('bitable_feedback_sync_loop_failed', {
        error: error instanceof Error ? error.message : String(error)
      });
    });
  }, Math.max(60_000, env.bitableFeedbackSyncIntervalMs));
}

loop().catch((error) => {
  logger.error('bitable_feedback_sync_bootstrap_failed', {
    error: error instanceof Error ? error.message : String(error)
  });
  process.exit(1);
});
