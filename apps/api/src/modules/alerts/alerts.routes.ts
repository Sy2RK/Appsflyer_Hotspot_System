import { Router } from 'express';
import { getAlertById, listAlerts } from '@shared/utils/repositories.js';

const router = Router();

router.get('/api/alerts', async (req, res) => {
  const appKey = typeof req.query.appKey === 'string' ? req.query.appKey : undefined;
  const status =
    req.query.status === 'open' || req.query.status === 'resolved'
      ? (req.query.status as 'open' | 'resolved')
      : undefined;
  const severity =
    req.query.severity === 'P0' || req.query.severity === 'P1' || req.query.severity === 'P2'
      ? (req.query.severity as 'P0' | 'P1' | 'P2')
      : undefined;
  const from = typeof req.query.from === 'string' ? req.query.from : undefined;
  const to = typeof req.query.to === 'string' ? req.query.to : undefined;

  const data = await listAlerts({ appKey, status, severity, from, to });
  res.json({ ok: true, data });
});

router.get('/api/alerts/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (Number.isNaN(id)) {
    return res.status(400).json({ ok: false, error: 'invalid_alert_id' });
  }

  const alert = await getAlertById(id);
  if (!alert) {
    return res.status(404).json({ ok: false, error: 'alert_not_found' });
  }

  return res.json({ ok: true, data: alert });
});

export default router;
