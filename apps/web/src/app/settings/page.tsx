'use client';

import { useEffect } from 'react';
import { useSearchParams } from 'next/navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { counsellorApi } from '@/lib/api';

type Counsellor = {
  id: string;
  fullName: string;
  email: string;
  phone: string | null;
  timezone: string;
  workingHours: Record<string, [string, string]> | null;
  notificationPreferences: Record<string, unknown> | null;
};

const DAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'] as const;

const Schema = z.object({
  timezone: z.string().min(1),
  monday: z.tuple([z.string(), z.string()]).optional(),
  tuesday: z.tuple([z.string(), z.string()]).optional(),
  wednesday: z.tuple([z.string(), z.string()]).optional(),
  thursday: z.tuple([z.string(), z.string()]).optional(),
  friday: z.tuple([z.string(), z.string()]).optional(),
  saturday: z.tuple([z.string(), z.string()]).optional(),
  sunday: z.tuple([z.string(), z.string()]).optional(),
  emailNotifications: z.boolean(),
});
type FormValues = z.infer<typeof Schema>;

export default function SettingsPage() {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: ['counsellor-me'],
    queryFn: () => counsellorApi.me() as Promise<Counsellor>,
  });

  const { register, handleSubmit, reset, formState } = useForm<FormValues>({
    resolver: zodResolver(Schema),
    defaultValues: { timezone: 'Asia/Kolkata', emailNotifications: true },
  });

  useEffect(() => {
    if (!data) return;
    reset({
      timezone: data.timezone,
      ...Object.fromEntries(
        DAYS.map((d) => [d, data.workingHours?.[d] ?? undefined]),
      ),
      emailNotifications:
        (data.notificationPreferences?.email_notifications as boolean | undefined) ?? true,
    } as FormValues);
  }, [data, reset]);

  const save = useMutation({
    mutationFn: async (values: FormValues) => {
      const workingHours: Record<string, [string, string]> = {};
      for (const d of DAYS) {
        const v = values[d];
        if (v && v[0] && v[1]) workingHours[d] = v;
      }
      return counsellorApi.patchSettings({
        timezone: values.timezone,
        workingHours,
        notificationPreferences: { email_notifications: values.emailNotifications },
      });
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['counsellor-me'] }),
  });

  if (isLoading) return <p className="text-sm text-muted-foreground">Loading…</p>;
  if (!data) return null;

  return (
    <div className="max-w-2xl space-y-6">
      <header>
        <h1 className="text-2xl font-semibold">Settings</h1>
        <p className="text-sm text-muted-foreground">
          {data.fullName} · {data.email}
        </p>
      </header>

      <form
        onSubmit={handleSubmit((v) => save.mutate(v))}
        className="space-y-6 rounded-lg border border-border bg-card p-4"
      >
        <section className="space-y-3">
          <h2 className="text-sm font-medium uppercase tracking-wide text-muted-foreground">
            Timezone
          </h2>
          <input
            {...register('timezone')}
            className="w-full max-w-xs rounded-md border border-input bg-background px-2 py-1.5 text-sm"
          />
        </section>

        <section className="space-y-3">
          <h2 className="text-sm font-medium uppercase tracking-wide text-muted-foreground">
            Working hours
          </h2>
          <p className="text-xs text-muted-foreground">
            Leave a day blank to mark it as off.
          </p>
          <div className="space-y-2">
            {DAYS.map((d) => (
              <div key={d} className="flex items-center gap-2">
                <span className="w-24 text-sm capitalize">{d}</span>
                <input
                  type="time"
                  {...register(`${d}.0` as `monday.0`)}
                  className="rounded-md border border-input bg-background px-2 py-1 text-sm"
                />
                <span className="text-muted-foreground">–</span>
                <input
                  type="time"
                  {...register(`${d}.1` as `monday.1`)}
                  className="rounded-md border border-input bg-background px-2 py-1 text-sm"
                />
              </div>
            ))}
          </div>
        </section>

        <section className="space-y-3">
          <h2 className="text-sm font-medium uppercase tracking-wide text-muted-foreground">
            Notifications
          </h2>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" {...register('emailNotifications')} />
            Email me when a change request comes in (Phase 8 wires real sending; flag persists now)
          </label>
        </section>

        <div className="flex justify-end">
          <button
            type="submit"
            disabled={formState.isSubmitting || save.isPending}
            className="rounded-md bg-primary px-4 py-1.5 text-sm text-primary-foreground hover:opacity-90 disabled:opacity-60"
          >
            {save.isPending ? 'Saving…' : 'Save settings'}
          </button>
        </div>
      </form>

      <SpinachSection />
    </div>
  );
}

function SpinachSection() {
  const qc = useQueryClient();
  const params = useSearchParams();
  const spinachParam = params.get('spinach');

  const { data } = useQuery({
    queryKey: ['spinach-status'],
    queryFn: () => counsellorApi.spinachStatus(),
    refetchInterval: 30_000,
  });

  const setupUrl = useMutation({
    mutationFn: () => counsellorApi.spinachSetupUrl(),
    onSuccess: (res) => {
      if (res?.url) window.location.href = res.url;
    },
  });

  const disconnect = useMutation({
    mutationFn: () => counsellorApi.disconnectSpinach(),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['spinach-status'] }),
  });

  const pollNow = useMutation({
    mutationFn: () => counsellorApi.pollSpinachNow(),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['spinach-status'] }),
  });

  const state = data?.data?.state ?? 'disconnected';
  const lastSyncedAt = data?.data?.lastSyncedAt;

  return (
    <section className="space-y-3 rounded-lg border border-border bg-card p-4">
      <header>
        <h2 className="text-sm font-medium uppercase tracking-wide text-muted-foreground">
          Spinach (meeting transcripts)
        </h2>
        <p className="text-xs text-muted-foreground">
          Connect your Spinach account once. Every 5 min we pull finished
          meetings, match them to a student by attendee email, and run the
          post-session pipeline automatically.
        </p>
      </header>

      {spinachParam === 'connected' && (
        <p className="rounded-md border border-success/40 bg-success/10 px-3 py-2 text-xs">
          Spinach connected. The first poll runs within 5 minutes.
        </p>
      )}
      {spinachParam === 'error' && (
        <p className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs">
          Spinach connection failed: {params.get('reason') ?? 'unknown error'}
        </p>
      )}

      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span>
          Status: <span className="font-medium">{state}</span>
        </span>
        {lastSyncedAt && (
          <span className="text-xs text-muted-foreground">
            · last synced {new Date(lastSyncedAt).toLocaleString()}
          </span>
        )}
      </div>

      <div className="flex flex-wrap gap-2">
        {state !== 'connected' && (
          <button
            onClick={() => setupUrl.mutate()}
            disabled={setupUrl.isPending}
            className="rounded-md bg-primary px-3 py-1.5 text-sm text-primary-foreground hover:opacity-90 disabled:opacity-60"
          >
            {setupUrl.isPending ? 'Opening…' : 'Connect Spinach'}
          </button>
        )}
        {state === 'connected' && (
          <>
            <button
              onClick={() => pollNow.mutate()}
              disabled={pollNow.isPending}
              className="rounded-md border border-border px-3 py-1.5 text-sm hover:bg-muted disabled:opacity-60"
            >
              {pollNow.isPending ? 'Syncing…' : 'Sync now'}
            </button>
            <button
              onClick={() => disconnect.mutate()}
              disabled={disconnect.isPending}
              className="rounded-md border border-border px-3 py-1.5 text-sm hover:bg-muted disabled:opacity-60"
            >
              Disconnect
            </button>
          </>
        )}
      </div>

      {pollNow.isError && (
        <p className="text-xs text-destructive">
          Sync failed: {(pollNow.error as Error).message}
        </p>
      )}
      {pollNow.data?.data && (
        <p className="text-xs text-muted-foreground">
          Last manual sync: {pollNow.data.data.meetingsFetched} new meetings ·{' '}
          {pollNow.data.data.sessionsCreated} linked · {pollNow.data.data.unassigned}{' '}
          unassigned
        </p>
      )}
    </section>
  );
}
