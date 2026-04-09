import { createClient } from '@clickhouse/client';
import { env } from '@shared/config/env.js';
import { Router } from 'express';
import { Client as PostgresClient } from 'pg';
import { logger } from '../../common/logger/logger.js';
import { requestMetrics } from '../../common/utils/request.js';

const READINESS_TIMEOUT_MS = 3000;

type ReadinessStatus = 'ready' | 'timeout' | 'dependency_unavailable';

export interface DependencyProbeResult {
  ok: boolean;
  status: ReadinessStatus;
  durationMs: number;
}

interface HealthRouterDeps {
  requestMetrics: typeof requestMetrics;
  probePostgres: (timeoutMs: number) => Promise<DependencyProbeResult>;
  probeClickhouse: (timeoutMs: number) => Promise<DependencyProbeResult>;
}

function isTimeoutError(error: unknown): boolean {
  const message = String(error instanceof Error ? error.message : error || '')
    .trim()
    .toLowerCase();
  return (
    message.includes('timeout') ||
    message.includes('timed out') ||
    message.includes('query read timeout') ||
    message.includes('statement timeout') ||
    message.includes('abort')
  );
}

function buildProbeFailure(
  dependency: 'postgres' | 'clickhouse',
  startedAt: number,
  error: unknown,
  forcedTimeout = false
): DependencyProbeResult {
  const status: ReadinessStatus = forcedTimeout || isTimeoutError(error) ? 'timeout' : 'dependency_unavailable';
  logger.warn('readiness_probe_failed', {
    dependency,
    status,
    error: error instanceof Error ? error.message : String(error)
  });
  return {
    ok: false,
    status,
    durationMs: Date.now() - startedAt
  };
}

export async function probePostgresReadiness(timeoutMs = READINESS_TIMEOUT_MS): Promise<DependencyProbeResult> {
  const client = new PostgresClient({
    connectionString: env.postgresUrl,
    connectionTimeoutMillis: timeoutMs,
    statement_timeout: timeoutMs,
    query_timeout: timeoutMs
  });
  const startedAt = Date.now();
  try {
    await client.connect();
    await client.query('SELECT 1 AS ok');
    return {
      ok: true,
      status: 'ready',
      durationMs: Date.now() - startedAt
    };
  } catch (error) {
    return buildProbeFailure('postgres', startedAt, error);
  } finally {
    await client.end().catch(() => undefined);
  }
}

export async function probeClickhouseReadiness(timeoutMs = READINESS_TIMEOUT_MS): Promise<DependencyProbeResult> {
  const startedAt = Date.now();
  const controller = new AbortController();
  const client = createClient({
    url: `http://${env.clickhouse.host}:${env.clickhouse.port}`,
    username: env.clickhouse.user,
    password: env.clickhouse.password,
    database: env.clickhouse.database,
    request_timeout: timeoutMs,
    clickhouse_settings: {
      async_insert: 0
    }
  });
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const result = await client.ping({
      select: true,
      abort_signal: controller.signal
    });
    if (!result.success) {
      throw result.error;
    }
    return {
      ok: true,
      status: 'ready',
      durationMs: Date.now() - startedAt
    };
  } catch (error) {
    return buildProbeFailure('clickhouse', startedAt, error, controller.signal.aborted);
  } finally {
    clearTimeout(timer);
    await client.close().catch(() => undefined);
  }
}

const defaultDeps: HealthRouterDeps = {
  requestMetrics,
  probePostgres: probePostgresReadiness,
  probeClickhouse: probeClickhouseReadiness
};

export function createHealthRouter(deps: HealthRouterDeps = defaultDeps): Router {
  const router = Router();

  router.get('/health', (_req, res) => {
    const avgInsertLatency =
      deps.requestMetrics.clickhouseInsertLatencyMs.length === 0
        ? 0
        : deps.requestMetrics.clickhouseInsertLatencyMs.reduce((acc, n) => acc + n, 0) /
          deps.requestMetrics.clickhouseInsertLatencyMs.length;

    res.json({
      ok: true,
      uptime_sec: process.uptime(),
      metrics: {
        push_ingest_qps_counter: deps.requestMetrics.totalPushRequests,
        push_error_counter: deps.requestMetrics.pushErrors,
        clickhouse_insert_avg_ms: Number(avgInsertLatency.toFixed(2))
      },
      now: new Date().toISOString()
    });
  });

  router.get('/ready', async (_req, res) => {
    const [postgres, clickhouse] = await Promise.all([
      deps.probePostgres(READINESS_TIMEOUT_MS),
      deps.probeClickhouse(READINESS_TIMEOUT_MS)
    ]);
    const ready = postgres.ok && clickhouse.ok;

    res.status(ready ? 200 : 503).json({
      ok: ready,
      checks: {
        postgres: {
          ok: postgres.ok,
          status: postgres.status,
          duration_ms: postgres.durationMs
        },
        clickhouse: {
          ok: clickhouse.ok,
          status: clickhouse.status,
          duration_ms: clickhouse.durationMs
        }
      },
      now: new Date().toISOString()
    });
  });

  return router;
}

export default createHealthRouter();
