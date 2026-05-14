/**
 * Seed the REAL Hetvika Rupani with an approved-style onboarding draft, so
 * the AI profile fed into every downstream LLM call (rolling summary, Pass
 * A/B briefs, reports) matches what's actually discussed in her real
 * Spinach meetings.
 *
 * After running:
 *   1. Sign in as a counsellor (e.g. wallickglobalconsulting@gmail.com)
 *   2. Open /onboarding — Hetvika appears in the queue at pending_review
 *   3. Click into her draft → Approve & activate
 *   4. Import history from Spinach via her /profile page
 *
 * Re-running is idempotent: existing student row + draft are updated rather
 * than duplicated, and counsellorId is reset so approval re-runs cleanly.
 *
 * Usage:
 *   pnpm tsx --env-file=.env infra/scripts/seed-dummy-hetvika.ts
 */
import { desc, eq } from 'drizzle-orm';
import { db, students, studentProfileDrafts } from '@wgc/db';

const STUDENT_EMAIL = 'hetvikarupani@gmail.com';
const STUDENT_NAME = 'Hetvika Rupani';
const STUDENT_GRADE = '11';
const STUDENT_PHONE = '+91-0000000000';
const SCHOOL = 'CHIREC International School';
const CITY = 'Hyderabad';

/**
 * Form responses — what Hetvika herself submitted (the raw onboarding form).
 * Source: her real intake form (provided 2026-05-13). Counsellor-supplied
 * fields she didn't fill in are left empty rather than fabricated.
 */
const formResponses = {
  basic_info: {
    full_name: STUDENT_NAME,
    grade: STUDENT_GRADE,
    school: SCHOOL,
    city: CITY,
    phone: STUDENT_PHONE,
    email: STUDENT_EMAIL,
    current_curriculum: 'IGCSE (Grade 11) — transitioning to IBDP for Grade 12',
    class_12_board: 'IBDP',
  },
  // No parent details captured in the intake form — leave empty so the AI
  // doesn't hallucinate. Counsellor can fill in later.
  parent_info: [],
  subjects_grade_11: [
    'Math AI HL',
    'Chemistry HL',
    'Biology HL',
    'Economics SL',
    'English SL',
    'Spanish AB SL',
  ],
  academic_background:
    'Grades / Percentage secured in the last three years: 75%. (No subject-wise breakdown provided at intake.)',
  manual_marks: [
    { period: 'Last three years average', percentage: 75 },
  ],
  goals: {
    target_major: 'Chemistry',
    target_universities: ['Imperial College London', 'USC (University of Southern California)'],
    target_countries: ['UK', 'USA'],
    course_choice_reason:
      'Chemistry — finds the subject fun and fascinating; out of all subjects she has been exposed to, she likes it the most.',
    career_aspirations:
      "Not yet decided — but certain it will be in the chemistry field.",
    motivation_abroad:
      'Wants to study in a global environment, for the exposure and the opportunities it brings.',
  },
  extracurriculars: [
    { activity: 'Drums', hours_per_week: 3, years: 4 },
    { activity: 'Volleyball', hours_per_week: 2, years: 5 },
  ],
  certifications: ['Coursera (multiple)', 'Multiple volleyball competitions'],
  projects: [
    'Head of Marketing in a hackathon',
    'Research paper (topic not specified at intake)',
    'Internship at a hydroponics company',
    'Crowd-funding initiative',
  ],
  about_self:
    'Passion for gardening and environmental projects. Recently began a passion project on water quality in India.',
  strengths:
    'When she cares about something, she gives it her all to accomplish it — by being flexible and observing.',
  weaknesses:
    "Sometimes leaves things at mediocre when she doesn't care about them as much.",
  books_outside_curriculum: [],
  self_reflection:
    'Self-described as flexible and observant when invested; admits to coasting on things she finds less interesting. Strong sense of direction toward Chemistry but career path within it is still open.',
  logistics: {
    timezone: 'Asia/Kolkata',
    language: 'en',
    devices: ['laptop', 'phone'],
    schedule_constraints: 'Not provided at intake.',
  },
  marksheet_paths: [],
};

/**
 * AI profile — what Worker 1 (profile builder) would produce after reading
 * the form. The approve endpoint refuses to flip the student to "active"
 * without this. Fields stay grounded in what Hetvika actually said.
 */
const aiProfile = {
  name: STUDENT_NAME,
  current_grade: STUDENT_GRADE,
  school: SCHOOL,
  city: CITY,
  curriculum: 'IGCSE Grade 11 → IBDP Grade 12',
  language_preference: 'en',

  subjects_current: [
    'Math AI HL',
    'Chemistry HL',
    'Biology HL',
    'Economics SL',
    'English SL',
    'Spanish AB SL',
  ],
  subjects_strong: ['Chemistry'],
  subjects_weak: [],

  // No subject-wise mark breakdown — only overall 75% over last 3 years.
  recent_academic_performance: '~75% overall across the last three years (no subject-wise data at intake).',

  target_major: 'Chemistry',
  target_universities: ['Imperial College London', 'USC'],
  target_countries: ['UK', 'USA'],
  exam_track: [],

  career_field: 'Chemistry (specific path TBD)',

  extracurriculars: [
    'Drums — 3 hrs/week for 4 years',
    'Volleyball — 2 hrs/week for 5 years',
  ],
  notable_projects: [
    'Head of Marketing for a hackathon',
    'Independent research paper',
    'Internship at a hydroponics company',
    'Crowd-funding initiative',
    'Passion project: water-quality in India',
  ],
  certifications: ['Coursera (multiple)', 'Volleyball competition awards'],

  motivations:
    'Driven by interest in chemistry and environmental/sustainability topics (gardening, hydroponics, water quality). Wants global academic exposure and opportunities abroad.',
  strengths:
    'Flexible and observant; high effort when personally invested in a project.',
  growth_areas:
    'Tends to coast on tasks she finds less engaging — may need external structure or framing to stay consistent on lower-interest subjects.',
  risk_flags: [
    'Selective engagement: quality drops sharply on tasks she finds uninteresting.',
    'Career path within Chemistry is unclear — needs guided exploration.',
  ],

  preferred_study_block_minutes: 60,
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
        // Reset back to pending_review and unclaim — approval re-runs cleanly.
        status: 'pending_review',
        counsellorId: null,
        // Also clear parent contacts so stale dummy parents don't linger.
        parentContacts: [],
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
        // Clear approval markers so the counsellor goes through the flow again.
        acceptedAt: null,
        acceptedBy: null,
        counsellorId: null,
        flagsForCounsellor: [],
      })
      .where(eq(studentProfileDrafts.id, latest.id));
    console.log(`Updated existing draft ${latest.id} (formResponses + profile reset)`);
  } else {
    const insertedDraft = await db
      .insert(studentProfileDrafts)
      .values({
        studentId: student.id,
        formResponses,
        profile: aiProfile,
        status: 'pending_review',
      })
      .returning({ id: studentProfileDrafts.id });
    console.log(`Inserted draft ${insertedDraft[0]!.id}`);
  }

  console.log('\nNext steps:');
  console.log('  1. Sign in as your counsellor (e.g. wallickglobalconsulting@gmail.com)');
  console.log('  2. Open /onboarding → Hetvika Rupani appears in the queue');
  console.log('  3. Click into her draft → review → Approve & activate');
  console.log('  4. From her /profile page → Import history from Spinach');
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
