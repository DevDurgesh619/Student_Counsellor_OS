/**
 * Seed a fully-populated dummy student "Hetvika" with a submitted onboarding
 * draft, ready for a counsellor to approve via the /onboarding UI.
 *
 * After running:
 *   1. Sign in as a counsellor (e.g. wallickglobalconsulting@gmail.com)
 *   2. Open /onboarding — Hetvika appears in the queue
 *   3. Click into her draft → review → Approve
 *   4. Sign in (different browser / incognito) as patidardurgesh619@gmail.com
 *      → land on /student/today, acting as Hetvika
 *
 * Re-running is idempotent: if Hetvika's student row already exists, the
 * existing draft is updated rather than duplicated.
 *
 * Usage:
 *   pnpm tsx --env-file=.env infra/scripts/seed-dummy-hetvika.ts
 */
import { and, desc, eq } from 'drizzle-orm';
import { db, students, studentProfileDrafts } from '@wgc/db';

const STUDENT_EMAIL = 'patidardurgesh619@gmail.com';
const STUDENT_NAME = 'Hetvika Sharma';
const STUDENT_GRADE = '11';
const STUDENT_PHONE = '+91-9876501234';
const SCHOOL = 'Delhi Public School, R.K. Puram';

const formResponses = {
  basic_info: {
    full_name: STUDENT_NAME,
    grade: STUDENT_GRADE,
    school: SCHOOL,
    date_of_birth: '2009-08-14',
    phone: STUDENT_PHONE,
    email: STUDENT_EMAIL,
    stream: 'Science (PCM + Computer Science)',
  },
  parent_info: [
    {
      name: 'Mr. Anil Sharma',
      relationship: 'father',
      phone: '+91-9810056789',
      email: 'anil.sharma.dps@gmail.com',
      occupation: 'Software Architect',
    },
    {
      name: 'Mrs. Priya Sharma',
      relationship: 'mother',
      phone: '+91-9810067890',
      email: 'priya.sharma.dps@gmail.com',
      occupation: 'Math teacher, DAV School',
    },
  ],
  academic_background:
    'Consistently a top-quartile student. Strong in Math and Computer Science, weaker in Hindi (writing speed). Took CBSE board for Class 10 in 2025, scored 92.4%.',
  manual_marks: [
    { subject: 'English Communicative', marks_obtained: 88, marks_total: 100, year: '2025', term: 'CBSE Class 10 Board' },
    { subject: 'Hindi Course-A', marks_obtained: 79, marks_total: 100, year: '2025', term: 'CBSE Class 10 Board' },
    { subject: 'Mathematics (Standard)', marks_obtained: 98, marks_total: 100, year: '2025', term: 'CBSE Class 10 Board' },
    { subject: 'Science', marks_obtained: 94, marks_total: 100, year: '2025', term: 'CBSE Class 10 Board' },
    { subject: 'Social Science', marks_obtained: 91, marks_total: 100, year: '2025', term: 'CBSE Class 10 Board' },
    { subject: 'Computer Applications', marks_obtained: 99, marks_total: 100, year: '2025', term: 'CBSE Class 10 Board' },
  ],
  goals: {
    short_term: 'Score above 95% in Class 11 finals and clear KVPY/NTSE-equivalent screening.',
    long_term: 'Get into a top CS undergrad — IIT Bombay CSE or IIIT Hyderabad. Eventually pursue an ML PhD.',
    target_exams: ['JEE Main 2027', 'JEE Advanced 2027', 'BITSAT'],
  },
  self_reflection:
    'I procrastinate physics numericals because they intimidate me, but I can grind through math for hours. Need a structured plan for physics. Also want to improve Hindi essay writing speed.',
  logistics: {
    timezone: 'Asia/Kolkata',
    language: 'en',
    devices: ['laptop', 'phone'],
    schedule_constraints:
      'School 8–2pm Mon-Fri, classical dance Tue/Thu 5–6:30pm, family time Sun evening.',
  },
  marksheet_paths: [],
};

// What Worker 1 (profile builder) would produce — required for the approve
// endpoint, which refuses to flip the student to "active" until a profile
// exists on the draft.
const aiProfile = {
  name: STUDENT_NAME,
  current_grade: STUDENT_GRADE,
  school: SCHOOL,
  language_preference: 'en',
  subjects_strong: ['Mathematics', 'Computer Applications', 'Science'],
  subjects_weak: ['Hindi (writing speed)', 'Physics numericals'],
  exam_track: ['JEE Main 2027', 'JEE Advanced 2027'],
  motivations:
    'High self-driven academic ambition; clear long-term goal (CS undergrad → ML PhD). Family is supportive (mother is a teacher).',
  risk_flags: ['Procrastinates physics numericals due to intimidation'],
  preferred_study_block_minutes: 90,
};

async function main() {
  // ── Upsert the student row.
  let student = (
    await db.select().from(students).where(eq(students.email, STUDENT_EMAIL)).limit(1)
  )[0];

  if (student) {
    await db
      .update(students)
      .set({
        fullName: STUDENT_NAME,
        phone: STUDENT_PHONE,
        currentGrade: STUDENT_GRADE,
        school: SCHOOL,
        status: 'pending_review',
        // Deliberately do NOT pin counsellorId — approval claims it.
        counsellorId: null,
      })
      .where(eq(students.id, student.id));
    console.log(`Updated existing student ${STUDENT_EMAIL} → status=pending_review`);
    student = (await db.select().from(students).where(eq(students.id, student.id)).limit(1))[0]!;
  } else {
    const inserted = await db
      .insert(students)
      .values({
        fullName: STUDENT_NAME,
        email: STUDENT_EMAIL,
        phone: STUDENT_PHONE,
        currentGrade: STUDENT_GRADE,
        school: SCHOOL,
        status: 'pending_review',
      })
      .returning();
    student = inserted[0]!;
    console.log(`Inserted student ${STUDENT_EMAIL} → ${student.id}`);
  }

  // ── Upsert the draft for this student.
  const latest = (
    await db
      .select()
      .from(studentProfileDrafts)
      .where(eq(studentProfileDrafts.studentId, student.id))
      .orderBy(desc(studentProfileDrafts.createdAt))
      .limit(1)
  )[0];

  if (latest) {
    await db
      .update(studentProfileDrafts)
      .set({
        formResponses,
        profile: aiProfile,
        status: 'pending_review',
        submittedAt: new Date(),
      })
      .where(eq(studentProfileDrafts.id, latest.id));
    console.log(`Updated existing draft ${latest.id} (formResponses + profile)`);
  } else {
    const insertedDraft = await db
      .insert(studentProfileDrafts)
      .values({
        studentId: student.id,
        formResponses,
        profile: aiProfile,
        status: 'pending_review',
        submittedAt: new Date(),
      })
      .returning({ id: studentProfileDrafts.id });
    console.log(`Inserted draft ${insertedDraft[0]!.id}`);
  }

  console.log('\nNext steps:');
  console.log('  1. Sign in as your counsellor (e.g. wallickglobalconsulting@gmail.com)');
  console.log('  2. Open /onboarding → Hetvika appears in the queue');
  console.log('  3. Click into her draft → review → Approve');
  console.log(`  4. Sign in (incognito) as ${STUDENT_EMAIL} → land on /student/today`);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
