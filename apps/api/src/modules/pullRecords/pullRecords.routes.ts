import { Router } from 'express';
import { chExec, chInsertJSON, chQuery } from '../../common/clickhouse/client.js';
import { runPullCycle } from '@shared/utils/puller.js';
import { logger } from '../../common/logger/logger.js';
import { writeOperationLog } from '@shared/utils/operationLog.js';

const router = Router();

const PAGE_SIZE = 20;
const TEXT_FILTER_MAX_LEN = 200;
const SORTS = new Map<string, string>([
  ['ingest_time_desc', 'ingest_time DESC'],
  ['ingest_time_asc', 'ingest_time ASC']
]);

function isDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function normalizeTextFilter(raw: unknown): string {
  if (typeof raw !== 'string') {
    return '';
  }
  return raw.trim().slice(0, TEXT_FILTER_MAX_LEN);
}

function normalizePage(raw: unknown): number {
  const num = Number(raw);
  if (!Number.isFinite(num) || num < 1) {
    return 1;
  }
  return Math.floor(num);
}

async function rebuildMetricsDailySlice(params: {
  date: string;
  appKey: string;
  platform: string;
  mediaSource: string;
  country: string;
  campaign: string;
}): Promise<void> {
  const queryParams = {
    date: params.date,
    app_key: params.appKey,
    platform: params.platform,
    media_source: params.mediaSource,
    country: params.country,
    campaign: params.campaign
  };

  await chExec(
    `ALTER TABLE metrics_daily
      DELETE WHERE date = toDate({date:String})
        AND app_key = {app_key:String}
        AND lowerUTF8(platform) = {platform:String}
        AND media_source = {media_source:String}
        AND country = {country:String}
        AND campaign = {campaign:String}
        AND source = 'pull_daily_report_v5'
      SETTINGS mutations_sync = 2`,
    queryParams
  );

  const rows = await chQuery<Record<string, unknown>>(
    `SELECT
        sum(toFloat64(installs)) AS installs,
        sum(toFloat64(clicks)) AS clicks,
        sum(toFloat64(total_cost)) AS total_cost
      FROM pull_aggregate_daily
      WHERE date = toDate({date:String})
        AND app_key = {app_key:String}
        AND lowerUTF8(platform) = {platform:String}
        AND media_source = {media_source:String}
        AND country = {country:String}
        AND campaign = {campaign:String}`,
    queryParams
  );

  const installs = Number(rows[0]?.installs || 0);
  const clicks = Number(rows[0]?.clicks || 0);
  const totalCost = Number(rows[0]?.total_cost || 0);
  if (installs <= 0 && clicks <= 0 && totalCost <= 0) {
    return;
  }

  const version = Date.now();
  await chInsertJSON('metrics_daily', [
    {
      date: params.date,
      app_key: params.appKey,
      platform: params.platform,
      metric: 'installs',
      value: installs,
      media_source: params.mediaSource,
      campaign: params.campaign,
      country: params.country,
      source: 'pull_daily_report_v5',
      version
    },
    {
      date: params.date,
      app_key: params.appKey,
      platform: params.platform,
      metric: 'clicks',
      value: clicks,
      media_source: params.mediaSource,
      campaign: params.campaign,
      country: params.country,
      source: 'pull_daily_report_v5',
      version
    },
    {
      date: params.date,
      app_key: params.appKey,
      platform: params.platform,
      metric: 'total_cost',
      value: totalCost,
      media_source: params.mediaSource,
      campaign: params.campaign,
      country: params.country,
      source: 'pull_daily_report_v5',
      version
    }
  ]);
}

function summarizePullCycleStatus(result: {
  success_count?: number;
  failed_count?: number;
  skipped_count?: number;
}): 'success' | 'failed' | 'info' | 'skipped' {
  const successCount = Number(result.success_count || 0);
  const failedCount = Number(result.failed_count || 0);
  const skippedCount = Number(result.skipped_count || 0);
  if (successCount > 0 && failedCount === 0 && skippedCount === 0) {
    return 'success';
  }
  if (successCount === 0 && failedCount === 0 && skippedCount > 0) {
    return 'skipped';
  }
  if (successCount === 0 && failedCount > 0 && skippedCount === 0) {
    return 'failed';
  }
  return 'info';
}

router.get('/api/pull-records', async (req, res) => {
  const appKey = normalizeTextFilter(req.query.appKey);
  const from = typeof req.query.from === 'string' ? req.query.from.trim() : '';
  const to = typeof req.query.to === 'string' ? req.query.to.trim() : '';
  const mediaSource = normalizeTextFilter(req.query.mediaSource);
  const campaign = normalizeTextFilter(req.query.campaign);
  const platform = normalizeTextFilter(req.query.platform).toLowerCase();
  const page = normalizePage(req.query.page);
  const sortRaw = typeof req.query.sort === 'string' ? req.query.sort.trim() : 'ingest_time_desc';
  const sortExpr = SORTS.get(sortRaw) ?? SORTS.get('ingest_time_desc')!;

  if (!from || !to) {
    return res.status(400).json({ ok: false, error: 'from_to_required' });
  }
  if (!isDate(from) || !isDate(to)) {
    return res.status(400).json({ ok: false, error: 'invalid_date_format' });
  }
  if (from > to) {
    return res.status(400).json({ ok: false, error: 'from_gt_to' });
  }

  const whereSql = `
    date >= toDate({from:String})
    AND date <= toDate({to:String})
    AND ({app_key:String} = '' OR app_key = {app_key:String})
    AND ({media_source:String} = '' OR positionCaseInsensitiveUTF8(media_source, {media_source:String}) > 0)
    AND ({campaign:String} = '' OR positionCaseInsensitiveUTF8(campaign, {campaign:String}) > 0)
    AND ({platform:String} = '' OR lowerUTF8(platform) = {platform:String})
  `;

  const countRows = await chQuery<{ total: number | string }>(
    `SELECT toString(count()) AS total FROM pull_aggregate_daily WHERE ${whereSql}`,
    {
      from,
      to,
      app_key: appKey,
      media_source: mediaSource,
      campaign,
      platform
    }
  );
  const total = Number(countRows[0]?.total ?? 0);
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const currentPage = Math.min(page, totalPages);
  const offset = (currentPage - 1) * PAGE_SIZE;

  const params = {
    from,
    to,
    app_key: appKey,
    media_source: mediaSource,
    campaign,
    platform,
    limit: PAGE_SIZE,
    offset
  };

  const dataRows = await chQuery<Record<string, unknown>>(
    `
      SELECT
        ingest_time,
        date,
        app_key,
        platform,
        media_source,
        country,
        campaign,
        installs,
        clicks,
        total_cost,
        source_report,
        raw_json
      FROM pull_aggregate_daily
      WHERE ${whereSql}
      ORDER BY ${sortExpr}
      LIMIT {limit:UInt32}
      OFFSET {offset:UInt32}
    `,
    params
  );

  return res.json({
    ok: true,
    data: dataRows,
    meta: {
      page: currentPage,
      pageSize: PAGE_SIZE,
      total,
      totalPages,
      from,
      to
    }
  });
});

router.delete('/api/pull-records', async (req, res) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const ingestTime = typeof body.ingest_time === 'string' ? body.ingest_time.trim() : '';
  const date = typeof body.date === 'string' ? body.date.trim() : '';
  const appKey = normalizeTextFilter(body.app_key);
  const platform = normalizeTextFilter(body.platform).toLowerCase();
  const mediaSource = normalizeTextFilter(body.media_source);
  const country = normalizeTextFilter(body.country);
  const campaign = normalizeTextFilter(body.campaign);
  const sourceReport = normalizeTextFilter(body.source_report);
  const rawJson = typeof body.raw_json === 'string' ? body.raw_json : '';
  if (!ingestTime || !date || !appKey || !sourceReport || !rawJson) {
    return res.status(400).json({ ok: false, error: 'invalid_pull_record_payload' });
  }
  if (!isDate(date)) {
    return res.status(400).json({ ok: false, error: 'invalid_date_format' });
  }

  await chExec(
    `ALTER TABLE pull_aggregate_daily
      DELETE WHERE ingest_time = toDateTime({ingest_time:String})
        AND date = toDate({date:String})
        AND app_key = {app_key:String}
        AND lowerUTF8(platform) = {platform:String}
        AND media_source = {media_source:String}
        AND country = {country:String}
        AND campaign = {campaign:String}
        AND source_report = {source_report:String}
        AND raw_json = {raw_json:String}
      SETTINGS mutations_sync = 2`,
    {
      ingest_time: ingestTime,
      date,
      app_key: appKey,
      platform: platform || 'unknown',
      media_source: mediaSource || 'unknown',
      country: country || 'unknown',
      campaign: campaign || 'unknown',
      source_report: sourceReport,
      raw_json: rawJson
    }
  );

  await rebuildMetricsDailySlice({
    date,
    appKey,
    platform: platform || 'unknown',
    mediaSource: mediaSource || 'unknown',
    country: country || 'unknown',
    campaign: campaign || 'unknown'
  });

  logger.info('pull_record_deleted', {
    app_key: appKey,
    date,
    platform: platform || 'unknown',
    media_source: mediaSource || 'unknown',
    campaign: campaign || 'unknown'
  });

  await writeOperationLog(
    {
      source: 'api.pull_records',
      action: 'delete_pull_record',
      target_type: 'pull_record',
      target_key: `${appKey}:${date}:${platform || 'unknown'}`,
      status: 'success',
      summary: `删除 Pull 明细 ${appKey} ${date}`,
      detail_json: {
        app_key: appKey,
        date,
        platform: platform || 'unknown',
        media_source: mediaSource || 'unknown',
        campaign: campaign || 'unknown'
      }
    },
    logger
  );

  return res.json({ ok: true });
});

router.post('/api/pull-records/trigger', async (req, res) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const rawDays = Number(body.backfillDays);
  const backfillDays =
    Number.isFinite(rawDays) && rawDays > 0 ? Math.min(7, Math.max(1, Math.floor(rawDays))) : 1;

  try {
    const result = await runPullCycle(backfillDays, logger);
    await writeOperationLog(
      {
        source: 'api.pull_records',
        action: 'manual_pull_trigger',
        target_type: 'pull_cycle',
        target_key: String(backfillDays),
        status: summarizePullCycleStatus(result),
        summary: `手动触发 Pull，回填 ${backfillDays} 天`,
        detail_json: result
      },
      logger
    );
    return res.json({ ok: true, data: result });
  } catch (error) {
    logger.error('manual_pull_trigger_failed', {
      backfill_days: backfillDays,
      error: error instanceof Error ? error.message : String(error)
    });
    await writeOperationLog(
      {
        source: 'api.pull_records',
        action: 'manual_pull_trigger',
        target_type: 'pull_cycle',
        target_key: String(backfillDays),
        status: 'failed',
        summary: `手动触发 Pull 失败，回填 ${backfillDays} 天`,
        detail_json: {
          backfill_days: backfillDays,
          error: error instanceof Error ? error.message : String(error)
        }
      },
      logger
    );
    return res.status(500).json({ ok: false, error: 'manual_pull_failed' });
  }
});

export default router;
