'use client';

import { useState } from 'react';
import { useParams } from 'next/navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { counsellorApi } from '@/lib/api';
import { formatRelative } from '@/lib/utils';

type Session = {
  id: string;
  scheduledAt: string;
  durationMinutes: number | null;
  spinachSummaryText: string | null;
  status: string;
};

const Schema = z.object({
  scheduledAt: z.string().min(1),
  durationMinutes: z.coerce.number().int().positive().optional(),
  spinachSummaryText: z.string().optional(),
  status: z.enum(['scheduled', 'in_progress', 'completed', 'cancelled']).default('completed'),
});
type FormValues = z.infer<typeof Schema>;

export default function SessionsPage() {
  const params = useParams<{ id: string }>();
  const qc = useQueryClient();
  const [showForm, setShowForm] = useState(false);

  const { data, isLoading } = useQuery({
    queryKey: ['sessions', params.id],
    queryFn: () =>
      counsellorApi.studentSessions(params.id) as Promise<{ data: Session[] }>,
  });

  const create = useMutation({
    mutationFn: (body: FormValues) =>
      counsellorApi.createSession(params.id, {
        scheduledAt: new Date(body.scheduledAt).toISOString(),
        durationMinutes: body.durationMinutes,
        spinachSummaryText: body.spinachSummaryText,
        status: body.status,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['sessions', params.id] });
      setShowForm(false);
    },
  });

  const { register, handleSubmit, reset, formState } = useForm<FormValues>({
    resolver: zodResolver(Schema),
    defaultValues: { status: 'completed' },
  });

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-medium">Sessions</h2>
        <button
          onClick={() => setShowForm((v) => !v)}
          className="rounded-md bg-primary px-3 py-1.5 text-sm text-primary-foreground hover:opacity-90"
        >
          {showForm ? 'Close' : '+ Add session'}
        </button>
      </div>
      <p className="text-xs text-muted-foreground">
        Manual entry. Phase 6 wires Spinach so this becomes automatic.
      </p>

      {showForm && (
        <form
          onSubmit={handleSubmit(async (v) => {
            await create.mutateAsync(v);
            reset();
          })}
          className="space-y-3 rounded-lg border border-border bg-card p-4"
        >
          <div className="grid grid-cols-3 gap-3">
            <Field label="When">
              <input
                type="datetime-local"
                {...register('scheduledAt')}
                className="w-full rounded-md border border-input bg-background px-2 py-1.5 text-sm"
              />
            </Field>
            <Field label="Duration (min)">
              <input
                type="number"
                {...register('durationMinutes')}
                className="w-full rounded-md border border-input bg-background px-2 py-1.5 text-sm"
              />
            </Field>
            <Field label="Status">
              <select
                {...register('status')}
                className="w-full rounded-md border border-input bg-background px-2 py-1.5 text-sm"
              >
                <option value="scheduled">scheduled</option>
                <option value="in_progress">in_progress</option>
                <option value="completed">completed</option>
                <option value="cancelled">cancelled</option>
              </select>
            </Field>
          </div>
          <Field label="Summary / action items">
            <textarea
              rows={4}
              placeholder="What was discussed; decisions; action items"
              {...register('spinachSummaryText')}
              className="w-full rounded-md border border-input bg-background px-2 py-1.5 text-sm"
            />
          </Field>
          <div className="flex justify-end">
            <button
              type="submit"
              disabled={formState.isSubmitting}
              className="rounded-md bg-primary px-4 py-1.5 text-sm text-primary-foreground hover:opacity-90 disabled:opacity-60"
            >
              {formState.isSubmitting ? 'Saving…' : 'Save session'}
            </button>
          </div>
        </form>
      )}

      {isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}
      <ul className="space-y-2">
        {(data?.data ?? []).map((s) => (
          <li key={s.id} className="rounded-lg border border-border bg-card p-3">
            <div className="flex items-baseline justify-between">
              <span className="font-medium">
                {new Date(s.scheduledAt).toLocaleString()}
                {s.durationMinutes ? ` · ${s.durationMinutes} min` : ''}
              </span>
              <span className="rounded bg-muted px-2 py-0.5 text-xs">{s.status}</span>
            </div>
            {s.spinachSummaryText && (
              <p className="mt-2 whitespace-pre-line text-sm text-muted-foreground">
                {s.spinachSummaryText}
              </p>
            )}
            <p className="mt-1 text-xs text-muted-foreground">{formatRelative(s.scheduledAt)}</p>
          </li>
        ))}
      </ul>
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
