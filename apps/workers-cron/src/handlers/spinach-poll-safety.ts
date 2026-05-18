import type { Logger } from 'pino';
import { loadEnv } from '@wgc/config';

/**
 * Six-hourly safety-net poll. The default 5-min poll uses an activity
 * gate that skips counsellors with no recent or upcoming sessions — which
 * means an ad-hoc meeting Spinach picks up for someone with no scheduled
 * session in the gate window would never land. This cron bypasses the
 * gate so every counsellor is polled at least 4× per day regardless.
 */
export async function runSpinachPollSafety(log: Logger): Promise<void> {
  const env = loadEnv();
  if (!env.WGC_INTERNAL_API_SECRET) {
    log.warn('WGC_INTERNAL_API_SECRET not set — skipping spinach_poll_safety');
    return;
  }
  const url = `${env.NEXT_PUBLIC_API_BASE_URL.replace(/\/$/, '')}/internal/spinach-poll?safety=1`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'x-internal-secret': env.WGC_INTERNAL_API_SECRET },
    });
    if (!res.ok) {
      const text = await res.text();
      log.warn({ status: res.status, body: text }, 'spinach poll safety call failed');
      return;
    }
    const body = (await res.json()) as { data?: unknown };
    log.info({ result: body.data }, 'spinach poll safety sweep complete');
  } catch (err) {
    log.warn({ err }, 'spinach poll safety fetch threw');
  }
}
