import type { ErrorHandler } from 'hono';
import { ZodError } from 'zod';
import { Errors, WgcError } from '@wgc/shared';
import { loadEnv } from '@wgc/config';
import { logger } from '../logger.js';
import type { AppEnv } from '../app.js';

const env = loadEnv();
const isDev = env.WGC_NODE_ENV !== 'production';

/**
 * Convert thrown errors into the canonical envelope (CLAUDE_CODE.md §9).
 * - WgcError → its toEnvelope() at its declared status
 * - ZodError → 400 VALIDATION_FAILED with field issues in `details`
 * - anything else → 500 INTERNAL_ERROR
 *
 * In development the underlying error message + a truncated stack are
 * included in `details.cause` so the frontend can surface useful debug
 * info ("RangeError: Invalid time value" beats "An unexpected error
 * occurred" every time). In production we keep it opaque.
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
  const internalErr = isDev
    ? Errors.internal(`Internal error: ${err.message}`, err, {
        cause: err.message,
        stack: err.stack?.split('\n').slice(0, 5).join('\n'),
      })
    : Errors.internal();
  return c.json(internalErr.toEnvelope(), 500);
};
