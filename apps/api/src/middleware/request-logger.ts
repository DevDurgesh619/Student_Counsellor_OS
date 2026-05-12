import type { MiddlewareHandler } from 'hono';
import { logger } from '../logger.js';
import type { AppEnv } from '../app.js';

/**
 * Tag every request with a UUID, log start / finish, and expose the id on the
 * Hono context as `requestId`. Mirrored to the response as `X-Request-Id` so
 * clients can quote it in support tickets.
 */
export const requestLogger: MiddlewareHandler<AppEnv> = async (c, next) => {
  const requestId = crypto.randomUUID();
  c.set('requestId', requestId);
  const started = Date.now();
  const log = logger.child({ requestId, method: c.req.method, path: c.req.path });
  log.info('request received');
  c.header('X-Request-Id', requestId);
  try {
    await next();
  } finally {
    log.info({ status: c.res.status, durationMs: Date.now() - started }, 'request finished');
  }
};
