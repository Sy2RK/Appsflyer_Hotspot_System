import crypto from 'crypto';
import { Router } from 'express';
import {
  activeBitableExportSourceTypes,
  getBitableExportConfigsSnapshot,
  runBitableExport,
  resolveManualBitableExportHttpResult,
  saveBitableExportConfig
} from '@shared/utils/bitableExport.js';
import { runBitableFeedbackSync } from '@shared/utils/recommendationFeedback.js';
import { releaseJobLock, tryAcquireJobLock } from '@shared/utils/repositories.js';
import { writeOperationLog } from '@shared/utils/operationLog.js';
import { logger } from '../../common/logger/logger.js';
import type { BitableExportSourceType } from '@shared/types/models.js';

const router = Router();
const SOURCE_TYPES = new Set<BitableExportSourceType>(activeBitableExportSourceTypes());
const MANUAL_BITABLE_EXPORT_RUN_LOCK = 'api:bitable_export:run';
const MANUAL_BITABLE_EXPORT_RUN_LOCK_TTL_MS = 30 * 60 * 1000;
const MANUAL_BITABLE_FEEDBACK_SYNC_LOCK = 'api:bitable_feedback_sync:run';
const MANUAL_BITABLE_FEEDBACK_SYNC_LOCK_TTL_MS = 30 * 60 * 1000;

function isSourceType(value: unknown): value is BitableExportSourceType {
  return typeof value === 'string' && SOURCE_TYPES.has(value as BitableExportSourceType);
}

function isDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value);
}

router.get('/api/bitable-exports/configs', async (_req, res, next) => {
  try {
    const snapshot = await getBitableExportConfigsSnapshot();
    return res.json({ ok: true, data: snapshot });
  } catch (error) {
    return next(error);
  }
});

router.post('/api/bitable-exports/configs/:sourceType', async (req, res, next) => {
  try {
    const sourceType = String(req.params.sourceType || '').trim() as BitableExportSourceType;
    if (!isSourceType(sourceType)) {
      return res.status(400).json({ ok: false, error: 'invalid_source_type' });
    }

    const body = (req.body ?? {}) as Record<string, unknown>;
    const enabled = body.enabled === true;
    const chatId = typeof body.chatId === 'string' ? body.chatId.trim() : '';
    const tableNamePrefix = typeof body.tableNamePrefix === 'string' ? body.tableNamePrefix.trim() : '';

    const saved = await saveBitableExportConfig({
      sourceType,
      enabled,
      chatId,
      tableNamePrefix
    });

    await writeOperationLog(
      {
        source: 'api.bitable_export',
        action: 'save_bitable_export_config',
        target_type: 'bitable_export',
        target_key: sourceType,
        status: 'success',
        summary: `保存多维表格导出配置：${sourceType}`,
        detail_json: {
          source_type: sourceType,
          enabled,
          chat_id: chatId || null,
          table_name_prefix: tableNamePrefix || null,
          selected_field_count: saved.config.selected_fields.length
        }
      },
      logger
    );

    return res.json({ ok: true, data: saved });
  } catch (error) {
    return next(error);
  }
});

router.post('/api/bitable-exports/run', async (req, res, next) => {
  let lockOwnerId = '';
  try {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const sourceType = String(body.sourceType || '').trim() as BitableExportSourceType;
    const reportDate = String(body.reportDate || '').trim();

    if (!isSourceType(sourceType)) {
      return res.status(400).json({ ok: false, error: 'invalid_source_type' });
    }
    if (!reportDate || !isDate(reportDate)) {
      return res.status(400).json({ ok: false, error: 'invalid_report_date' });
    }

    lockOwnerId = crypto.randomUUID();
    const lockAcquired = await tryAcquireJobLock(
      MANUAL_BITABLE_EXPORT_RUN_LOCK,
      lockOwnerId,
      MANUAL_BITABLE_EXPORT_RUN_LOCK_TTL_MS
    );
    if (!lockAcquired) {
      return res.status(409).json({ ok: false, error: 'bitable_export_running' });
    }

    const result = await runBitableExport(sourceType, reportDate, logger);

    await writeOperationLog(
      {
        source: 'api.bitable_export',
        action: 'manual_bitable_export_run',
        target_type: 'bitable_export',
        target_key: `${sourceType}|${reportDate}`,
        status: result.export_status === 'success' && result.notify.ok ? 'success' : 'failed',
        summary:
          result.export_status === 'partial_success'
            ? `${result.label} 手动导出 ${reportDate}（部分成功）`
            : `${result.label} 手动导出 ${reportDate}`,
        detail_json: result
      },
      logger
    );

    const httpResult = resolveManualBitableExportHttpResult(result);
    if (!httpResult.ok) {
      return res.status(httpResult.http_status).json({
        ok: false,
        error: httpResult.error,
        data: result
      });
    }

    return res.json({ ok: true, data: result });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes('bitable_source_io_locked')) {
      return res.status(409).json({ ok: false, error: 'bitable_source_io_locked' });
    }
    await writeOperationLog(
      {
        source: 'api.bitable_export',
        action: 'manual_bitable_export_run',
        target_type: 'bitable_export',
        target_key: 'unknown',
        status: 'failed',
        summary: '手动执行多维表格导出失败',
        detail_json: {
          error: message
        }
      },
      logger
    );
    return next(error);
  } finally {
    if (lockOwnerId) {
      await releaseJobLock(MANUAL_BITABLE_EXPORT_RUN_LOCK, lockOwnerId);
    }
  }
});

router.post('/api/bitable-exports/feedback-sync', async (req, res, next) => {
  let lockOwnerId = '';
  try {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const sourceType = String(body.sourceType || '').trim() as BitableExportSourceType;
    if (!isSourceType(sourceType)) {
      return res.status(400).json({ ok: false, error: 'invalid_source_type' });
    }

    lockOwnerId = crypto.randomUUID();
    const lockAcquired = await tryAcquireJobLock(
      MANUAL_BITABLE_FEEDBACK_SYNC_LOCK,
      lockOwnerId,
      MANUAL_BITABLE_FEEDBACK_SYNC_LOCK_TTL_MS
    );
    if (!lockAcquired) {
      return res.status(409).json({ ok: false, error: 'bitable_feedback_sync_running' });
    }

    const result = await runBitableFeedbackSync(sourceType, logger, 'api.bitable_export');
    return res.json({ ok: true, data: result });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes('bitable_source_io_locked')) {
      return res.status(409).json({ ok: false, error: 'bitable_source_io_locked' });
    }
    return next(error);
  } finally {
    if (lockOwnerId) {
      await releaseJobLock(MANUAL_BITABLE_FEEDBACK_SYNC_LOCK, lockOwnerId);
    }
  }
});

export default router;
