'use client';

import { useRouter } from 'next/navigation';
import { useForm } from '@refinedev/react-hook-form';
import { useList } from '@refinedev/core';

type CounsellorOption = { id: string; full_name: string };

/**
 * Day-0 student creation. After saving, the operator is encouraged to navigate
 * to /tasks/create with this student preselected to lay down the starter
 * timetable manually — Worker 4 only kicks in from session 1 onward
 * (clarifications.md Q4).
 */
export default function CreateStudentPage() {
  const router = useRouter();
  const { register, handleSubmit, refineCore, formState } = useForm({
    refineCoreProps: {
      resource: 'students',
      action: 'create',
      onMutationSuccess: (data) => {
        const id = (data?.data as { id: string }).id;
        router.push(`/tasks/create?studentId=${id}`);
      },
    },
  });

  const { data: counsellorsResp } = useList<CounsellorOption>({
    resource: 'counsellors',
    pagination: { pageSize: 100 },
  });

  return (
    <div className="max-w-2xl space-y-4">
      <header>
        <h1 className="text-2xl font-semibold">New student</h1>
        <p className="text-sm text-muted-foreground">
          Day-0 onboarding. Goal: profile + counsellor assignment in under 30 minutes
          (Phase 1 DoD #4).
        </p>
      </header>

      <form
        onSubmit={handleSubmit(refineCore.onFinish)}
        className="space-y-4 rounded-lg border border-border p-4"
      >
        <Field label="Full name">
          <input
            {...register('full_name', { required: true })}
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
          />
        </Field>
        <Field label="Phone">
          <input
            {...register('phone', { required: true })}
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
          />
        </Field>
        <Field label="Email (optional)">
          <input
            type="email"
            {...register('email')}
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
          />
        </Field>
        <div className="grid grid-cols-2 gap-4">
          <Field label="Grade">
            <input
              {...register('current_grade', { required: true })}
              placeholder="10 IGCSE"
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
            />
          </Field>
          <Field label="School">
            <input
              {...register('school')}
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
            />
          </Field>
        </div>
        <Field label="Counsellor">
          <select
            {...register('counsellor_id', { required: true })}
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
          >
            <option value="">— select —</option>
            {counsellorsResp?.data.map((c) => (
              <option key={c.id} value={c.id}>
                {c.full_name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Context tag">
          <select
            {...register('current_context_tag')}
            defaultValue="school_term"
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
          >
            <option value="school_term">school_term</option>
            <option value="summer">summer</option>
            <option value="exam_prep">exam_prep</option>
            <option value="holiday">holiday</option>
          </select>
        </Field>

        <div className="flex justify-end gap-2 pt-2">
          <button
            type="submit"
            disabled={formState.isSubmitting}
            className="rounded-md bg-primary px-4 py-2 text-sm text-primary-foreground hover:opacity-90 disabled:opacity-60"
          >
            {formState.isSubmitting ? 'Saving…' : 'Save → create starter timetable'}
          </button>
        </div>
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
