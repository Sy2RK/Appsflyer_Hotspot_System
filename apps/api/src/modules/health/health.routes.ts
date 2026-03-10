import { Router } from 'express';
import { requestMetrics } from '../../common/utils/request.js';

const router = Router();

router.get('/health', (_req, res) => {
  const avgInsertLatency =
    requestMetrics.clickhouseInsertLatencyMs.length === 0
      ? 0
      : requestMetrics.clickhouseInsertLatencyMs.reduce((acc, n) => acc + n, 0) /
        requestMetrics.clickhouseInsertLatencyMs.length;

  res.json({
    ok: true,
    uptime_sec: process.uptime(),
    metrics: {
      push_ingest_qps_counter: requestMetrics.totalPushRequests,
      push_error_counter: requestMetrics.pushErrors,
      clickhouse_insert_avg_ms: Number(avgInsertLatency.toFixed(2))
    },
    now: new Date().toISOString()
  });
});

export default router;
