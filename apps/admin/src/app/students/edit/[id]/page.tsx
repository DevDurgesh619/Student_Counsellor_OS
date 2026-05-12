'use client';

import { useForm } from '@refinedev/react-hook-form';
import { useParams } from 'next/navigation';

export default function EditStudentPage() {
  const params = useParams<{ id: string }>();
  const { register, handleSubmit, refineCore, formState } = useForm({
    refineCoreProps: {
      resource: 'students',
      id: params.id,
      action: 'edit',
    },
  });

  return (
    <div className="max-w-2xl space-y-4">
      <h1 className="text-2xl font-semibold">Edit student</h1>
      <form
        onSubmit={handleSubmit(refineCore.onFinish)}
        className="space-y-4 rounded-lg border border-border p-4"
      >
        <Field label="Full name">
          <input
            {...register('full_name')}
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
          />
        </Field>
        <Field label="Grade">
          <input
            {...register('current_grade')}
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
          />
        </Field>
        <Field label="Status">
          <select
            {...register('status')}
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
          >
            <option value="active">active</option>
            <option value="paused">paused</option>
            <option value="archived">archived</option>
          </select>
        </Field>
        <button
          type="submit"
          disabled={formState.isSubmitting}
          className="rounded-md bg-primary px-4 py-2 text-sm text-primary-foreground hover:opacity-90 disabled:opacity-60"
        >
          {formState.isSubmitting ? 'Saving…' : 'Save changes'}
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
