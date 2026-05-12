import { pino } from 'pino';
import { loadEnv } from '@wgc/config';

const env = loadEnv();

/**
 * Root Pino logger. JSON in production; pretty-printed in dev.
 * Per CLAUDE_CODE.md §4 (Pino, NOT Winston).
 */
export const logger = pino({
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
