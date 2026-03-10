import { createOperationLog, CreateOperationLogInput } from './repositories.js';

interface LoggerLike {
  error?: (message: string, meta?: Record<string, unknown>) => void;
}

export async function writeOperationLog(
  input: CreateOperationLogInput,
  logger?: LoggerLike
): Promise<void> {
  try {
    await createOperationLog(input);
  } catch (error) {
    logger?.error?.('operation_log_write_failed', {
      source: input.source,
      action: input.action,
      error: error instanceof Error ? error.message : String(error)
    });
  }
}
