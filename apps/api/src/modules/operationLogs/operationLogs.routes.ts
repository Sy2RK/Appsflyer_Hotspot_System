import { Router } from 'express';
import { listOperationLogs } from '@shared/utils/repositories.js';

const router = Router();

router.get('/api/operation-logs', async (req, res, next) => {
  try {
    const source = typeof req.query.source === 'string' ? req.query.source.trim() : '';
    const statusRaw = typeof req.query.status === 'string' ? req.query.status.trim() : '';
    const limitRaw = Number(req.query.limit);
    const status =
      statusRaw === 'success' || statusRaw === 'failed' || statusRaw === 'skipped' || statusRaw === 'info'
        ? statusRaw
        : undefined;
    const limit = Number.isFinite(limitRaw) ? Math.min(200, Math.max(1, Math.floor(limitRaw))) : 50;

    const rows = await listOperationLogs({
      source: source || undefined,
      status,
      limit
    });

    return res.json({
      ok: true,
      data: rows
    });
  } catch (error) {
    return next(error);
  }
});

export default router;
