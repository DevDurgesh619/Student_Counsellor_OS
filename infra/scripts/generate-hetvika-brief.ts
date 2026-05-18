import { and, desc, eq, gt, ilike } from 'drizzle-orm';
import { db, meetingPrepBriefs, sessions, students } from '@wgc/db';
import { runWorker7PassB } from '../../apps/api/src/lib/meeting-prep.js';

async function main() {
  const matches = await db
    .select()
    .from(students)
    .where(ilike(students.fullName, '%hetvika%'))
    .limit(5);
  if (matches.length === 0) {
    console.error('No student matching "hetvika" found.');
    process.exit(1);
  }
  if (matches.length > 1) {
    console.log('Multiple matches — picking the most recently created:');
    for (const s of matches) console.log(' -', s.id, s.fullName, s.email);
  }
  const hetvika = matches.sort(
    (a, b) => b.createdAt.getTime() - a.createdAt.getTime(),
  )[0]!;
  console.log(`Student: ${hetvika.fullName} (${hetvika.id})  counsellor=${hetvika.counsellorId}`);

  const now = new Date();
  const upcoming = (
    await db
      .select()
      .from(sessions)
      .where(and(eq(sessions.studentId, hetvika.id), gt(sessions.scheduledAt, now)))
      .orderBy(sessions.scheduledAt)
      .limit(1)
  )[0];

  let targetSessionId: string;
  if (upcoming) {
    targetSessionId = upcoming.id;
    console.log(
      `Using existing upcoming session ${targetSessionId} at ${upcoming.scheduledAt.toISOString()}`,
    );
  } else {
    const lastSession = (
      await db
        .select()
        .from(sessions)
        .where(eq(sessions.studentId, hetvika.id))
        .orderBy(desc(sessions.scheduledAt))
        .limit(1)
    )[0];
    if (!lastSession) {
      console.error('Hetvika has no prior sessions either — cannot generate a useful brief.');
      process.exit(1);
    }
    const scheduledAt = new Date(now.getTime() + 3 * 24 * 60 * 60 * 1000);
    const inserted = await db
      .insert(sessions)
      .values({
        studentId: hetvika.id,
        counsellorId: lastSession.counsellorId,
        scheduledAt,
        status: 'scheduled',
      })
      .returning();
    targetSessionId = inserted[0]!.id;
    console.log(
      `Created placeholder session ${targetSessionId} at ${scheduledAt.toISOString()} (3 days out)`,
    );
  }

  console.log('Running Pass B…');
  const briefId = await runWorker7PassB(targetSessionId);
  console.log(`Brief ${briefId} written.`);

  const brief = (
    await db
      .select()
      .from(meetingPrepBriefs)
      .where(eq(meetingPrepBriefs.id, briefId))
      .limit(1)
  )[0]!;
  console.log('\n──────── BRIEF CONTENT ────────\n');
  console.log(brief.passBContent);
  console.log('\n──────── END ────────');
  console.log(`\nSession URL fragment: /sessions/${targetSessionId}`);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
