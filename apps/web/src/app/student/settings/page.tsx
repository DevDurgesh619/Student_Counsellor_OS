'use client';

import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { meApi, studentApi } from '@/lib/api';
import { getBrowserSupabase } from '@/lib/supabase';

// Curated list — the full IANA set is ~400 entries; pick the ones an Indian
// product is realistically going to encounter. Free-form input had no
// validation and a typo silently saved.
const TIMEZONE_OPTIONS = [
  'Asia/Kolkata',
  'Asia/Dubai',
  'Asia/Singapore',
  'Asia/Tokyo',
  'Europe/London',
  'Europe/Berlin',
  'America/New_York',
  'America/Los_Angeles',
  'Australia/Sydney',
];

function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

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
  const [justSaved, setJustSaved] = useState(false);

  useEffect(() => {
    if (!profile) return;
    setLanguage(profile.languagePreferences?.primary ?? 'en');
    setNoWeekendPing(Boolean(profile.optOuts?.no_weekend_ping));
    setTimezone(profile.timezone ?? 'Asia/Kolkata');
  }, [profile]);

  const timezoneInvalid = !isValidTimezone(timezone);

  const save = useMutation({
    mutationFn: () =>
      studentApi.patchSettings({
        languagePreferences: { primary: language },
        optOuts: { no_weekend_ping: noWeekendPing },
        timezone,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['me'] });
      setJustSaved(true);
    },
  });
  useEffect(() => {
    if (!justSaved) return;
    const t = setTimeout(() => setJustSaved(false), 2500);
    return () => clearTimeout(t);
  }, [justSaved]);

  async function logout() {
    try {
      await getBrowserSupabase().auth.signOut();
    } catch {
      // best-effort; the cookie may already be gone — proceed to /login anyway
    }
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
            list="tz-options"
            onChange={(e) => setTimezone(e.target.value)}
            className={`w-full rounded-md border bg-background px-3 py-2 ${
              timezoneInvalid ? 'border-destructive' : 'border-input'
            }`}
          />
          <datalist id="tz-options">
            {TIMEZONE_OPTIONS.map((tz) => (
              <option key={tz} value={tz} />
            ))}
          </datalist>
          {timezoneInvalid && (
            <span className="text-xs text-destructive">Not a valid IANA timezone.</span>
          )}
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
          disabled={save.isPending || timezoneInvalid}
          className="w-full rounded-md bg-primary py-2 text-sm text-primary-foreground hover:opacity-90 disabled:opacity-60"
        >
          {save.isPending ? 'Saving…' : 'Save'}
        </button>
        {save.error && (
          <p className="text-xs text-destructive">{(save.error as Error).message}</p>
        )}
        {justSaved && <p className="text-xs text-success">Saved.</p>}
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
