export type LogLevel = 'info' | 'warn' | 'error';

function write(level: LogLevel, message: string, context?: Record<string, unknown>): void {
  const line = {
    ts: new Date().toISOString(),
    level,
    message,
    ...context
  };
  const str = JSON.stringify(line);
  if (level === 'error') {
    console.error(str);
    return;
  }
  if (level === 'warn') {
    console.warn(str);
    return;
  }
  console.log(str);
}

export const logger = {
  info: (message: string, context?: Record<string, unknown>) => write('info', message, context),
  warn: (message: string, context?: Record<string, unknown>) => write('warn', message, context),
  error: (message: string, context?: Record<string, unknown>) => write('error', message, context)
};
