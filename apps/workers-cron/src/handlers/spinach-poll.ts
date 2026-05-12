import type { Logger } from 'pino';
import { loadEnv } from '@wgc/config';

/**
 * Five-minute tick — calls the API's internal endpoint, which scans every
 * counsellor with a stored Spinach token and pulls any new meetings since
 * their last watermark. Heavy lifting (OAuth refresh, MCP calls, ingest,
 * pipeline) stays in the API process; we just trigger it from cron.
 */
export async function runSpinachPoll(log: Logger): Promise<void> {
  const env = loadEnv();
  if (!env.WGC_INTERNAL_API_SECRET) {
    log.warn('WGC_INTERNAL_API_SECRET not set — skipping spinach_poll');
    return;
  }
  const url = `${env.NEXT_PUBLIC_API_BASE_URL.replace(/\/$/, '')}/internal/spinach-poll`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'x-internal-secret': env.WGC_INTERNAL_API_SECRET },
    });
    if (!res.ok) {
      const text = await res.text();
      log.warn({ status: res.status, body: text }, 'spinach poll call failed');
      return;
    }
    const body = (await res.json()) as { data?: unknown };
    log.info({ result: body.data }, 'spinach poll sweep complete');
  } catch (err) {
    log.warn({ err }, 'spinach poll fetch threw');
  }
}
