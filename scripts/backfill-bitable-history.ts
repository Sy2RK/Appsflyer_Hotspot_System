import { logger } from '@api/common/logger/logger.js';
import { runHistoricalBitableExportBackfill } from '@shared/utils/bitableExport.js';

async function main(): Promise<void> {
  const result = await runHistoricalBitableExportBackfill('delivery_actions', logger);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);

  if (result.failed_dates.length > 0) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack || error.message : String(error)}\n`);
  process.exit(1);
});
