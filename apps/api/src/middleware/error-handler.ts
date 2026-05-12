import type { ErrorHandler } from 'hono';
import { ZodError } from 'zod';
import { Errors, WgcError } from '@wgc/shared';
import { logger } from '../logger.js';
import type { AppEnv } from '../app.js';

/**
 * Convert thrown errors into the canonical envelope (CLAUDE_CODE.md §9).
 * - WgcError → its toEnvelope() at its declared status
 * - ZodError → 400 VALIDATION_FAILED with field issues in `details`
 * - anything else → 500 INTERNAL_ERROR (no leaking stacks to clients)
 */
export const errorHandler: ErrorHandler<AppEnv> = (err, c) => {
  const requestId = c.get('requestId');
  if (err instanceof WgcError) {
    logger.warn({ requestId, code: err.code, status: err.status }, err.message);
    return c.json(err.toEnvelope(), err.status as 400 | 401 | 403 | 404 | 409 | 500);
  }
  if (err instanceof ZodError) {
    const wgcErr = Errors.validation('Request validation failed', {
      issues: err.issues.map((i) => ({ path: i.path, message: i.message, code: i.code })),
    });
    logger.warn({ requestId, code: wgcErr.code }, wgcErr.message);
    return c.json(wgcErr.toEnvelope(), 400);
  }
  logger.error(
    { requestId, err: { message: err.message, stack: err.stack } },
    'unhandled error',
  );
  return c.json(Errors.internal().toEnvelope(), 500);
};
