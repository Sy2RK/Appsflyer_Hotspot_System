import crypto from 'crypto';
import { Router } from 'express';
import {
  buildAsaKeywordBriefPreview,
  queryAsaKeywordDashboard,
  queryAsaKeywordTrend,
  runAsaKeywordCycle,
  sendAsaKeywordBrief
} from '@shared/utils/asaKeywords.js';
import { listProductStageConfigs, releaseJobLock, tryAcquireJobLock, upsertProductStageConfig } from '@shared/utils/repositories.js';
import { logger } from '../../common/logger/logger.js';
import { env } from '@shared/config/env.js';
import { writeOperationLog } from '@shared/utils/operationLog.js';

const router = Router();
const MANUAL_ASA_KEYWORD_RECOMPUTE_LOCK = 'api:asa_keywords:recompute';
const MANUAL_ASA_KEYWORD_RECOMPUTE_LOCK_TTL_MS = 2 * 60 * 60 * 1000;
const MANUAL_ASA_KEYWORD_BRIEF_SEND_LOCK_PREFIX = 'api:asa_keywords:brief:send';
const MANUAL_ASA_KEYWORD_BRIEF_SEND_LOCK_TTL_MS = 30 * 60 * 1000;

function isDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function toInt(raw: unknown, fallback: number, min: number, max: number): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

router.get('/api/asa-keywords', async (req, res, next) => {
  try {
    const appKey = typeof req.query.appKey === 'string' ? req.query.appKey.trim() : '';
    const platform = typeof req.query.platform === 'string' ? req.query.platform.trim().toLowerCase() : '';
    const stage = typeof req.query.stage === 'string' ? req.query.stage.trim() : '';
    const keyword = typeof req.query.keyword === 'string' ? req.query.keyword.trim() : '';
    const campaign = typeof req.query.campaign === 'string' ? req.query.campaign.trim() : '';
    const from = typeof req.query.from === 'string' ? req.query.from.trim() : '';
    const to = typeof req.query.to === 'string' ? req.query.to.trim() : '';
    const page = toInt(req.query.page, 1, 1, 100000);
    const pageSize = toInt(req.query.pageSize, 20, 1, 100);

    if (from && !isDate(from)) {
      return res.status(400).json({ ok: false, error: 'invalid_from_date' });
    }
    if (to && !isDate(to)) {
      return res.status(400).json({ ok: false, error: 'invalid_to_date' });
    }
    if (from && to && from > to) {
      return res.status(400).json({ ok: false, error: 'from_gt_to' });
    }

    const result = await queryAsaKeywordDashboard({
      appKey: appKey || undefined,
      platform: platform || undefined,
      stage: stage === 'rising' || stage === 'stable' ? stage : undefined,
      keyword: keyword || undefined,
      campaign: campaign || undefined,
      from: from || undefined,
      to: to || undefined,
      page,
      pageSize
    });

    return res.json({
      ok: true,
	      data: result.rows,
	      summary: result.summary,
	      summary_window: result.summary_window,
	      metric_scope: result.metric_scope,
	      official_snapshot: result.official_snapshot,
	      meta: {
        page: result.page,
        pageSize: result.pageSize,
        total: result.total,
        totalPages: result.totalPages
      }
    });
  } catch (error) {
    return next(error);
  }
});

router.get('/api/asa-keywords/:keyword/trend', async (req, res, next) => {
  try {
    const appKey = typeof req.query.appKey === 'string' ? req.query.appKey.trim() : '';
    const platform = typeof req.query.platform === 'string' ? req.query.platform.trim().toLowerCase() : '';
    const campaign = typeof req.query.campaign === 'string' ? req.query.campaign.trim() : '';
    const adset = typeof req.query.adset === 'string' ? req.query.adset.trim() : '';
    const keyword = decodeURIComponent(req.params.keyword || '').trim();
    if (!appKey || !platform || !keyword || !campaign || !adset) {
      return res.status(400).json({ ok: false, error: 'appKey_platform_keyword_campaign_adset_required' });
    }
    const rows = await queryAsaKeywordTrend(appKey, platform, keyword, campaign, adset);
    return res.json({ ok: true, data: rows });
  } catch (error) {
    return next(error);
  }
});

router.get('/api/asa-keywords/stages', async (_req, res, next) => {
  try {
    const rows = await listProductStageConfigs();
    return res.json({ ok: true, data: rows });
  } catch (error) {
    return next(error);
  }
});

router.post('/api/asa-keywords/stages', async (req, res, next) => {
  try {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const appKey = typeof body.appKey === 'string' ? body.appKey.trim() : '';
    const platform = typeof body.platform === 'string' ? body.platform.trim().toLowerCase() : '';
    const stage = body.stage === 'stable' ? 'stable' : 'rising';
    if (!appKey || !platform) {
      return res.status(400).json({ ok: false, error: 'appKey_platform_required' });
    }
    const row = await upsertProductStageConfig({
      app_key: appKey,
      platform,
      stage,
      enabled: body.enabled !== false
    });
    await writeOperationLog(
      {
        source: 'api.asa_keywords',
        action: 'update_product_stage',
        target_type: 'product_stage',
        target_key: `${appKey}|${platform}`,
        status: 'success',
        summary: `更新产品阶段：${appKey} / ${platform} -> ${stage}`,
        detail_json: row
      },
      logger
    );
    return res.json({ ok: true, data: row });
  } catch (error) {
    return next(error);
  }
});

router.post('/api/asa-keywords/recompute', async (req, res, next) => {
  let lockOwnerId = '';
  try {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const backfillDays = toInt(body.backfillDays, env.asaKeywordBackfillDays, 1, 60);
    lockOwnerId = crypto.randomUUID();
    const lockAcquired = await tryAcquireJobLock(
      MANUAL_ASA_KEYWORD_RECOMPUTE_LOCK,
      lockOwnerId,
      MANUAL_ASA_KEYWORD_RECOMPUTE_LOCK_TTL_MS
    );
    if (!lockAcquired) {
      return res.status(409).json({ ok: false, error: 'asa_keyword_recompute_running' });
    }
    const result = await runAsaKeywordCycle(backfillDays, logger);
    await writeOperationLog(
      {
        source: 'api.asa_keywords',
        action: 'manual_asa_keyword_recompute',
        target_type: 'asa_keyword_cycle',
        target_key: String(backfillDays),
        status: 'success',
        summary: `手动重算 ASA 关键词链路，回算 ${backfillDays} 天`,
        detail_json: result
      },
      logger
    );
    return res.json({ ok: true, data: result });
  } catch (error) {
    await writeOperationLog(
      {
        source: 'api.asa_keywords',
        action: 'manual_asa_keyword_recompute',
        target_type: 'asa_keyword_cycle',
        target_key: String(env.asaKeywordBackfillDays),
        status: 'failed',
        summary: '手动重算 ASA 关键词链路失败',
        detail_json: {
          error: error instanceof Error ? error.message : String(error)
        }
      },
      logger
    );
    return next(error);
  } finally {
    if (lockOwnerId) {
      await releaseJobLock(MANUAL_ASA_KEYWORD_RECOMPUTE_LOCK, lockOwnerId);
    }
  }
});

router.get('/api/asa-keywords/brief/preview', async (req, res, next) => {
  try {
    const reportDate = typeof req.query.reportDate === 'string' ? req.query.reportDate.trim() : '';
    const appKey = typeof req.query.appKey === 'string' ? req.query.appKey.trim() : '';
    const platform = typeof req.query.platform === 'string' ? req.query.platform.trim().toLowerCase() : '';
    if (!reportDate || !isDate(reportDate)) {
      return res.status(400).json({ ok: false, error: 'invalid_report_date' });
    }
    if (platform && platform !== 'ios') {
      return res.status(400).json({ ok: false, error: 'asa_brief_ios_only' });
    }
    const preview = await buildAsaKeywordBriefPreview({
      reportDate,
      appKey: appKey || undefined,
      platform: platform || undefined
    });
    return res.json({ ok: true, data: preview });
  } catch (error) {
    return next(error);
  }
});

router.post('/api/asa-keywords/brief/send', async (req, res, next) => {
  let lockOwnerId = '';
  try {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const reportDate = typeof body.reportDate === 'string' ? body.reportDate.trim() : '';
    const appKey = typeof body.appKey === 'string' ? body.appKey.trim() : '';
    const platform = typeof body.platform === 'string' ? body.platform.trim().toLowerCase() : '';
    if (!reportDate || !isDate(reportDate)) {
      return res.status(400).json({ ok: false, error: 'invalid_report_date' });
    }
    if (platform && platform !== 'ios') {
      return res.status(400).json({ ok: false, error: 'asa_brief_ios_only' });
    }

    const lockName = [
      MANUAL_ASA_KEYWORD_BRIEF_SEND_LOCK_PREFIX,
      reportDate,
      appKey || 'all',
      platform || 'all'
    ].join(':');
    lockOwnerId = crypto.randomUUID();
    const lockAcquired = await tryAcquireJobLock(lockName, lockOwnerId, MANUAL_ASA_KEYWORD_BRIEF_SEND_LOCK_TTL_MS);
    if (!lockAcquired) {
      return res.status(409).json({ ok: false, error: 'asa_keyword_brief_send_running' });
    }

    const result = await sendAsaKeywordBrief(reportDate, {
      appKey: appKey || undefined,
      platform: platform || undefined,
      force: body.force === true,
      manualTriggered: true
    });
    return res.json({ ok: true, data: result });
  } catch (error) {
    return next(error);
  } finally {
    if (lockOwnerId) {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const reportDate = typeof body.reportDate === 'string' ? body.reportDate.trim() : '';
      const appKey = typeof body.appKey === 'string' ? body.appKey.trim() : '';
      const platform = typeof body.platform === 'string' ? body.platform.trim().toLowerCase() : '';
      const lockName = [
        MANUAL_ASA_KEYWORD_BRIEF_SEND_LOCK_PREFIX,
        reportDate,
        appKey || 'all',
        platform || 'all'
      ].join(':');
      await releaseJobLock(lockName, lockOwnerId);
    }
  }
});

export default router;
