import { renewJobLock } from './repositories.js';

interface LoggerLike {
  warn: (message: string, context?: Record<string, unknown>) => void;
}

export interface JobLockHeartbeatOptions {
  lockName: string;
  ownerId: string;
  ttlMs: number;
  logger: LoggerLike;
  logPrefix: string;
  intervalMs?: number;
}

export function startJobLockHeartbeat(options: JobLockHeartbeatOptions): () => void {
  const heartbeatMs =
    options.intervalMs && options.intervalMs > 0
      ? Math.floor(options.intervalMs)
      : Math.max(30_000, Math.min(60_000, Math.floor(options.ttlMs / 3)));
  let stopped = false;
  let renewing = false;

  const timer = setInterval(async () => {
    if (stopped || renewing) {
      return;
    }
    renewing = true;
    try {
      const renewed = await renewJobLock(options.lockName, options.ownerId, options.ttlMs);
      if (!renewed) {
        options.logger.warn(`${options.logPrefix}_lock_heartbeat_lost`, {
          lock_name: options.lockName
        });
        stopped = true;
        clearInterval(timer);
      }
    } catch (error) {
      options.logger.warn(`${options.logPrefix}_lock_heartbeat_failed`, {
        lock_name: options.lockName,
        error: error instanceof Error ? error.message : String(error)
      });
    } finally {
      renewing = false;
    }
  }, heartbeatMs);

  timer.unref?.();

  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
