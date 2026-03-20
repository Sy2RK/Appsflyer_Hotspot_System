import crypto from 'crypto';
import type { Request, Response, NextFunction, RequestHandler } from 'express';
import { env } from '@shared/config/env.js';

const ADMIN_SESSION_COOKIE = 'hotspot_admin_session';
const ADMIN_SESSION_MAX_AGE_SECONDS = 12 * 60 * 60;

function parseBasicAuthorization(headerValue: string | undefined): { user: string; password: string } | null {
  const header = String(headerValue || '').trim();
  if (!header.startsWith('Basic ')) {
    return null;
  }

  try {
    const decoded = Buffer.from(header.slice('Basic '.length), 'base64').toString('utf8');
    const separatorIndex = decoded.indexOf(':');
    if (separatorIndex < 0) {
      return null;
    }
    return {
      user: decoded.slice(0, separatorIndex),
      password: decoded.slice(separatorIndex + 1)
    };
  } catch {
    return null;
  }
}

function parseCookieValue(headerValue: string | undefined, cookieName: string): string {
  const raw = String(headerValue || '');
  const parts = raw.split(';');
  for (const part of parts) {
    const [name, ...rest] = part.trim().split('=');
    if (name === cookieName) {
      return decodeURIComponent(rest.join('='));
    }
  }
  return '';
}

function buildSessionToken(user: string, password: string): string {
  return crypto.createHash('sha256').update(`${user}\u0000${password}`).digest('hex');
}

function isSafeRedirectTarget(raw: string | undefined): boolean {
  if (!raw) return false;
  return raw.startsWith('/') && !raw.startsWith('//') && !raw.startsWith('/login') && !raw.startsWith('/auth/');
}

export function resolveAdminRedirectTarget(raw: string | undefined): string {
  return isSafeRedirectTarget(raw) ? String(raw) : '/ui';
}

export function isAdminAuthenticated(req: Request): boolean {
  const parsed = parseBasicAuthorization(req.header('authorization'));
  if (parsed && parsed.user === env.adminBasicAuthUser && parsed.password === env.adminBasicAuthPassword) {
    return true;
  }

  const cookieToken = parseCookieValue(req.header('cookie'), ADMIN_SESSION_COOKIE);
  if (!cookieToken) {
    return false;
  }

  return cookieToken === buildSessionToken(env.adminBasicAuthUser, env.adminBasicAuthPassword);
}

export function setAdminSessionCookie(res: Response): void {
  const secure = env.nodeEnv === 'production';
  const value = encodeURIComponent(buildSessionToken(env.adminBasicAuthUser, env.adminBasicAuthPassword));
  res.append(
    'Set-Cookie',
    `${ADMIN_SESSION_COOKIE}=${value}; Max-Age=${ADMIN_SESSION_MAX_AGE_SECONDS}; Path=/; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`
  );
}

export function clearAdminSessionCookie(res: Response): void {
  const secure = env.nodeEnv === 'production';
  res.append(
    'Set-Cookie',
    `${ADMIN_SESSION_COOKIE}=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`
  );
}

export function assertAdminAuthConfigured(): void {
  if (env.nodeEnv !== 'production') {
    return;
  }
  if (!env.adminBasicAuthUser || !env.adminBasicAuthPassword) {
    throw new Error('Missing required env for production control-plane auth: ADMIN_BASIC_AUTH_USER / ADMIN_BASIC_AUTH_PASSWORD');
  }
}

export function adminBasicAuthMiddleware(): RequestHandler {
  if (!env.adminBasicAuthUser || !env.adminBasicAuthPassword) {
    return (_req: Request, _res: Response, next: NextFunction) => next();
  }

  return (req: Request, res: Response, next: NextFunction) => {
    if (isAdminAuthenticated(req)) {
      return next();
    }

    const wantsHtml =
      req.method === 'GET' &&
      (req.accepts('html') === 'html' || req.path === '/ui' || req.path === '/ui/' || req.path.startsWith('/ui/'));

    if (wantsHtml) {
      const nextPath = encodeURIComponent(req.originalUrl || '/ui');
      return res.redirect(`/login?next=${nextPath}`);
    }

    return res.status(401).json({ ok: false, error: 'unauthorized' });
  };
}
