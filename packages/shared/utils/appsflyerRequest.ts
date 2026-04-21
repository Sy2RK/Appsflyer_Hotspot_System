import { env } from '@shared/config/env.js';

export type AppsflyerRequestFailureKind =
  | 'timeout'
  | 'network'
  | 'rate_limit'
  | 'auth'
  | 'not_found'
  | 'invalid_request'
  | 'server'
  | 'unknown';

export class AppsflyerRequestError extends Error {
  readonly kind: AppsflyerRequestFailureKind;
  readonly status: number | null;
  readonly bodyPreview: string | null;
  readonly immediateRetryable: boolean;
  readonly scheduledRetryable: boolean;

  constructor(input: {
    message: string;
    kind: AppsflyerRequestFailureKind;
    status?: number | null;
    bodyPreview?: string | null;
    immediateRetryable: boolean;
    scheduledRetryable: boolean;
  }) {
    super(input.message);
    this.name = 'AppsflyerRequestError';
    this.kind = input.kind;
    this.status = input.status ?? null;
    this.bodyPreview = input.bodyPreview ?? null;
    this.immediateRetryable = input.immediateRetryable;
    this.scheduledRetryable = input.scheduledRetryable;
  }
}

function bodyPreview(body: string): string {
  return String(body || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200);
}

type AppsflyerRelayResponse = {
  status?: number;
  ok?: boolean;
  body?: string;
  error?: string;
};

function isRateLimitBody(status: number, body: string): boolean {
  const lower = body.toLowerCase();
  return status === 429 || (status === 403 && lower.includes('limit reached for daily-report'));
}

export function classifyAppsflyerHttpFailure(
  label: string,
  status: number,
  body: string
): AppsflyerRequestError {
  const preview = bodyPreview(body);
  const lower = preview.toLowerCase();

  let kind: AppsflyerRequestFailureKind = 'unknown';
  let immediateRetryable = false;
  let scheduledRetryable = false;

  if (status === 408) {
    kind = 'timeout';
    immediateRetryable = true;
    scheduledRetryable = true;
  } else if (isRateLimitBody(status, preview)) {
    kind = 'rate_limit';
    immediateRetryable = false;
    scheduledRetryable = true;
  } else if (status === 401 || status === 403) {
    kind = 'auth';
  } else if (status === 404) {
    kind = 'not_found';
  } else if (status === 400 || status === 422) {
    kind = 'invalid_request';
  } else if (status >= 500) {
    kind = 'server';
    immediateRetryable = true;
    scheduledRetryable = true;
  } else if (lower.includes('temporarily unavailable')) {
    kind = 'server';
    immediateRetryable = true;
    scheduledRetryable = true;
  }

  return new AppsflyerRequestError({
    message: preview ? `${label}_failed status=${status} body=${preview}` : `${label}_failed status=${status}`,
    kind,
    status,
    bodyPreview: preview || null,
    immediateRetryable,
    scheduledRetryable
  });
}

export function classifyAppsflyerTransportFailure(
  label: string,
  error: unknown,
  timeoutMs: number
): AppsflyerRequestError {
  const name = error instanceof Error ? error.name : '';
  const rawMessage = error instanceof Error ? error.message : String(error);
  const message = String(rawMessage || '').trim();
  const lower = message.toLowerCase();
  const isTimeout =
    name === 'AbortError' ||
    lower.includes('timeout') ||
    lower.includes('timed out') ||
    lower.includes('aborted');

  if (isTimeout) {
    return new AppsflyerRequestError({
      message: `${label}_timeout timeout_ms=${timeoutMs}`,
      kind: 'timeout',
      immediateRetryable: true,
      scheduledRetryable: true
    });
  }

  return new AppsflyerRequestError({
    message: `${label}_network_failed ${message || 'fetch_failed'}`.trim(),
    kind: 'network',
    immediateRetryable: true,
    scheduledRetryable: true
  });
}

export async function fetchAppsflyerText(
  url: string,
  input: {
    headers: Record<string, string>;
    timeoutMs: number;
    label: string;
    method?: 'GET' | 'POST';
    body?: string;
  }
): Promise<string> {
  if (env.appsflyerEgressRelayUrl) {
    return fetchAppsflyerTextViaRelay(url, input);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1, Math.floor(input.timeoutMs)));

  try {
    const response = await fetch(url, {
      method: input.method ?? (input.body ? 'POST' : 'GET'),
      headers: input.headers,
      body: input.body,
      signal: controller.signal
    });
    const body = await response.text().catch(() => '');
    if (!response.ok) {
      throw classifyAppsflyerHttpFailure(input.label, response.status, body);
    }
    return body;
  } catch (error) {
    if (error instanceof AppsflyerRequestError) {
      throw error;
    }
    throw classifyAppsflyerTransportFailure(input.label, error, input.timeoutMs);
  } finally {
    clearTimeout(timer);
  }
}

async function fetchAppsflyerTextViaRelay(
  url: string,
  input: {
    headers: Record<string, string>;
    timeoutMs: number;
    label: string;
    method?: 'GET' | 'POST';
    body?: string;
  }
): Promise<string> {
  const controller = new AbortController();
  const relayTimeoutMs = Math.max(1, Math.floor(input.timeoutMs)) + 5000;
  const timer = setTimeout(() => controller.abort(), relayTimeoutMs);

  try {
    const relayHeaders: Record<string, string> = {
      'Content-Type': 'application/json'
    };
    if (env.appsflyerEgressRelayToken) {
      relayHeaders.Authorization = `Bearer ${env.appsflyerEgressRelayToken}`;
    }

    const response = await fetch(env.appsflyerEgressRelayUrl, {
      method: 'POST',
      headers: relayHeaders,
      body: JSON.stringify({
        url,
        method: input.method ?? (input.body ? 'POST' : 'GET'),
        headers: input.headers,
        body: input.body,
        timeoutMs: input.timeoutMs,
        label: input.label
      }),
      signal: controller.signal
    });
    const raw = await response.text().catch(() => '');
    if (!response.ok) {
      throw new AppsflyerRequestError({
        message: `${input.label}_relay_failed status=${response.status} body=${bodyPreview(raw) || 'empty'}`,
        kind: response.status === 408 ? 'timeout' : 'network',
        status: response.status,
        bodyPreview: bodyPreview(raw) || null,
        immediateRetryable: true,
        scheduledRetryable: true
      });
    }

    let payload: AppsflyerRelayResponse;
    try {
      payload = JSON.parse(raw) as AppsflyerRelayResponse;
    } catch {
      throw new Error(`${input.label}_relay_invalid_json`);
    }

    if (payload.error) {
      throw new Error(`${input.label}_relay_upstream_failed ${payload.error}`);
    }
    if (typeof payload.status !== 'number') {
      throw new Error(`${input.label}_relay_missing_status`);
    }

    const body = String(payload.body ?? '');
    if (!payload.ok) {
      throw classifyAppsflyerHttpFailure(input.label, payload.status, body);
    }
    return body;
  } catch (error) {
    if (error instanceof AppsflyerRequestError) {
      throw error;
    }
    throw classifyAppsflyerTransportFailure(input.label, error, relayTimeoutMs);
  } finally {
    clearTimeout(timer);
  }
}
