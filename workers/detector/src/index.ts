import { env } from '@shared/config/env.js';
import { logger } from '@api/common/logger/logger.js';
import { runDetectionCycle } from './detector.js';
import { writeOperationLog } from '@shared/utils/operationLog.js';

let running = false;

async function tick(): Promise<void> {
  if (running) {
    logger.warn('detector_skip_overlap');
    return;
  }

  running = true;
  try {
    const stats = await runDetectionCycle();
    logger.info('detector_cycle_finished', {
      runtime_ms: stats.runtimeMs,
      checked_rules: stats.checkedRules,
      opened_alerts: stats.openedAlerts,
      resolved_alerts: stats.resolvedAlerts,
      alert_notify_success: stats.alertNotifySuccess,
      alert_notify_failure: stats.alertNotifyFailure
    });
    await writeOperationLog(
      {
        source: 'worker.detector',
        action: 'scheduled_detection_cycle',
        target_type: 'detector',
        target_key: 'rules',
        status: 'success',
        summary: `定时异常检测完成，检查 ${stats.checkedRules} 条规则`,
        detail_json: stats
      },
      logger
    );
  } catch (error) {
    logger.error('detector_cycle_failed', {
      error: error instanceof Error ? error.message : String(error)
    });
    await writeOperationLog(
      {
        source: 'worker.detector',
        action: 'scheduled_detection_cycle',
        target_type: 'detector',
        target_key: 'rules',
        status: 'failed',
        summary: '定时异常检测失败',
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
  }, env.detectorIntervalMs);
}

bootstrap().catch((error) => {
  logger.error('detector_bootstrap_failed', {
    error: error instanceof Error ? error.message : String(error)
  });
  process.exit(1);
});
