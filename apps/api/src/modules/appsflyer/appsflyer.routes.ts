import { Router } from 'express';
import { AF_METRIC_SCOPE_REGISTRY } from '@shared/utils/afMetricScopes.js';
import {
  buildAfOfficialBatchSnapshot,
  listAfOfficialSnapshots
} from '@shared/utils/appsflyerOfficialSnapshots.js';
import type { AfMetricScope, AfSourceSurface } from '@shared/utils/afMetricScopes.js';

const router = Router();

function cleanText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function isMetricScope(value: string): value is AfMetricScope {
  return Object.prototype.hasOwnProperty.call(AF_METRIC_SCOPE_REGISTRY, value);
}

function isSourceSurface(value: string): value is AfSourceSurface {
  return ['master_pivot', 'daily_report', 'cohort_api', 'raw_realtime', 'system_derived'].includes(value);
}

function isDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function toLimit(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return 100;
  }
  return Math.min(500, Math.max(1, Math.floor(parsed)));
}

router.get('/api/appsflyer/metric-scopes', (_req, res) => {
  return res.json({
    ok: true,
    data: Object.values(AF_METRIC_SCOPE_REGISTRY)
  });
});

router.get('/api/appsflyer/snapshots', async (req, res, next) => {
  try {
    const metricScope = cleanText(req.query.metricScope);
    const sourceSurface = cleanText(req.query.sourceSurface);
    const windowFrom = cleanText(req.query.windowFrom || req.query.from);
    const windowTo = cleanText(req.query.windowTo || req.query.to);
    if (metricScope && !isMetricScope(metricScope)) {
      return res.status(400).json({ ok: false, error: 'invalid_metric_scope' });
    }
    if (sourceSurface && !isSourceSurface(sourceSurface)) {
      return res.status(400).json({ ok: false, error: 'invalid_source_surface' });
    }
    if (windowFrom && !isDate(windowFrom)) {
      return res.status(400).json({ ok: false, error: 'invalid_window_from' });
    }
    if (windowTo && !isDate(windowTo)) {
      return res.status(400).json({ ok: false, error: 'invalid_window_to' });
    }
    const rows = await listAfOfficialSnapshots({
      metricScope: metricScope ? (metricScope as AfMetricScope) : undefined,
      sourceSurface: sourceSurface ? (sourceSurface as AfSourceSurface) : undefined,
      sourceApi: cleanText(req.query.sourceApi) || undefined,
      appKey: cleanText(req.query.appKey) || undefined,
      platform: cleanText(req.query.platform) || undefined,
      windowFrom: windowFrom || undefined,
      windowTo: windowTo || undefined,
      limit: toLimit(req.query.limit)
    });
    return res.json({ ok: true, data: rows });
  } catch (error) {
    return next(error);
  }
});

router.get('/api/appsflyer/snapshots/batch', async (req, res, next) => {
  try {
    const metricScope = cleanText(req.query.metricScope);
    const sourceSurface = cleanText(req.query.sourceSurface);
    const windowFrom = cleanText(req.query.windowFrom || req.query.from);
    const windowTo = cleanText(req.query.windowTo || req.query.to);
    if (!isMetricScope(metricScope)) {
      return res.status(400).json({ ok: false, error: 'invalid_metric_scope' });
    }
    if (!isSourceSurface(sourceSurface)) {
      return res.status(400).json({ ok: false, error: 'invalid_source_surface' });
    }
    if (!isDate(windowFrom) || !isDate(windowTo)) {
      return res.status(400).json({ ok: false, error: 'invalid_window' });
    }
    const snapshot = await buildAfOfficialBatchSnapshot({
      metricScope,
      sourceSurface,
      windowFrom,
      windowTo,
      timezone: cleanText(req.query.timezone) || undefined,
      currency: cleanText(req.query.currency) || undefined,
      appKey: cleanText(req.query.appKey) || undefined,
      platform: cleanText(req.query.platform) || undefined
    });
    return res.json({ ok: true, data: snapshot });
  } catch (error) {
    return next(error);
  }
});

export default router;
