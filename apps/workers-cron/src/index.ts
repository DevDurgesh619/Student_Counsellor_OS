import { Cron } from 'croner';
import { pino } from 'pino';
import { loadEnv } from '@wgc/config';
import { SCHEDULERS } from './schedulers.js';

const env = loadEnv();

const logger = pino({
  level: env.WGC_LOG_LEVEL,
  ...(env.WGC_NODE_ENV === 'development'
    ? {
        transport: {
          target: 'pino-pretty',
          options: { colorize: true, translateTime: 'SYS:HH:MM:ss.l' },
        },
      }
    : {}),
});

const jobs = SCHEDULERS.map((entry) => {
  const log = logger.child({ scheduler: entry.name, tz: entry.timezone });
  log.info(
    { schedule: entry.schedule, description: entry.description },
    'registering scheduler',
  );
  return new Cron(
    entry.schedule,
    { timezone: entry.timezone, name: entry.name, protect: true },
    async () => {
      const start = Date.now();
      try {
        await entry.handler(log);
        log.info({ durationMs: Date.now() - start }, 'scheduler tick complete');
      } catch (err) {
        log.error({ err }, 'scheduler tick failed');
      }
    },
  );
});

logger.info({ count: jobs.length }, 'workers-cron running');

// Graceful shutdown
const shutdown = (signal: string) => {
  logger.info({ signal }, 'shutting down');
  jobs.forEach((j) => j.stop());
  process.exit(0);
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
