import { Router } from 'express';
import {
  buildDailyBriefPreview,
  getDailyBriefDefaultReportDate,
  listDailyBriefMediaSources,
  sendDailyBrief
} from '@shared/utils/dailyBrief.js';
import { logger } from '../../common/logger/logger.js';
import { writeOperationLog } from '@shared/utils/operationLog.js';

const router = Router();
let manualDailyBriefRunning = false;

function isDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function parseMediaSources(raw: unknown): string[] {
  if (Array.isArray(raw)) {
    return raw.map((item) => String(item || '').trim()).filter((item) => item.length > 0);
  }
  if (typeof raw === 'string' && raw.trim()) {
    return raw
      .split(',')
      .map((item) => item.trim())
      .filter((item) => item.length > 0);
  }
  return [];
}

router.get('/api/daily-brief/media-sources', async (req, res, next) => {
  try {
    const reportDateRaw =
      typeof req.query.reportDate === 'string' && req.query.reportDate.trim()
        ? req.query.reportDate.trim()
        : getDailyBriefDefaultReportDate();
    if (!isDate(reportDateRaw)) {
      return res.status(400).json({ ok: false, error: 'invalid_report_date' });
    }

    const appKey = typeof req.query.appKey === 'string' ? req.query.appKey.trim() : '';
    const platform = typeof req.query.platform === 'string' ? req.query.platform.trim().toLowerCase() : '';
    const items = await listDailyBriefMediaSources(reportDateRaw, {
      appKey: appKey || undefined,
      platform: platform || undefined
    });

    return res.json({ ok: true, data: items });
  } catch (error) {
    return next(error);
  }
});

router.get('/api/daily-brief/preview', async (req, res, next) => {
  try {
    const reportDateRaw =
      typeof req.query.reportDate === 'string' && req.query.reportDate.trim()
        ? req.query.reportDate.trim()
        : getDailyBriefDefaultReportDate();

    if (!isDate(reportDateRaw)) {
      return res.status(400).json({ ok: false, error: 'invalid_report_date' });
    }

    const appKey = typeof req.query.appKey === 'string' ? req.query.appKey.trim() : '';
    const platform = typeof req.query.platform === 'string' ? req.query.platform.trim().toLowerCase() : '';
    const mediaSources = parseMediaSources(req.query.mediaSources);
    const preview = await buildDailyBriefPreview(reportDateRaw, {
      appKey: appKey || undefined,
      platform: platform || undefined,
      mediaSources
    });
    await writeOperationLog(
      {
        source: 'api.daily_brief',
        action: 'preview_daily_brief',
        target_type: 'daily_brief',
        target_key: reportDateRaw,
        status: 'success',
        summary: `预览每日报告 ${reportDateRaw}`,
        detail_json: {
          report_date: reportDateRaw,
          app_key: appKey || null,
          platform: platform || null,
          media_sources: mediaSources,
          app_count: preview.summary.app_count,
          apps_with_data: preview.summary.apps_with_data,
          render_mode: preview.render_mode
        }
      },
      logger
    );
    return res.json({ ok: true, data: preview });
  } catch (error) {
    return next(error);
  }
});

router.post('/api/daily-brief/send', async (req, res, next) => {
  try {
    if (manualDailyBriefRunning) {
      return res.status(409).json({ ok: false, error: 'daily_brief_send_running' });
    }
    manualDailyBriefRunning = true;

    const body = (req.body ?? {}) as Record<string, unknown>;
    const reportDateRaw =
      typeof body.reportDate === 'string' && body.reportDate.trim()
        ? body.reportDate.trim()
        : getDailyBriefDefaultReportDate();
    const force = body.force === true;
    const appKey = typeof body.appKey === 'string' ? body.appKey.trim() : '';
    const platform = typeof body.platform === 'string' ? body.platform.trim().toLowerCase() : '';
    const mediaSources = parseMediaSources(body.mediaSources);

    if (!isDate(reportDateRaw)) {
      return res.status(400).json({ ok: false, error: 'invalid_report_date' });
    }

    const result = await sendDailyBrief(reportDateRaw, {
      force,
      manualTriggered: true,
      filters: {
        appKey: appKey || undefined,
        platform: platform || undefined,
        mediaSources
      }
    });

    if (!result.ok) {
      logger.error('manual_daily_brief_send_failed', {
        report_date: reportDateRaw,
        error: result.notify.error ?? `status_${String(result.notify.status ?? 'unknown')}`
      });
      await writeOperationLog(
        {
          source: 'api.daily_brief',
          action: 'send_daily_brief',
          target_type: 'daily_brief',
          target_key: reportDateRaw,
          status: 'failed',
        summary: `手动发送每日报告失败 ${reportDateRaw}`,
        detail_json: {
          ...result,
          filters: {
            app_key: appKey || null,
            platform: platform || null,
            media_sources: mediaSources
          }
        }
      },
      logger
      );
      return res.status(502).json({
        ok: false,
        error: 'daily_brief_send_failed',
        data: result
      });
    }

    await writeOperationLog(
      {
        source: 'api.daily_brief',
        action: 'send_daily_brief',
        target_type: 'daily_brief',
        target_key: reportDateRaw,
        status: result.skipped ? 'skipped' : 'success',
        summary: `${result.skipped ? '跳过' : '发送'}每日报告 ${reportDateRaw}`,
        detail_json: {
          skipped: result.skipped,
          app_key: appKey || null,
          platform: platform || null,
          media_sources: mediaSources,
          notify_status: result.notify.status,
          dispatch_id: result.dispatch.id,
          render_mode: result.notify.render_mode || result.report.render_mode,
          error: result.notify.ok ? null : result.notify.error || null
        }
      },
      logger
    );

    return res.json({ ok: true, data: result });
  } catch (error) {
    return next(error);
  } finally {
    manualDailyBriefRunning = false;
  }
});

export default router;
