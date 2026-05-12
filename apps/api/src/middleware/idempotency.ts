import type { MiddlewareHandler } from 'hono';
import { createHash } from 'node:crypto';
import { and, eq, gt } from 'drizzle-orm';
import { db, idempotencyRecords } from '@wgc/db';
import { Errors } from '@wgc/shared';
import type { AppEnv } from '../app.js';

/**
 * Pattern 7 (CLAUDE_CODE.md §7). When a POST carries `Idempotency-Key`, store
 * (key, method, path, request_hash, status, body) for 24h. Repeated calls with
 * the same key + same body return the original response; same key + different
 * body errors with IDEMPOTENCY_KEY_MISMATCH.
 */
export const idempotency: MiddlewareHandler<AppEnv> = async (c, next) => {
  const key = c.req.header('Idempotency-Key');
  if (!key || c.req.method !== 'POST') {
    return next();
  }

  const rawBody = await c.req.text();
  const requestHash = createHash('sha256').update(rawBody).digest('hex');

  const existing = await db
    .select()
    .from(idempotencyRecords)
    .where(and(eq(idempotencyRecords.key, key), gt(idempotencyRecords.expiresAt, new Date())))
    .limit(1);

  if (existing[0]) {
    const stored = existing[0];
    if (stored.method !== c.req.method || stored.path !== c.req.path) {
      throw Errors.conflict(
        'IDEMPOTENCY_KEY_MISMATCH',
        'Idempotency-Key was previously used on a different endpoint',
      );
    }
    if (stored.requestHash !== requestHash) {
      throw Errors.conflict(
        'IDEMPOTENCY_KEY_MISMATCH',
        'Idempotency-Key was previously used with a different request body',
      );
    }
    return c.json(stored.responseBody, stored.responseStatus as 200 | 201 | 409);
  }

  // Re-mount the consumed body so downstream handlers can read it again.
  // Hono caches via c.req.text() so this just keeps shape — fine for handlers
  // that re-call .json() since Hono memoizes the parsed body.
  await next();

  // Capture response and persist. We can only persist 2xx and 4xx responses,
  // not streamed bodies — Phase 1 endpoints are all JSON, so this is fine.
  const status = c.res.status;
  if (status >= 500) return; // never persist server errors
  const responseClone = c.res.clone();
  let body: unknown = null;
  try {
    body = await responseClone.json();
  } catch {
    // non-JSON response; skip persistence
    return;
  }
  await db
    .insert(idempotencyRecords)
    .values({
      key,
      method: c.req.method,
      path: c.req.path,
      requestHash,
      responseStatus: status,
      responseBody: body,
    })
    .onConflictDoNothing();
};
