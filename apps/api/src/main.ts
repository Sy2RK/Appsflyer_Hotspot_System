import { createApp } from './app.module.js';
import { env } from '@shared/config/env.js';
import { logger } from './common/logger/logger.js';

async function bootstrap(): Promise<void> {
  const app = createApp();

  app.listen(env.port, () => {
    logger.info('api_started', {
      port: env.port,
      node_env: env.nodeEnv,
      timezone: env.timezone
    });
  });
}

bootstrap().catch((error) => {
  logger.error('api_bootstrap_failed', {
    error: error instanceof Error ? error.message : String(error)
  });
  process.exit(1);
});
