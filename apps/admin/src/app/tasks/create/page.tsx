'use client';

import { useForm } from '@refinedev/react-hook-form';
import { useList } from '@refinedev/core';
import { useSearchParams, useRouter } from 'next/navigation';
import { SUBJECTS } from '@wgc/shared';

type StudentRow = { id: string; full_name: string };

/**
 * Day-0 timetable creation. Single-task form for now; the "create a week of
 * tasks" wizard is a follow-up enhancement once we measure how operators use
 * this in practice. Recurrence is supported via `recurrence_pattern` on the
 * row (expanded in Phase 4 by the Calendar Sync cron — phase-1 §Edge Cases).
 */
export default function CreateTaskPage() {
  const router = useRouter();
  const params = useSearchParams();
  const presetStudentId = params.get('studentId') ?? '';

  const { data: studentsResp } = useList<StudentRow>({
    resource: 'students',
    pagination: { pageSize: 100 },
  });

  const { register, handleSubmit, refineCore, formState } = useForm({
    refineCoreProps: {
      resource: 'tasks',
      action: 'create',
      onMutationSuccess: () => router.push('/tasks'),
    },
    defaultValues: {
      student_id: presetStudentId,
      subject: 'Math',
      flexibility: 'preferred',
      source: 'counsellor_manual',
    },
  });

  return (
    <div className="max-w-2xl space-y-4">
      <h1 className="text-2xl font-semibold">New task</h1>
      <form
        onSubmit={handleSubmit(refineCore.onFinish)}
        className="space-y-4 rounded-lg border border-border p-4"
      >
        <Field label="Student">
          <select
            {...register('student_id', { required: true })}
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
          >
            <option value="">— select —</option>
            {studentsResp?.data.map((s) => (
              <option key={s.id} value={s.id}>
                {s.full_name}
              </option>
            ))}
          </select>
        </Field>

        <div className="grid grid-cols-2 gap-4">
          <Field label="Scheduled start">
            <input
              type="datetime-local"
              required
              {...register('scheduled_start', { required: true })}
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
            />
          </Field>
          <Field label="Scheduled end">
            <input
              type="datetime-local"
              required
              {...register('scheduled_end', { required: true })}
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
            />
          </Field>
        </div>

        <div className="grid grid-cols-2 gap-4">
          <Field label="Subject">
            <select
              {...register('subject', { required: true })}
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
            >
              {SUBJECTS.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Flexibility">
            <select
              {...register('flexibility')}
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
            >
              <option value="fixed">fixed</option>
              <option value="preferred">preferred</option>
              <option value="flexible">flexible</option>
            </select>
          </Field>
        </div>

        <Field label="Title">
          <input
            {...register('task_title', { required: true })}
            placeholder="Math: Chapter 4 Problems"
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
          />
        </Field>
        <Field label="Description (optional)">
          <textarea
            {...register('task_description')}
            rows={3}
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
          />
        </Field>
        <Field label="Expected output (optional)">
          <input
            {...register('expected_output')}
            placeholder="Photo of working in notebook"
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
          />
        </Field>
        <Field label="Recurrence pattern (optional)">
          <input
            {...register('recurrence_pattern')}
            placeholder="daily | weekdays | weekly_mwf"
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
          />
        </Field>

        <button
          type="submit"
          disabled={formState.isSubmitting}
          className="rounded-md bg-primary px-4 py-2 text-sm text-primary-foreground hover:opacity-90 disabled:opacity-60"
        >
          {formState.isSubmitting ? 'Saving…' : 'Create task'}
        </button>
      </form>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block space-y-1">
      <span className="text-xs uppercase tracking-wide text-muted-foreground">{label}</span>
      {children}
    </label>
  );
}
