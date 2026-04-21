import http from 'node:http';
import dotenv from 'dotenv';

dotenv.config();

const DEFAULT_TOKEN = 'local-dev-appsflyer-egress-relay';
const host = process.env.APPSFLYER_EGRESS_RELAY_HOST?.trim() || '127.0.0.1';
const port = Number(process.env.APPSFLYER_EGRESS_RELAY_PORT || 3188);
const relayToken = process.env.APPSFLYER_EGRESS_RELAY_TOKEN || DEFAULT_TOKEN;
const maxBodyBytes = Number(process.env.APPSFLYER_EGRESS_RELAY_MAX_BODY_BYTES || 2 * 1024 * 1024);

type RelayRequest = {
  url?: unknown;
  method?: unknown;
  headers?: unknown;
  body?: unknown;
  timeoutMs?: unknown;
  label?: unknown;
};

function sendJson(response: http.ServerResponse, status: number, payload: unknown): void {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  response.end(JSON.stringify(payload));
}

function safeString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function assertAppsflyerUrl(rawUrl: unknown): string {
  const value = safeString(rawUrl).trim();
  const parsed = new URL(value);
  const hostname = parsed.hostname.toLowerCase();
  if (parsed.protocol !== 'https:') {
    throw new Error('only_https_targets_allowed');
  }
  if (hostname !== 'appsflyer.com' && !hostname.endsWith('.appsflyer.com')) {
    throw new Error('only_appsflyer_targets_allowed');
  }
  return parsed.toString();
}

function normalizeMethod(rawMethod: unknown, hasBody: boolean): 'GET' | 'POST' | 'HEAD' {
  const method = safeString(rawMethod).toUpperCase();
  if (method === 'GET' || method === 'POST' || method === 'HEAD') {
    return method;
  }
  return hasBody ? 'POST' : 'GET';
}

function normalizeHeaders(rawHeaders: unknown): Record<string, string> {
  const headers: Record<string, string> = {};
  if (!rawHeaders || typeof rawHeaders !== 'object' || Array.isArray(rawHeaders)) {
    return headers;
  }
  for (const [key, value] of Object.entries(rawHeaders)) {
    const lowerKey = key.toLowerCase();
    if (['connection', 'content-length', 'host', 'transfer-encoding'].includes(lowerKey)) {
      continue;
    }
    if (typeof value === 'string') {
      headers[key] = value;
    }
  }
  return headers;
}

function normalizeTimeout(rawTimeoutMs: unknown): number {
  const parsed = Number(rawTimeoutMs);
  if (!Number.isFinite(parsed)) {
    return 20_000;
  }
  return Math.max(1000, Math.min(120_000, Math.floor(parsed)));
}

async function readRequestBody(request: http.IncomingMessage): Promise<string> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    size += buffer.byteLength;
    if (size > maxBodyBytes) {
      throw new Error('request_body_too_large');
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function isAuthorized(request: http.IncomingMessage): boolean {
  if (!relayToken) {
    return false;
  }
  const authorization = request.headers.authorization || '';
  const headerToken = request.headers['x-relay-token'];
  return (
    authorization === `Bearer ${relayToken}` ||
    (typeof headerToken === 'string' && headerToken === relayToken)
  );
}

async function handleFetch(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
  if (!isAuthorized(request)) {
    sendJson(response, 401, { error: 'unauthorized' });
    return;
  }

  const rawBody = await readRequestBody(request);
  const input = JSON.parse(rawBody || '{}') as RelayRequest;
  const targetUrl = assertAppsflyerUrl(input.url);
  const body = typeof input.body === 'string' ? input.body : undefined;
  const method = normalizeMethod(input.method, body !== undefined);
  const headers = normalizeHeaders(input.headers);
  const timeoutMs = normalizeTimeout(input.timeoutMs);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const upstream = await fetch(targetUrl, {
      method,
      headers,
      body: method === 'HEAD' ? undefined : body,
      signal: controller.signal
    });
    const upstreamBody = method === 'HEAD' ? '' : await upstream.text().catch(() => '');
    sendJson(response, 200, {
      status: upstream.status,
      ok: upstream.ok,
      body: upstreamBody
    });
  } catch (error) {
    sendJson(response, 200, {
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    });
  } finally {
    clearTimeout(timer);
  }
}

const server = http.createServer((request, response) => {
  void (async () => {
    try {
      if (request.method === 'GET' && request.url === '/healthz') {
        sendJson(response, 200, { ok: true });
        return;
      }
      if (request.method === 'POST' && request.url === '/fetch') {
        await handleFetch(request, response);
        return;
      }
      sendJson(response, 404, { error: 'not_found' });
    } catch (error) {
      sendJson(response, 400, {
        error: error instanceof Error ? error.message : String(error)
      });
    }
  })();
});

server.listen(port, host, () => {
  console.log(
    JSON.stringify({
      event: 'appsflyer_egress_relay_listening',
      host,
      port,
      token_configured: Boolean(relayToken),
      using_default_token: relayToken === DEFAULT_TOKEN
    })
  );
});

function shutdown(): void {
  server.close(() => process.exit(0));
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
