import pino from 'pino';
import { loadEnv } from '@wgc/config';

const env = loadEnv();
export const logger = pino({
  level: env.WGC_LOG_LEVEL,
  ...(env.WGC_NODE_ENV === 'development'
    ? { transport: { target: 'pino-pretty', options: { colorize: true } } }
    : {}),
  base: { service: 'calendar-sync' },
});
