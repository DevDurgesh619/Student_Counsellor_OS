import type { Logger } from 'pino';
import { and, eq, lte } from 'drizzle-orm';
import { google } from 'googleapis';
import { calendarWatchChannels, db, decryptJson, students } from '@wgc/db';
import { loadEnv } from '@wgc/config';

/**
 * Daily job — finds calendar_watch_channels expiring within 7 days and
 * registers a fresh channel via the Google Calendar `events.watch` endpoint.
 * The old channel naturally expires (Google manages it).
 */
export async function renewExpiringWatchChannels(log: Logger): Promise<void> {
  const env = loadEnv();
  if (!env.WGC_CALENDAR_SYNC_ENABLED) {
    log.info('calendar sync disabled — skipping watch renewal');
    return;
  }
  if (
    !env.WGC_GOOGLE_CALENDAR_CLIENT_ID ||
    !env.WGC_GOOGLE_CALENDAR_CLIENT_SECRET ||
    !env.WGC_GOOGLE_CALENDAR_REDIRECT_URI ||
    !env.WGC_GOOGLE_CALENDAR_WEBHOOK_URL
  ) {
    log.warn('Google Calendar OAuth/webhook env not set — skipping watch renewal');
    return;
  }

  const cutoff = new Date(Date.now() + 7 * 86_400_000);
  const expiring = await db
    .select({
      id: calendarWatchChannels.id,
      studentId: calendarWatchChannels.studentId,
      channelId: calendarWatchChannels.channelId,
    })
    .from(calendarWatchChannels)
    .where(lte(calendarWatchChannels.expiresAt, cutoff));

  log.info({ count: expiring.length }, 'expiring watch channels found');

  for (const ch of expiring) {
    const s = (
      await db
        .select({
          token: students.googleOauthToken,
          calendarId: students.googleCalendarId,
        })
        .from(students)
        .where(eq(students.id, ch.studentId))
        .limit(1)
    )[0];
    if (!s?.calendarId || !s.token) continue;

    const client = new google.auth.OAuth2(
      env.WGC_GOOGLE_CALENDAR_CLIENT_ID,
      env.WGC_GOOGLE_CALENDAR_CLIENT_SECRET,
      env.WGC_GOOGLE_CALENDAR_REDIRECT_URI,
    );
    const token = await decryptJson<Record<string, unknown>>(s.token);
    client.setCredentials(token);
    const cal = google.calendar({ version: 'v3', auth: client });

    try {
      const newId = crypto.randomUUID();
      const watch = await cal.events.watch({
        calendarId: s.calendarId,
        requestBody: {
          id: newId,
          type: 'web_hook',
          address: env.WGC_GOOGLE_CALENDAR_WEBHOOK_URL,
          token: ch.studentId,
        },
      });
      const exp = watch.data.expiration
        ? Number(watch.data.expiration)
        : Date.now() + 30 * 86_400_000;
      await db
        .update(calendarWatchChannels)
        .set({
          channelId: newId,
          resourceId: watch.data.resourceId ?? '',
          expiresAt: new Date(exp),
        })
        .where(
          and(
            eq(calendarWatchChannels.id, ch.id),
            eq(calendarWatchChannels.channelId, ch.channelId),
          ),
        );
      log.info({ studentId: ch.studentId, newId }, 'watch channel renewed');
    } catch (err) {
      log.error({ err, studentId: ch.studentId }, 'watch renewal failed');
    }
  }
}
