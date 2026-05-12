'use client';

import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { SUBJECTS, SubjectSchema, TaskFlexibilitySchema } from '@wgc/shared';
import { counsellorApi, taskApi } from '@/lib/api';

const Schema = z.object({
  scheduledStart: z.string().min(1),
  scheduledEnd: z.string().min(1),
  subject: SubjectSchema,
  taskTitle: z.string().min(1),
  taskDescription: z.string().optional(),
  expectedOutput: z.string().optional(),
  flexibility: TaskFlexibilitySchema.default('preferred'),
  recurrence: z.enum(['none', 'daily', 'weekdays', 'weekly']).default('none'),
});
type FormValues = z.infer<typeof Schema>;

function isoLocal(d: Date): string {
  const pad = (n: number) => n.toString().padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function TaskCreateForm({
  studentId,
  defaultStart,
  onCreated,
}: {
  studentId: string;
  defaultStart?: Date;
  onCreated?: () => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const startDate = defaultStart ?? new Date();
  const start = new Date(startDate);
  start.setHours(17, 0, 0, 0); // sensible default: 5 PM
  const end = new Date(start.getTime() + 30 * 60_000);

  const { register, handleSubmit, formState, watch } = useForm<FormValues>({
    resolver: zodResolver(Schema),
    defaultValues: {
      scheduledStart: isoLocal(start),
      scheduledEnd: isoLocal(end),
      subject: 'Math',
      taskTitle: '',
      flexibility: 'preferred',
      recurrence: 'none',
    },
  });

  const recurrence = watch('recurrence');

  async function onSubmit(values: FormValues) {
    setError(null);
    try {
      const body = {
        studentId,
        scheduledStart: new Date(values.scheduledStart).toISOString(),
        scheduledEnd: new Date(values.scheduledEnd).toISOString(),
        subject: values.subject,
        taskTitle: values.taskTitle,
        taskDescription: values.taskDescription || undefined,
        expectedOutput: values.expectedOutput || undefined,
        flexibility: values.flexibility,
        source: 'counsellor_manual' as const,
      };
      if (values.recurrence === 'none') {
        await taskApi.create(body);
      } else {
        await counsellorApi.createRecurringTasks({
          ...body,
          pattern: values.recurrence,
          weeksAhead: 4,
        });
      }
      onCreated?.();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <form
      onSubmit={handleSubmit(onSubmit)}
      className="space-y-3 rounded-lg border border-border bg-card p-4"
    >
      <div className="grid grid-cols-2 gap-3">
        <Field label="Start">
          <input
            type="datetime-local"
            {...register('scheduledStart')}
            className="w-full rounded-md border border-input bg-background px-2 py-1.5 text-sm"
          />
        </Field>
        <Field label="End">
          <input
            type="datetime-local"
            {...register('scheduledEnd')}
            className="w-full rounded-md border border-input bg-background px-2 py-1.5 text-sm"
          />
        </Field>
      </div>
      <div className="grid grid-cols-3 gap-3">
        <Field label="Subject">
          <select
            {...register('subject')}
            className="w-full rounded-md border border-input bg-background px-2 py-1.5 text-sm"
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
            className="w-full rounded-md border border-input bg-background px-2 py-1.5 text-sm"
          >
            <option value="fixed">fixed</option>
            <option value="preferred">preferred</option>
            <option value="flexible">flexible</option>
          </select>
        </Field>
        <Field label="Recurrence">
          <select
            {...register('recurrence')}
            className="w-full rounded-md border border-input bg-background px-2 py-1.5 text-sm"
          >
            <option value="none">one-off</option>
            <option value="daily">daily (4 weeks)</option>
            <option value="weekdays">weekdays (4 weeks)</option>
            <option value="weekly">weekly same day (4 weeks)</option>
          </select>
        </Field>
      </div>
      <Field label="Title">
        <input
          {...register('taskTitle')}
          placeholder="Math: Chapter 4 Problems"
          className="w-full rounded-md border border-input bg-background px-2 py-1.5 text-sm"
        />
      </Field>
      <Field label="Description (optional)">
        <textarea
          rows={2}
          {...register('taskDescription')}
          className="w-full rounded-md border border-input bg-background px-2 py-1.5 text-sm"
        />
      </Field>
      <Field label="Expected output (optional)">
        <input
          {...register('expectedOutput')}
          placeholder="Photo of working in notebook"
          className="w-full rounded-md border border-input bg-background px-2 py-1.5 text-sm"
        />
      </Field>

      {error && <p className="text-sm text-destructive">{error}</p>}
      <div className="flex justify-end">
        <button
          type="submit"
          disabled={formState.isSubmitting}
          className="rounded-md bg-primary px-4 py-1.5 text-sm text-primary-foreground hover:opacity-90 disabled:opacity-60"
        >
          {formState.isSubmitting
            ? 'Saving…'
            : recurrence === 'none'
              ? 'Create task'
              : 'Create recurring series'}
        </button>
      </div>
    </form>
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
