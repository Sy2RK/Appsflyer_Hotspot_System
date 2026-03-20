import express, { Router } from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  clearAdminSessionCookie,
  isAdminAuthenticated,
  resolveAdminRedirectTarget,
  setAdminSessionCookie
} from '../../common/auth/adminBasicAuth.js';
import { env } from '@shared/config/env.js';

const router = Router();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const publicDir = path.join(__dirname, 'public');

router.use('/login-assets', express.static(publicDir, { index: false }));

router.get(['/login', '/login/'], (req, res) => {
  if (isAdminAuthenticated(req)) {
    return res.redirect(resolveAdminRedirectTarget(typeof req.query.next === 'string' ? req.query.next : '/ui'));
  }
  return res.sendFile(path.join(publicDir, 'login.html'));
});

router.post('/auth/login', (req, res) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const account = typeof body.account === 'string' ? body.account.trim() : '';
  const password = typeof body.password === 'string' ? body.password : '';
  const nextPath = resolveAdminRedirectTarget(typeof body.next === 'string' ? body.next : undefined);

  if (account !== env.adminBasicAuthUser || password !== env.adminBasicAuthPassword) {
    clearAdminSessionCookie(req, res);
    return res.status(401).json({ ok: false, error: 'invalid_credentials' });
  }

  setAdminSessionCookie(req, res);
  return res.json({ ok: true, redirect_to: nextPath });
});

router.post('/auth/logout', (req, res) => {
  clearAdminSessionCookie(req, res);
  return res.json({ ok: true });
});

export default router;
