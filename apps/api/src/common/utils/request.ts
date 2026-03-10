import crypto from 'crypto';
import { Request, Response, NextFunction } from 'express';

export interface RequestMetrics {
  totalPushRequests: number;
  pushErrors: number;
  clickhouseInsertLatencyMs: number[];
}

export const requestMetrics: RequestMetrics = {
  totalPushRequests: 0,
  pushErrors: 0,
  clickhouseInsertLatencyMs: []
};

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
