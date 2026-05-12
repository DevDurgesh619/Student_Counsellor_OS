// Reproduces the queries from /api/counsellor/students-overview and /queue
// without going through HTTP/auth. Any schema mismatch surfaces as a Postgres error.

import { and, asc, desc, eq, gte, inArray, lt, sql } from 'drizzle-orm';
import {
  artifacts,
  completions,
  counsellors,
  db,
  reviewQueue,
  students,
  tasks,
} from '@wgc/db';

async function main() {
  const counsellor = (await db.select().from(counsellors).limit(1))[0];
  if (!counsellor) throw new Error('no counsellor in DB; run seed first');
  console.log('Using counsellor:', counsellor.id, counsellor.email);

  const subjectId = counsellor.id;

  console.log('\n--- students-overview ---');
  const now = new Date();
  const startOfToday = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0, 0),
  );
  const startOfTomorrow = new Date(startOfToday.getTime() + 86_400_000);

  const assigned = await db
    .select({
      id: students.id,
      fullName: students.fullName,
      currentGrade: students.currentGrade,
      status: students.status,
    })
    .from(students)
    .where(and(eq(students.counsellorId, subjectId), eq(students.status, 'active')))
    .orderBy(asc(students.fullName));
  console.log('assigned:', assigned.length);

  const studentIds = assigned.map((s) => s.id);
  if (studentIds.length === 0) {
    console.log('no assigned students — done');
    return;
  }

  const todayTasks = await db
    .select({
      studentId: tasks.studentId,
      status: tasks.status,
      count: sql<number>`count(*)::int`,
    })
    .from(tasks)
    .where(
      and(
        inArray(tasks.studentId, studentIds),
        gte(tasks.scheduledStart, startOfToday),
        lt(tasks.scheduledStart, startOfTomorrow),
      ),
    )
    .groupBy(tasks.studentId, tasks.status);
  console.log('todayTasks ok:', todayTasks.length);

  const latestCompletion = await db
    .select({
      studentId: tasks.studentId,
      latest: sql<Date | null>`max(${completions.submittedAt})`,
    })
    .from(completions)
    .innerJoin(tasks, eq(tasks.id, completions.taskId))
    .where(inArray(tasks.studentId, studentIds))
    .groupBy(tasks.studentId);
  console.log('latestCompletion ok:', latestCompletion.length);

  const latestArtifact = await db
    .select({
      studentId: artifacts.studentId,
      latest: sql<Date | null>`max(${artifacts.uploadedAt})`,
    })
    .from(artifacts)
    .where(inArray(artifacts.studentId, studentIds))
    .groupBy(artifacts.studentId);
  console.log('latestArtifact ok:', latestArtifact.length);

  const pending = await db
    .select({
      studentId: reviewQueue.studentId,
      count: sql<number>`count(*)::int`,
    })
    .from(reviewQueue)
    .where(
      and(
        eq(reviewQueue.counsellorId, subjectId),
        inArray(reviewQueue.status, ['pending', 'in_review']),
      ),
    )
    .groupBy(reviewQueue.studentId);
  console.log('pending ok:', pending.length);

  console.log('\n--- queue ---');
  const queueRows = await db
    .select()
    .from(reviewQueue)
    .where(
      and(
        eq(reviewQueue.counsellorId, subjectId),
        inArray(reviewQueue.status, ['pending', 'in_review']),
      ),
    )
    .orderBy(asc(reviewQueue.priority), desc(reviewQueue.createdAt))
    .limit(200);
  console.log('queue ok:', queueRows.length);

  console.log('\nALL OK');
}

main().catch((e) => {
  console.error('FAILED:', e);
  process.exit(1);
});
