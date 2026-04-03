import { env } from '@shared/config/env.js';
import { createGuruMcpApp, closeGuruMcpSessions } from './server.js';
import { logger } from './logger.js';

async function bootstrap(): Promise<void> {
  const app = createGuruMcpApp();

  const server = app.listen(env.mcp.port, env.mcp.bindHost, () => {
    logger.info('guru_mcp_started', {
      port: env.mcp.port,
      host: env.mcp.bindHost,
      node_env: env.nodeEnv,
      timezone: env.timezone
    });
  });

  const shutdown = async () => {
    logger.info('guru_mcp_shutdown_started');
    await closeGuruMcpSessions();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
    process.exit(0);
  };

  process.on('SIGINT', () => {
    void shutdown();
  });
  process.on('SIGTERM', () => {
    void shutdown();
  });
}

bootstrap().catch((error) => {
  logger.error('guru_mcp_bootstrap_failed', {
    error: error instanceof Error ? error.message : String(error)
  });
  process.exit(1);
});
