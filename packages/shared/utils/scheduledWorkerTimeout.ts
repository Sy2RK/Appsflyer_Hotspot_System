export class ScheduledWorkerTimeoutError extends Error {
  readonly workerName: string;
  readonly timeoutMs: number;

  constructor(workerName: string, timeoutMs: number) {
    super(`${workerName}_runtime_timeout timeout_ms=${timeoutMs}`);
    this.name = 'ScheduledWorkerTimeoutError';
    this.workerName = workerName;
    this.timeoutMs = timeoutMs;
  }
}

export function isScheduledWorkerTimeoutError(error: unknown): error is ScheduledWorkerTimeoutError {
  return error instanceof ScheduledWorkerTimeoutError;
}

export async function withScheduledWorkerTimeout<T>(
  workerName: string,
  timeoutMs: number,
  work: () => Promise<T>
): Promise<T> {
  let timer: NodeJS.Timeout | null = null;
  try {
    return await Promise.race([
      work(),
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => {
          reject(new ScheduledWorkerTimeoutError(workerName, timeoutMs));
        }, Math.max(1, Math.floor(timeoutMs)));
        timer.unref?.();
      })
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}
