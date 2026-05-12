/**
 * Take whatever Spinach meetings are sitting in the unassigned inbox for a
 * given counsellor, extract attendee emails, seed an active student per
 * unique email, and re-link the meetings to those new students.
 *
 * Idempotent — re-running is a no-op once everything's linked.
 *
 * Usage:
 *   pnpm tsx --env-file=.env infra/scripts/seed-students-from-spinach-inbox.ts \
 *     --counsellor-email wallickglobalconsulting@gmail.com
 */
import { eq, and, sql } from 'drizzle-orm';
import {
  counsellors,
  db,
  reviewQueue,
  sessions,
  spinachIngestedMeetings,
  students,
} from '@wgc/db';

function arg(name: string): string | undefined {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx === -1 || idx === process.argv.length - 1) return undefined;
  return process.argv[idx + 1];
}

type Attendee = { name?: string; email?: string; internal?: boolean };

async function main() {
  const counsellorEmail = arg('counsellor-email')?.toLowerCase();
  if (!counsellorEmail) {
    console.error('Usage: --counsellor-email <gmail>');
    process.exit(1);
  }

  const counsellor = (
    await db.select().from(counsellors).where(eq(counsellors.email, counsellorEmail)).limit(1)
  )[0];
  if (!counsellor) {
    console.error(`No counsellor with email ${counsellorEmail}`);
    process.exit(1);
  }

  const unassigned = await db
    .select()
    .from(spinachIngestedMeetings)
    .where(
      and(
        eq(spinachIngestedMeetings.counsellorId, counsellor.id),
        eq(spinachIngestedMeetings.status, 'unassigned'),
      ),
    );
  console.log(`Found ${unassigned.length} unassigned meetings for ${counsellorEmail}`);

  // Collect unique attendee emails, skipping the counsellor's own email.
  const seen = new Map<string, { email: string; name?: string }>();
  for (const m of unassigned) {
    const attendees = (m.attendees as Attendee[]) ?? [];
    for (const a of attendees) {
      if (!a.email) continue;
      const email = a.email.toLowerCase();
      if (email === counsellorEmail) continue;
      if (!seen.has(email)) {
        const entry: { email: string; name?: string } = { email };
        if (a.name) entry.name = a.name;
        seen.set(email, entry);
      }
    }
  }
  console.log(`Found ${seen.size} unique attendee email(s) to seed as students`);

  if (seen.size === 0) {
    console.log('Nothing to seed. Check whether the latest poll captured attendee data.');
    process.exit(0);
  }

  // Seed students. Idempotent via the partial unique index on LOWER(email).
  for (const { email, name } of seen.values()) {
    const existing = (
      await db
        .select({ id: students.id, counsellorId: students.counsellorId, status: students.status })
        .from(students)
        .where(sql`LOWER(${students.email}) = ${email}`)
        .limit(1)
    )[0];
    if (existing) {
      // Make sure it's assigned + active so matching picks it up.
      if (existing.counsellorId !== counsellor.id || existing.status !== 'active') {
        await db
          .update(students)
          .set({ counsellorId: counsellor.id, status: 'active' })
          .where(eq(students.id, existing.id));
        console.log(`Updated existing student ${email} → counsellor=${counsellor.id}, status=active`);
      } else {
        console.log(`Student ${email} already assigned + active. Skip.`);
      }
      continue;
    }
    const fullName = name ?? email.split('@')[0]!;
    const inserted = await db
      .insert(students)
      .values({
        fullName,
        email,
        phone: '',
        currentGrade: 'unknown',
        status: 'active',
        counsellorId: counsellor.id,
      })
      .returning({ id: students.id });
    console.log(`Seeded student ${email} → ${inserted[0]!.id}`);
  }

  // Re-link unassigned meetings whose attendees now resolve to a student.
  let linked = 0;
  for (const m of unassigned) {
    const attendees = (m.attendees as Attendee[]) ?? [];
    const emails = attendees
      .map((a) => a.email?.toLowerCase())
      .filter((e): e is string => Boolean(e) && e !== counsellorEmail);
    if (emails.length === 0) continue;

    const match = (
      await db
        .select({ id: students.id })
        .from(students)
        .where(
          and(
            eq(students.counsellorId, counsellor.id),
            eq(students.status, 'active'),
            sql`LOWER(${students.email}) IN (${sql.join(
              emails.map((e) => sql`${e}`),
              sql`, `,
            )})`,
          ),
        )
        .limit(1)
    )[0];
    if (!match) continue;

    const scheduledAt = m.scheduledAt ?? new Date();
    const raw = (m.raw ?? {}) as Record<string, unknown>;
    const transcript = pickString(raw, ['transcript', 'transcript_text', 'full_transcript']);
    const summary = pickString(raw, ['summary', 'summary_text', 'ai_summary']);

    const sessionRow = (
      await db
        .insert(sessions)
        .values({
          studentId: match.id,
          counsellorId: counsellor.id,
          scheduledAt,
          actualStartedAt: scheduledAt,
          transcriptText: transcript ?? null,
          spinachSummaryText: summary ?? null,
          spinachMetadata: { source: 'mcp-rematch', spinachMeetingId: m.spinachMeetingId, raw },
          status: 'completed',
        })
        .returning({ id: sessions.id })
    )[0]!;

    await db
      .update(spinachIngestedMeetings)
      .set({ status: 'linked', linkedSessionId: sessionRow.id })
      .where(eq(spinachIngestedMeetings.id, m.id));

    await db
      .update(reviewQueue)
      .set({ status: 'resolved', resolvedAt: new Date(), resolvedBy: counsellor.id })
      .where(
        and(
          eq(reviewQueue.type, 'unassigned_spinach_meeting'),
          eq(reviewQueue.referenceId, m.id),
        ),
      );

    linked += 1;
    console.log(`Linked meeting "${m.title ?? m.spinachMeetingId}" → student ${match.id}`);
  }

  console.log(`Done. Seeded ${seen.size} student(s), linked ${linked} meeting(s).`);
  process.exit(0);
}

function pickString(obj: Record<string, unknown>, keys: string[]): string | undefined {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === 'string' && v.length > 0) return v;
  }
  return undefined;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
