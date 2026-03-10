import { env } from '@shared/config/env.js';
import { chExec } from '@shared/utils/clickhouse.js';
import { logger } from '@api/common/logger/logger.js';
import { addHours, floorToHour, toCHDateTime } from '@shared/utils/time.js';
import { writeOperationLog } from '@shared/utils/operationLog.js';

function buildAggregationSQL(start: Date, end: Date, version: number): string {
  const startStr = toCHDateTime(start);
  const endStr = toCHDateTime(end);

  return `
INSERT INTO metrics_hourly
SELECT * FROM
(
  -- revenue total rows (detector default reads these)
  SELECT
    toStartOfHour(event_time) AS hour,
    app_key,
    'revenue' AS metric,
    sum(revenue) AS value,
    '__all__' AS event_name,
    '__all__' AS platform,
    'unknown' AS attribution,
    'unknown' AS event_type,
    '__all__' AS media_source,
    '__all__' AS country,
    '__all__' AS campaign,
    ${version} AS version
  FROM raw_events
  WHERE event_time >= toDateTime('${startStr}')
    AND event_time < toDateTime('${endStr}')
  GROUP BY hour, app_key

  UNION ALL

  -- event_count total rows per event_name
  SELECT
    toStartOfHour(event_time) AS hour,
    app_key,
    'event_count' AS metric,
    toFloat64(count()) AS value,
    if(empty(event_name), 'unknown', event_name) AS event_name,
    '__all__' AS platform,
    'unknown' AS attribution,
    'unknown' AS event_type,
    '__all__' AS media_source,
    '__all__' AS country,
    '__all__' AS campaign,
    ${version} AS version
  FROM raw_events
  WHERE event_time >= toDateTime('${startStr}')
    AND event_time < toDateTime('${endStr}')
  GROUP BY hour, app_key, event_name

  UNION ALL

  -- purchase_count total rows
  SELECT
    toStartOfHour(event_time) AS hour,
    app_key,
    'purchase_count' AS metric,
    toFloat64(count()) AS value,
    'purchase' AS event_name,
    '__all__' AS platform,
    'unknown' AS attribution,
    'unknown' AS event_type,
    '__all__' AS media_source,
    '__all__' AS country,
    '__all__' AS campaign,
    ${version} AS version
  FROM raw_events
  WHERE event_time >= toDateTime('${startStr}')
    AND event_time < toDateTime('${endStr}')
    AND event_name = 'purchase'
  GROUP BY hour, app_key

  UNION ALL

  -- revenue rows by drilldown dimensions
  SELECT
    toStartOfHour(event_time) AS hour,
    app_key,
    'revenue' AS metric,
    sum(revenue) AS value,
    '__all__' AS event_name,
    if(empty(platform), 'unknown', lowerUTF8(platform)) AS platform,
    attribution,
    event_type,
    if(empty(media_source), 'unknown', media_source) AS media_source,
    if(empty(country), 'unknown', country) AS country,
    if(empty(campaign), 'unknown', campaign) AS campaign,
    ${version} AS version
  FROM raw_events
  WHERE event_time >= toDateTime('${startStr}')
    AND event_time < toDateTime('${endStr}')
  GROUP BY hour, app_key, platform, attribution, event_type, media_source, country, campaign

  UNION ALL

  -- event_count rows by event_name + dimensions
  SELECT
    toStartOfHour(event_time) AS hour,
    app_key,
    'event_count' AS metric,
    toFloat64(count()) AS value,
    if(empty(event_name), 'unknown', event_name) AS event_name,
    if(empty(platform), 'unknown', lowerUTF8(platform)) AS platform,
    attribution,
    event_type,
    if(empty(media_source), 'unknown', media_source) AS media_source,
    if(empty(country), 'unknown', country) AS country,
    if(empty(campaign), 'unknown', campaign) AS campaign,
    ${version} AS version
  FROM raw_events
  WHERE event_time >= toDateTime('${startStr}')
    AND event_time < toDateTime('${endStr}')
  GROUP BY hour, app_key, event_name, platform, attribution, event_type, media_source, country, campaign

  UNION ALL

  -- purchase_count rows by dimensions
  SELECT
    toStartOfHour(event_time) AS hour,
    app_key,
    'purchase_count' AS metric,
    toFloat64(count()) AS value,
    'purchase' AS event_name,
    if(empty(platform), 'unknown', lowerUTF8(platform)) AS platform,
    attribution,
    event_type,
    if(empty(media_source), 'unknown', media_source) AS media_source,
    if(empty(country), 'unknown', country) AS country,
    if(empty(campaign), 'unknown', campaign) AS campaign,
    ${version} AS version
  FROM raw_events
  WHERE event_time >= toDateTime('${startStr}')
    AND event_time < toDateTime('${endStr}')
    AND event_name = 'purchase'
  GROUP BY hour, app_key, platform, attribution, event_type, media_source, country, campaign
)
  `;
}

async function runOnce(): Promise<void> {
  const start = Date.now();
  const endHour = addHours(floorToHour(new Date()), 1);
  const startHour = addHours(endHour, -env.aggregatorLookbackHours);
  const version = Date.now();

  logger.info('aggregator_started', {
    start_hour: startHour.toISOString(),
    end_hour: endHour.toISOString(),
    version
  });

  const sql = buildAggregationSQL(startHour, endHour, version);
  await chExec(sql);

  logger.info('aggregator_finished', {
    duration_ms: Date.now() - start,
    start_hour: startHour.toISOString(),
    end_hour: endHour.toISOString(),
    version
  });

  await writeOperationLog(
    {
      source: 'worker.aggregator',
      action: 'scheduled_aggregate_cycle',
      target_type: 'aggregator',
      target_key: String(version),
      status: 'success',
      summary: '定时小时聚合完成',
      detail_json: {
        duration_ms: Date.now() - start,
        start_hour: startHour.toISOString(),
        end_hour: endHour.toISOString(),
        version
      }
    },
    logger
  );
}

let running = false;

async function tick(): Promise<void> {
  if (running) {
    logger.warn('aggregator_skip_overlap');
    return;
  }

  running = true;
  try {
    await runOnce();
  } catch (error) {
    logger.error('aggregator_failed', {
      error: error instanceof Error ? error.message : String(error)
    });
    await writeOperationLog(
      {
        source: 'worker.aggregator',
        action: 'scheduled_aggregate_cycle',
        target_type: 'aggregator',
        target_key: 'hourly',
        status: 'failed',
        summary: '定时小时聚合失败',
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
  }, env.aggregatorIntervalMs);
}

bootstrap().catch((error) => {
  logger.error('aggregator_bootstrap_failed', {
    error: error instanceof Error ? error.message : String(error)
  });
  process.exit(1);
});
