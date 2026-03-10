import { Router } from 'express';
import { chQuery } from '../../common/clickhouse/client.js';

const router = Router();

const ALLOWED_DIMS = new Set([
  'media_source',
  'country',
  'campaign',
  'attribution',
  'event_type',
  'event_name',
  'platform'
]);
const ALLOWED_PULL_DIMS = new Set(['media_source', 'country', 'campaign', 'source', 'platform']);
const ALLOWED_PULL_METRICS = new Set(['installs', 'clicks', 'total_cost']);

router.get('/api/metrics', async (req, res) => {
  const appKey = typeof req.query.appKey === 'string' ? req.query.appKey : '';
  const metric = typeof req.query.metric === 'string' ? req.query.metric : 'event_count';
  const from = typeof req.query.from === 'string' ? req.query.from : '';
  const to = typeof req.query.to === 'string' ? req.query.to : '';
  const granularity = typeof req.query.granularity === 'string' ? req.query.granularity : 'hour';
  const source = typeof req.query.source === 'string' ? req.query.source : 'push';
  const platform =
    typeof req.query.platform === 'string' ? req.query.platform.trim().toLowerCase() : '';
  const dimsRaw = typeof req.query.dims === 'string' ? req.query.dims : '';
  const eventName = typeof req.query.eventName === 'string' ? req.query.eventName : undefined;

  if (!appKey || !from || !to) {
    return res.status(400).json({ ok: false, error: 'appKey_from_to_required' });
  }
  if (source !== 'push' && source !== 'pull') {
    return res.status(400).json({ ok: false, error: 'invalid_source' });
  }

  const dimsSet = source === 'pull' ? ALLOWED_PULL_DIMS : ALLOWED_DIMS;
  const dims = dimsRaw
    .split(',')
    .map((d) => d.trim())
    .filter((d) => d.length > 0 && dimsSet.has(d));

  const selectDims = dims.length ? `, ${dims.join(', ')}` : '';
  const groupDims = dims.length ? `, ${dims.join(', ')}` : '';

  if (source === 'pull') {
    if (granularity !== 'day') {
      return res.status(400).json({ ok: false, error: 'pull_only_day_granularity_supported' });
    }
    if (!ALLOWED_PULL_METRICS.has(metric)) {
      return res.status(400).json({ ok: false, error: 'invalid_pull_metric' });
    }

    const sql = `
      SELECT
        date,
        sum(value) AS value
        ${selectDims}
      FROM metrics_daily FINAL
      WHERE app_key = {app_key:String}
        AND metric = {metric:String}
        AND ({platform:String} = '' OR platform = {platform:String})
        AND date >= toDate({from:String})
        AND date <= toDate({to:String})
      GROUP BY date${groupDims}
      ORDER BY date ASC
      LIMIT 10000
    `;

    const rows = await chQuery<Record<string, unknown>>(sql, {
      app_key: appKey,
      metric,
      platform,
      from,
      to
    });

    return res.json({
      ok: true,
      data: rows,
      meta: {
        appKey,
        metric,
        from,
        to,
        source,
        granularity,
        dims,
        platform: platform || null,
        eventName: null
      }
    });
  }

  if (granularity !== 'hour') {
    return res.status(400).json({ ok: false, error: 'only_hour_granularity_supported' });
  }

  let eventNameFilter = '';
  if (metric === 'revenue') {
    eventNameFilter = `AND event_name = '__all__'`;
  } else if (metric === 'purchase_count') {
    eventNameFilter = `AND event_name = 'purchase'`;
  } else if (metric === 'event_count' && eventName) {
    eventNameFilter = `AND event_name = {event_name:String}`;
  }

  const sql = `
    SELECT
      hour,
      sum(value) AS value
      ${selectDims}
    FROM metrics_hourly FINAL
    WHERE app_key = {app_key:String}
      AND metric = {metric:String}
      AND ({platform:String} = '' OR platform = {platform:String})
      AND hour >= toDateTime({from:String})
      AND hour < toDateTime({to:String})
      ${eventNameFilter}
    GROUP BY hour${groupDims}
    ORDER BY hour ASC
    LIMIT 10000
  `;

  const rows = await chQuery<Record<string, unknown>>(sql, {
    app_key: appKey,
    metric,
    platform,
    from,
    to,
    event_name: eventName ?? ''
  });

  return res.json({
    ok: true,
    data: rows,
    meta: {
      appKey,
      metric,
      from,
      to,
      source,
      granularity,
      dims,
      platform: platform || null,
      eventName: eventName ?? null
    }
  });
});

export default router;
