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
  }
): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1, Math.floor(input.timeoutMs)));

  try {
    const response = await fetch(url, {
      headers: input.headers,
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
