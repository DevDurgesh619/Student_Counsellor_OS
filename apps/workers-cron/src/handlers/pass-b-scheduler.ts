import type { Logger } from 'pino';
import { loadEnv } from '@wgc/config';

/**
 * Hourly tick — calls the API's internal endpoint, which scans for upcoming
 * sessions 24-25h away and generates Pass B briefs for any not yet generated.
 * Runs through the API process so all DB + AI plumbing stays in one place.
 */
export async function runPassBScheduler(log: Logger): Promise<void> {
  const env = loadEnv();
  if (!env.WGC_INTERNAL_API_SECRET) {
    log.warn('WGC_INTERNAL_API_SECRET not set — skipping pass_b_24h_check');
    return;
  }
  const url = `${env.NEXT_PUBLIC_API_BASE_URL.replace(/\/$/, '')}/internal/run-pass-b-scheduler`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'x-internal-secret': env.WGC_INTERNAL_API_SECRET },
    });
    if (!res.ok) {
      const text = await res.text();
      log.warn({ status: res.status, body: text }, 'pass-b scheduler call failed');
      return;
    }
    const body = (await res.json()) as { data?: { generated: number; failed: number } };
    log.info({ result: body.data }, 'pass-b sweep complete');
  } catch (err) {
    log.warn({ err }, 'pass-b scheduler fetch threw');
  }
}
