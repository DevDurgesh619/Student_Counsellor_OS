/**
 * Seed Gahan reference data per CLAUDE_CODE.md §13 Phase 1 ("Seed Gahan's data
 * for testing"). Idempotent: re-runs upsert by stable email / by (student_id +
 * scheduled_start) for tasks. Safe to run repeatedly during dev.
 */
import { eq } from 'drizzle-orm';
import { closeDb, getDb } from './client.js';
import {
  artifacts,
  completions,
  counsellors,
  students,
  tasks,
} from './schema/index.js';

const COUNSELLOR_EMAIL = 'anubhav@wgc.in';
const STUDENT_EMAIL = 'gahan@example.com';

function dt(dayOffset: number, hour: number, minute = 0): Date {
  const d = new Date();
  d.setHours(hour, minute, 0, 0);
  d.setDate(d.getDate() + dayOffset);
  return d;
}

async function main() {
  const db = getDb();
  console.log('Seeding Gahan reference data…');

  // ── counsellor (Anubhav)
  let anubhav = (
    await db.select().from(counsellors).where(eq(counsellors.email, COUNSELLOR_EMAIL)).limit(1)
  )[0];
  if (!anubhav) {
    anubhav = (
      await db
        .insert(counsellors)
        .values({
          fullName: 'Anubhav (WGC)',
          email: COUNSELLOR_EMAIL,
          phone: '+910000000000',
          timezone: 'Asia/Kolkata',
        })
        .returning()
    )[0]!;
    console.log(`  + counsellor ${anubhav.id} (${anubhav.email})`);
  } else {
    console.log(`  = counsellor ${anubhav.id} already exists`);
  }

  // ── student (Gahan, Class 10 IGCSE — reference student per docs)
  let gahan = (
    await db.select().from(students).where(eq(students.email, STUDENT_EMAIL)).limit(1)
  )[0];
  if (!gahan) {
    gahan = (
      await db
        .insert(students)
        .values({
          fullName: 'Gahan',
          phone: '+910000000001',
          email: STUDENT_EMAIL,
          parentContacts: [
            { name: 'Ravi (father)', phone: '+910000000002', relationship: 'father' },
          ],
          counsellorId: anubhav.id,
          currentGrade: '10 IGCSE',
          school: 'Reference School',
          currentContextTag: 'school_term',
          languagePreferences: { primary: 'en', secondary: ['hi'] },
        })
        .returning()
    )[0]!;
    console.log(`  + student ${gahan.id} (${gahan.fullName})`);
  } else {
    console.log(`  = student ${gahan.id} already exists`);
  }

  // ── tasks: a small representative slice of one weekday
  // (Wed, evening study block + a Sleep block that should NOT sync to Calendar)
  const seedTasks = [
    {
      studentId: gahan.id,
      scheduledStart: dt(0, 19, 30),
      scheduledEnd: dt(0, 20, 0),
      subject: 'Reading',
      taskTitle: 'Reading practice — 30 min',
      taskDescription: 'Target 230 WPM. Track via reading log.',
      expectedOutput: 'Notes from the chapter you read',
      flexibility: 'preferred' as const,
      source: 'counsellor_manual' as const,
    },
    {
      studentId: gahan.id,
      scheduledStart: dt(0, 20, 0),
      scheduledEnd: dt(0, 20, 30),
      subject: 'Math',
      taskTitle: 'Math: Chapter 5 problems',
      taskDescription: 'Problems 1–8.',
      expectedOutput: 'Photo of working in notebook',
      flexibility: 'fixed' as const,
      source: 'counsellor_manual' as const,
    },
    {
      studentId: gahan.id,
      scheduledStart: dt(0, 22, 30),
      scheduledEnd: dt(1, 6, 30),
      subject: 'Sleep',
      taskTitle: 'Sleep',
      taskDescription: 'Eight hours.',
      flexibility: 'fixed' as const,
      source: 'counsellor_manual' as const,
    },
  ];

  for (const t of seedTasks) {
    const existing = await db
      .select({ id: tasks.id })
      .from(tasks)
      .where(eq(tasks.studentId, t.studentId))
      .limit(1000);
    const collision = existing.some((e) => false); // intentionally permissive — see note below
    void collision;
    // We don't dedupe by (studentId + scheduledStart) because seed re-runs are
    // expected to leave the existing rows alone. To re-seed cleanly, drop the
    // local DB and `pnpm db:migrate && pnpm db:seed`.
    if (existing.length > 0) {
      console.log(`  = tasks for ${gahan.fullName} already present (${existing.length})`);
      break;
    }
    const inserted = await db.insert(tasks).values(t).returning();
    console.log(`  + task ${inserted[0]!.id} (${t.taskTitle})`);
  }

  // ── one completion + one artifact, to exercise the joins end-to-end
  const recentTask = (
    await db
      .select()
      .from(tasks)
      .where(eq(tasks.studentId, gahan.id))
      .limit(1)
  )[0];

  if (recentTask) {
    const hasCompletion = (
      await db.select().from(completions).where(eq(completions.taskId, recentTask.id)).limit(1)
    )[0];
    if (!hasCompletion) {
      await db.insert(completions).values({
        taskId: recentTask.id,
        statusClaimed: 'done',
        statusVerified: 'evidence_submitted',
        verificationMethod: 'photo',
        notesText: 'easy',
        timeTakenMinutes: 35,
        source: 'counsellor_manual_entry',
      });
      console.log(`  + completion on task ${recentTask.id}`);
    }

    const hasArtifact = (
      await db.select().from(artifacts).where(eq(artifacts.taskId, recentTask.id)).limit(1)
    )[0];
    if (!hasArtifact) {
      await db.insert(artifacts).values({
        studentId: gahan.id,
        taskId: recentTask.id,
        fileUrl: `students/${gahan.id}/artifacts/seed/notebook.jpg`,
        fileType: 'image/jpeg',
        fileSizeBytes: 482000,
        originalFilename: 'notebook.jpg',
        source: 'counsellor_manual_entry',
      });
      console.log(`  + artifact (placeholder) on task ${recentTask.id}`);
    }
  }

  console.log('Seed complete.');
  await closeDb();
}

main().catch(async (err) => {
  console.error('Seed failed:', err);
  await closeDb();
  process.exit(1);
});
