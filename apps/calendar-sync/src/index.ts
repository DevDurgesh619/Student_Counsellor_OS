import { loadEnv } from '@wgc/config';
import { logger } from './logger.js';
import { processOne } from './worker.js';

const TICK_MS = 5_000;

async function loop() {
  const env = loadEnv();
  if (!env.WGC_CALENDAR_SYNC_ENABLED) {
    logger.info('Calendar sync disabled via WGC_CALENDAR_SYNC_ENABLED=false; idling');
    return;
  }
  if (
    !env.WGC_GOOGLE_CALENDAR_CLIENT_ID ||
    !env.WGC_GOOGLE_CALENDAR_CLIENT_SECRET ||
    !env.WGC_GOOGLE_CALENDAR_REDIRECT_URI
  ) {
    logger.warn('Google Calendar OAuth env vars missing; idling');
    return;
  }

  logger.info('Calendar sync worker starting; polling every %dms', TICK_MS);
  // Drain loop: process as long as outbox has pending rows, then sleep.
  // SIGTERM/SIGINT handled below.
  while (!shuttingDown) {
    try {
      const did = await processOne();
      if (!did) await sleep(TICK_MS);
    } catch (err) {
      logger.error({ err }, 'tick failed; backing off');
      await sleep(TICK_MS);
    }
  }
  logger.info('Worker stopped');
}

let shuttingDown = false;
function handleSignal(sig: NodeJS.Signals) {
  logger.info({ sig }, 'shutdown signal received');
  shuttingDown = true;
}
process.on('SIGTERM', handleSignal);
process.on('SIGINT', handleSignal);

function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

loop().catch((err) => {
  logger.fatal({ err }, 'worker crashed');
  process.exit(1);
});
