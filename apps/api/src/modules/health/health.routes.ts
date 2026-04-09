import { Router } from 'express';
import { chQuery } from '../../common/clickhouse/client.js';
import { pgQuery } from '../../common/postgres/client.js';
import { requestMetrics } from '../../common/utils/request.js';

const router = Router();
const READINESS_TIMEOUT_MS = 3000;

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label}_timeout`)), timeoutMs);
    promise
      .then((value) => {
        clearTimeout(timer);
        resolve(value);
      })
      .catch((error) => {
        clearTimeout(timer);
        reject(error);
      });
  });
}

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

router.get('/ready', async (_req, res) => {
  const checks = await Promise.allSettled([
    withTimeout(pgQuery<{ ok: number }>('SELECT 1 AS ok'), READINESS_TIMEOUT_MS, 'postgres'),
    withTimeout(chQuery<{ ok: number }>('SELECT 1 AS ok'), READINESS_TIMEOUT_MS, 'clickhouse')
  ]);

  const postgresCheck = checks[0];
  const clickhouseCheck = checks[1];
  const postgresReady = postgresCheck.status === 'fulfilled';
  const clickhouseReady = clickhouseCheck.status === 'fulfilled';
  const ready = postgresReady && clickhouseReady;

  res.status(ready ? 200 : 503).json({
    ok: ready,
    checks: {
      postgres: postgresReady
        ? { ok: true }
        : {
            ok: false,
            error: postgresCheck.reason instanceof Error ? postgresCheck.reason.message : String(postgresCheck.reason)
          },
      clickhouse: clickhouseReady
        ? { ok: true }
        : {
            ok: false,
            error: clickhouseCheck.reason instanceof Error ? clickhouseCheck.reason.message : String(clickhouseCheck.reason)
          }
    },
    now: new Date().toISOString()
  });
});

export default router;
