import { google, type calendar_v3 } from 'googleapis';
import { loadEnv } from '@wgc/config';
import { SUBJECT_CALENDAR_COLOR, type Subject } from '@wgc/shared';

type OAuth2Client = InstanceType<typeof google.auth.OAuth2>;

export type StoredOAuthToken = {
  access_token?: string;
  refresh_token?: string;
  scope?: string;
  token_type?: string;
  expiry_date?: number;
};

export function buildOAuthClient(): OAuth2Client {
  const env = loadEnv();
  if (
    !env.WGC_GOOGLE_CALENDAR_CLIENT_ID ||
    !env.WGC_GOOGLE_CALENDAR_CLIENT_SECRET ||
    !env.WGC_GOOGLE_CALENDAR_REDIRECT_URI
  ) {
    throw new Error('Google Calendar OAuth env vars not set');
  }
  return new google.auth.OAuth2(
    env.WGC_GOOGLE_CALENDAR_CLIENT_ID,
    env.WGC_GOOGLE_CALENDAR_CLIENT_SECRET,
    env.WGC_GOOGLE_CALENDAR_REDIRECT_URI,
  );
}

export function calendarFromToken(token: StoredOAuthToken): calendar_v3.Calendar {
  const client = buildOAuthClient();
  client.setCredentials(token);
  return google.calendar({ version: 'v3', auth: client });
}

/**
 * Stable Calendar event ID derived from our task UUID. Per Calendar API the
 * ID must be base32hex (digits + lowercase letters a-v), 5–1024 chars. The
 * prefix "task" stays within that charset; "wgc" does not (w > v).
 */
export function eventIdForTask(taskId: string): string {
  return `task${taskId.replace(/-/g, '').toLowerCase()}`;
}

export function buildEventResource(task: {
  id: string;
  taskTitle: string;
  taskDescription: string | null;
  expectedOutput: string | null;
  subject: Subject;
  scheduledStart: Date;
  scheduledEnd: Date;
}): calendar_v3.Schema$Event {
  const description = [
    task.taskDescription ?? '',
    task.expectedOutput ? `Expected output: ${task.expectedOutput}` : '',
  ]
    .filter(Boolean)
    .join('\n\n');
  return {
    id: eventIdForTask(task.id),
    summary: `${task.subject}: ${task.taskTitle}`.slice(0, 1024),
    description,
    start: { dateTime: task.scheduledStart.toISOString() },
    end: { dateTime: task.scheduledEnd.toISOString() },
    colorId: SUBJECT_CALENDAR_COLOR[task.subject],
    reminders: {
      useDefault: false,
      overrides: [{ method: 'popup', minutes: 5 }],
    },
  };
}
