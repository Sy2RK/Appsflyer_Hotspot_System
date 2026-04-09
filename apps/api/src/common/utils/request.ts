import crypto from 'crypto';
import { Request, Response, NextFunction } from 'express';

export interface RequestMetrics {
  totalPushRequests: number;
  pushErrors: number;
  clickhouseInsertLatencyMs: number[];
}

const MAX_CLICKHOUSE_INSERT_LATENCY_SAMPLES = 500;

export const requestMetrics: RequestMetrics = {
  totalPushRequests: 0,
  pushErrors: 0,
  clickhouseInsertLatencyMs: []
};

export function recordClickhouseInsertLatency(ms: number): void {
  requestMetrics.clickhouseInsertLatencyMs.push(ms);
  if (requestMetrics.clickhouseInsertLatencyMs.length > MAX_CLICKHOUSE_INSERT_LATENCY_SAMPLES) {
    requestMetrics.clickhouseInsertLatencyMs.splice(
      0,
      requestMetrics.clickhouseInsertLatencyMs.length - MAX_CLICKHOUSE_INSERT_LATENCY_SAMPLES
    );
  }
}

export function requestIdMiddleware(req: Request, res: Response, next: NextFunction): void {
  const requestId = (req.headers['x-request-id'] as string) ?? crypto.randomUUID();
  req.requestId = requestId;
  res.setHeader('x-request-id', requestId);
  next();
}

declare global {
  namespace Express {
    interface Request {
      requestId?: string;
    }
  }
}
