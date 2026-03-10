import { Router } from 'express';
import { chQuery } from '../../common/clickhouse/client.js';
import { logger } from '../../common/logger/logger.js';
import { queryKeywordLifecycleStates } from '@shared/utils/repositories.js';
import { runKeywordEngineCycle } from '@shared/utils/keywordEngine.js';
import { writeOperationLog } from '@shared/utils/operationLog.js';

const router = Router();
let recomputeRunning = false;

function isDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function toInt(raw: unknown, fallback: number, min: number, max: number): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

router.get('/api/keywords/lifecycle', async (req, res, next) => {
  try {
    const appKey = typeof req.query.appKey === 'string' ? req.query.appKey.trim() : '';
    const platform = typeof req.query.platform === 'string' ? req.query.platform.trim().toLowerCase() : '';
    const stage = typeof req.query.stage === 'string' ? req.query.stage.trim() : '';
    const keyword = typeof req.query.keyword === 'string' ? req.query.keyword.trim() : '';
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

    const result = await queryKeywordLifecycleStates({
      appKey: appKey || undefined,
      platform: platform || undefined,
      stage: stage || undefined,
      keyword: keyword || undefined,
      from: from || undefined,
      to: to || undefined,
      page,
      pageSize
    });

    return res.json({
      ok: true,
      data: result.rows,
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

router.get('/api/keywords/:keyword/trend', async (req, res, next) => {
  try {
    const appKey = typeof req.query.appKey === 'string' ? req.query.appKey.trim() : '';
    const platform = typeof req.query.platform === 'string' ? req.query.platform.trim().toLowerCase() : '';
    const days = toInt(req.query.days, 30, 1, 180);
    const matchType = typeof req.query.matchType === 'string' ? req.query.matchType.trim() : '';
    const keyword = decodeURIComponent(req.params.keyword || '').trim();

    if (!appKey) {
      return res.status(400).json({ ok: false, error: 'appKey_required' });
    }
    if (!keyword) {
      return res.status(400).json({ ok: false, error: 'keyword_required' });
    }

    const rows = await chQuery<Record<string, unknown>>(
      `SELECT
          report_date AS date,
          keyword,
          match_type,
          installs,
          clicks,
          total_cost,
          average_ecpi AS official_ecpi,
          if(installs > 0, total_cost / installs, 0) AS cpi,
          if(clicks > 0, installs / clicks, 0) AS cvr
        FROM (
          SELECT
            report_date,
            keyword,
            match_type,
            sum(installs_raw) AS installs,
            sum(clicks_raw) AS clicks,
            sum(total_cost_raw) AS total_cost,
            if(
              sum(installs_raw) > 0,
              sum(ecpi_weight) / sum(installs_raw),
              0
            ) AS average_ecpi
          FROM (
            SELECT
              toString(date) AS report_date,
              keyword,
              match_type,
              toFloat64(installs) AS installs_raw,
              toFloat64(clicks) AS clicks_raw,
              toFloat64(total_cost) AS total_cost_raw,
              toFloat64(af_average_ecpi) * toFloat64(installs) AS ecpi_weight
            FROM keyword_daily_metrics FINAL
            WHERE app_key = {app_key:String}
              AND ({platform:String} = '' OR platform = {platform:String})
              AND keyword = {keyword:String}
              AND ({match_type:String} = '' OR match_type = {match_type:String})
              AND date >= toDate(today() - ${days})
              AND date <= toDate(today() - 1)
          )
          GROUP BY report_date, keyword, match_type
        )
        ORDER BY report_date ASC`,
      {
        app_key: appKey,
        platform,
        keyword,
        match_type: matchType
      }
    );

    return res.json({
      ok: true,
      data: rows,
      meta: {
        appKey,
        platform: platform || null,
        keyword,
        matchType: matchType || null,
        days
      }
    });
  } catch (error) {
    return next(error);
  }
});

router.post('/api/keywords/recompute', async (req, res, next) => {
  try {
    if (recomputeRunning) {
      return res.status(409).json({ ok: false, error: 'keyword_recompute_running' });
    }

    const body = (req.body ?? {}) as Record<string, unknown>;
    const backfillDays = toInt(body.backfillDays, 30, 1, 180);
    recomputeRunning = true;
    try {
      const result = await runKeywordEngineCycle(backfillDays, logger);
      await writeOperationLog(
        {
          source: 'api.keywords',
          action: 'manual_keyword_recompute',
          target_type: 'keyword_cycle',
          target_key: String(backfillDays),
          status: 'success',
          summary: `手动重算关键词生命周期，回算 ${backfillDays} 天`,
          detail_json: result
        },
        logger
      );
      return res.json({ ok: true, data: result });
    } catch (error) {
      logger.error('keyword_recompute_failed', {
        backfill_days: backfillDays,
        error: error instanceof Error ? error.message : String(error)
      });
      await writeOperationLog(
        {
          source: 'api.keywords',
          action: 'manual_keyword_recompute',
          target_type: 'keyword_cycle',
          target_key: String(backfillDays),
          status: 'failed',
          summary: `手动重算关键词生命周期失败，回算 ${backfillDays} 天`,
          detail_json: {
            backfill_days: backfillDays,
            error: error instanceof Error ? error.message : String(error)
          }
        },
        logger
      );
      return next(error);
    } finally {
      recomputeRunning = false;
    }
  } catch (error) {
    return next(error);
  }
});

export default router;
