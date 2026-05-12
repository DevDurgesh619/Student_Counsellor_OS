'use client';

import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { meApi, studentApi } from '@/lib/api';
import { getBrowserSupabase } from '@/lib/supabase';

type StudentProfile = {
  id: string;
  fullName: string;
  email: string | null;
  currentGrade: string;
  school: string | null;
  timezone: string;
  languagePreferences?: { primary: string; secondary?: string[] } | null;
  optOuts?: Record<string, boolean> | null;
};

export default function StudentSettingsPage() {
  const router = useRouter();
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({ queryKey: ['me'], queryFn: meApi.me });

  const profile = (data?.profile as StudentProfile | undefined) ?? null;

  const [language, setLanguage] = useState('en');
  const [noWeekendPing, setNoWeekendPing] = useState(false);
  const [timezone, setTimezone] = useState('Asia/Kolkata');

  useEffect(() => {
    if (!profile) return;
    setLanguage(profile.languagePreferences?.primary ?? 'en');
    setNoWeekendPing(Boolean(profile.optOuts?.no_weekend_ping));
    setTimezone(profile.timezone ?? 'Asia/Kolkata');
  }, [profile]);

  const save = useMutation({
    mutationFn: () =>
      studentApi.patchSettings({
        languagePreferences: { primary: language },
        optOuts: { no_weekend_ping: noWeekendPing },
        timezone,
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['me'] }),
  });

  async function logout() {
    await getBrowserSupabase().auth.signOut();
    router.replace('/login');
  }

  if (isLoading || !profile) return <p className="text-sm text-muted-foreground">Loading…</p>;

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold">Settings</h1>
      </header>

      <section className="space-y-2 rounded-lg border border-border bg-card p-4">
        <h2 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Profile
        </h2>
        <p className="text-sm">{profile.fullName}</p>
        <p className="text-xs text-muted-foreground">
          Grade {profile.currentGrade}
          {profile.school && ` · ${profile.school}`}
        </p>
        <p className="text-xs text-muted-foreground">{profile.email ?? '—'}</p>
        <p className="text-[11px] text-muted-foreground italic">
          Profile is managed by your counsellor.
        </p>
      </section>

      <section className="space-y-3 rounded-lg border border-border bg-card p-4">
        <h2 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Preferences
        </h2>
        <label className="block space-y-1 text-sm">
          <span>Language</span>
          <select
            value={language}
            onChange={(e) => setLanguage(e.target.value)}
            className="w-full rounded-md border border-input bg-background px-3 py-2"
          >
            <option value="en">English</option>
            <option value="hi">Hindi</option>
            <option value="ta">Tamil</option>
          </select>
        </label>
        <label className="block space-y-1 text-sm">
          <span>Timezone</span>
          <input
            value={timezone}
            onChange={(e) => setTimezone(e.target.value)}
            className="w-full rounded-md border border-input bg-background px-3 py-2"
          />
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={noWeekendPing}
            onChange={(e) => setNoWeekendPing(e.target.checked)}
          />
          Don't ping me on weekends
        </label>
        <button
          onClick={() => save.mutate()}
          disabled={save.isPending}
          className="w-full rounded-md bg-primary py-2 text-sm text-primary-foreground hover:opacity-90 disabled:opacity-60"
        >
          {save.isPending ? 'Saving…' : 'Save'}
        </button>
        {save.error && (
          <p className="text-xs text-destructive">{(save.error as Error).message}</p>
        )}
      </section>

      <button
        onClick={logout}
        className="w-full rounded-md border border-input py-2 text-sm hover:bg-muted"
      >
        Sign out
      </button>
    </div>
  );
}
