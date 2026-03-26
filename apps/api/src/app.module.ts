import express from 'express';
import ingestRoutes from './modules/ingest/ingest.routes.js';
import metricsRoutes from './modules/metrics/metrics.routes.js';
import alertsRoutes from './modules/alerts/alerts.routes.js';
import rulesRoutes from './modules/rules/rules.routes.js';
import healthRoutes from './modules/health/health.routes.js';
import appsRoutes from './modules/apps.routes.js';
import pullRecordsRoutes from './modules/pullRecords/pullRecords.routes.js';
import keywordsRoutes from './modules/keywords/keywords.routes.js';
import budgetRoutes from './modules/budget/budget.routes.js';
import dailyBriefRoutes from './modules/dailyBrief/dailyBrief.routes.js';
import bitableExportsRoutes from './modules/bitableExports/bitableExports.routes.js';
import operationLogsRoutes from './modules/operationLogs/operationLogs.routes.js';
import asaKeywordsRoutes from './modules/asaKeywords/asaKeywords.routes.js';
import runtimeScheduleRoutes from './modules/runtimeSchedule/runtimeSchedule.routes.js';
import uiRoutes from './modules/ui/ui.routes.js';
import authRoutes from './modules/auth/auth.routes.js';
import { adminBasicAuthMiddleware, assertAdminAuthConfigured } from './common/auth/adminBasicAuth.js';
import { requestIdMiddleware } from './common/utils/request.js';
import { logger } from './common/logger/logger.js';

export function createApp(): express.Express {
  assertAdminAuthConfigured();
  const app = express();

  app.disable('x-powered-by');
  app.use(express.json({ limit: '1mb' }));
  app.use(requestIdMiddleware);

  app.use((req, _res, next) => {
    logger.info('request_received', {
      request_id: req.requestId,
      method: req.method,
      path: req.path
    });
    next();
  });

  app.use(ingestRoutes);
  app.use(healthRoutes);
  app.use(authRoutes);
  app.use(adminBasicAuthMiddleware());
  app.use(uiRoutes);
  app.use(appsRoutes);
  app.use(metricsRoutes);
  app.use(pullRecordsRoutes);
  app.use(keywordsRoutes);
  app.use(budgetRoutes);
  app.use(dailyBriefRoutes);
  app.use(bitableExportsRoutes);
  app.use(asaKeywordsRoutes);
  app.use(runtimeScheduleRoutes);
  app.use(operationLogsRoutes);
  app.use(alertsRoutes);
  app.use(rulesRoutes);

  app.use((error: Error, req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const bodyParseFailed =
      error instanceof SyntaxError && (error as Error & { type?: string }).type === 'entity.parse.failed';

    if (bodyParseFailed) {
      logger.warn('invalid_json_payload', {
        request_id: req.requestId,
        method: req.method,
        path: req.path
      });
      return res.status(400).json({ ok: false, error: 'invalid_json_payload' });
    }

    logger.error('unhandled_error', {
      request_id: req.requestId,
      error: error.message
    });

    res.status(500).json({ ok: false, error: 'internal_error' });
  });

  return app;
}
