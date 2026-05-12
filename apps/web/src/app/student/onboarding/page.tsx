'use client';

import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { meApi, myOnboardingApi } from '@/lib/api';
import { getBrowserSupabase } from '@/lib/supabase';

type FormState = {
  basic_info: {
    full_name: string;
    grade: string;
    school: string;
    date_of_birth: string;
    phone: string;
    email: string;
  };
  parent_info: Array<{
    name: string;
    relationship: 'father' | 'mother' | 'guardian' | 'other';
    phone: string;
    email: string;
  }>;
  academic_background: string;
  goals: string;
  self_reflection: string;
  logistics: {
    timezone: string;
    language: string;
    devices: string[];
    schedule_constraints: string;
  };
  marksheet_paths: string[];
};

const empty = (): FormState => ({
  basic_info: { full_name: '', grade: '10', school: '', date_of_birth: '', phone: '', email: '' },
  parent_info: [],
  academic_background: '',
  goals: '',
  self_reflection: '',
  logistics: { timezone: 'Asia/Kolkata', language: 'en', devices: [], schedule_constraints: '' },
  marksheet_paths: [],
});

export default function StudentOnboardingPage() {
  const qc = useQueryClient();
  const { data: me, isLoading: meLoading } = useQuery({ queryKey: ['me'], queryFn: meApi.me });
  const { data: existing, isLoading: draftLoading } = useQuery({
    queryKey: ['my-onboarding'],
    queryFn: () => myOnboardingApi.current(),
    enabled: Boolean(me),
  });

  const [form, setForm] = useState<FormState>(empty);
  const [seeded, setSeeded] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);

  // Seed form from server (existing draft and Google profile name/email).
  useEffect(() => {
    if (seeded) return;
    if (meLoading || draftLoading) return;
    const next = empty();
    if (me?.profile?.email) next.basic_info.email = me.profile.email;
    if (me?.profile?.fullName) next.basic_info.full_name = me.profile.fullName as string;
    const draftResponses =
      (existing?.data?.formResponses as Partial<FormState> | null | undefined) ?? null;
    if (draftResponses) {
      Object.assign(next.basic_info, draftResponses.basic_info ?? {});
      if (draftResponses.parent_info) next.parent_info = draftResponses.parent_info as FormState['parent_info'];
      if (draftResponses.academic_background) next.academic_background = draftResponses.academic_background;
      if (draftResponses.goals) next.goals = draftResponses.goals;
      if (draftResponses.self_reflection) next.self_reflection = draftResponses.self_reflection;
      if (draftResponses.logistics) Object.assign(next.logistics, draftResponses.logistics);
      if (draftResponses.marksheet_paths) next.marksheet_paths = draftResponses.marksheet_paths;
    }
    setForm(next);
    setSeeded(true);
  }, [me, existing, meLoading, draftLoading, seeded]);

  const submit = useMutation({
    mutationFn: () => myOnboardingApi.submit(form as unknown as Record<string, unknown>),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['my-onboarding'] });
      qc.invalidateQueries({ queryKey: ['me'] });
    },
  });

  const autosave = useMutation({
    mutationFn: () => myOnboardingApi.autosave(form as unknown as Record<string, unknown>),
  });

  async function logout() {
    await getBrowserSupabase().auth.signOut();
    window.location.href = '/login';
  }

  async function uploadMarksheet(file: File) {
    setUploadError(null);
    try {
      const { uploadUrl, storagePath, token } = await myOnboardingApi.signedUploadUrl({
        filename: file.name,
        contentType: file.type || 'application/octet-stream',
        sizeBytes: file.size,
      });
      // Supabase signed PUT.
      const res = await fetch(uploadUrl, {
        method: 'PUT',
        headers: {
          'Content-Type': file.type || 'application/octet-stream',
          Authorization: `Bearer ${token}`,
        },
        body: file,
      });
      if (!res.ok) throw new Error(`upload failed (${res.status})`);
      setForm((f) => ({ ...f, marksheet_paths: [...f.marksheet_paths, storagePath] }));
    } catch (e) {
      setUploadError((e as Error).message);
    }
  }

  if (meLoading || draftLoading) {
    return <p className="text-sm text-muted-foreground">Loading…</p>;
  }

  const submitted = me?.state === 'pending_review';
  const archived = me?.state === 'archived';

  if (archived) {
    return (
      <div className="space-y-4 text-center">
        <h1 className="text-2xl font-semibold">Account archived</h1>
        <p className="text-sm text-muted-foreground">
          A counsellor archived this account. If you think that's a mistake, contact your counsellor.
        </p>
        <button
          onClick={logout}
          className="rounded-md border border-border px-3 py-1.5 text-sm hover:bg-muted"
        >
          Sign out
        </button>
      </div>
    );
  }

  if (submitted) {
    return (
      <div className="space-y-4 text-center">
        <h1 className="text-2xl font-semibold">Thanks — we received your form</h1>
        <p className="text-sm text-muted-foreground">
          Your counsellor is reviewing it. You'll see your dashboard here once approved.
          Refresh this page after they get back to you.
        </p>
        <button
          onClick={logout}
          className="rounded-md border border-border px-3 py-1.5 text-sm hover:bg-muted"
        >
          Sign out
        </button>
      </div>
    );
  }

  return (
    <form
      className="space-y-6"
      onSubmit={(e) => {
        e.preventDefault();
        submit.mutate();
      }}
    >
      <header>
        <h1 className="text-2xl font-semibold">Welcome — tell us about yourself</h1>
        <p className="text-sm text-muted-foreground">
          Your counsellor will review your responses and give you access to the dashboard.
        </p>
      </header>

      <Section title="Basics">
        <Field label="Full name" value={form.basic_info.full_name} onChange={(v) => updateBasic('full_name', v)} required />
        <Field label="Grade" value={form.basic_info.grade} onChange={(v) => updateBasic('grade', v)} required />
        <Field label="School" value={form.basic_info.school} onChange={(v) => updateBasic('school', v)} />
        <Field label="Phone" value={form.basic_info.phone} onChange={(v) => updateBasic('phone', v)} />
        <Field label="Email (Google account)" value={form.basic_info.email} onChange={() => undefined} readOnly />
      </Section>

      <Section title="Parents / guardians">
        {form.parent_info.map((p, i) => (
          <div key={i} className="rounded-lg border border-border p-3 space-y-2">
            <Field label="Name" value={p.name} onChange={(v) => updateParent(i, { name: v })} />
            <label className="block text-xs">
              Relationship
              <select
                value={p.relationship}
                onChange={(e) =>
                  updateParent(i, { relationship: e.target.value as FormState['parent_info'][number]['relationship'] })
                }
                className="mt-1 w-full rounded-md border border-input bg-background px-2 py-1.5 text-sm"
              >
                <option value="father">father</option>
                <option value="mother">mother</option>
                <option value="guardian">guardian</option>
                <option value="other">other</option>
              </select>
            </label>
            <Field label="Phone" value={p.phone} onChange={(v) => updateParent(i, { phone: v })} />
            <Field label="Email" value={p.email} onChange={(v) => updateParent(i, { email: v })} />
            <button
              type="button"
              onClick={() => setForm((f) => ({ ...f, parent_info: f.parent_info.filter((_, j) => j !== i) }))}
              className="text-xs text-destructive underline"
            >
              Remove
            </button>
          </div>
        ))}
        <button
          type="button"
          onClick={() =>
            setForm((f) => ({
              ...f,
              parent_info: [...f.parent_info, { name: '', relationship: 'mother', phone: '', email: '' }],
            }))
          }
          className="rounded-md border border-dashed border-border px-3 py-1.5 text-sm text-muted-foreground hover:bg-muted"
        >
          + Add parent
        </button>
      </Section>

      <Section title="Academic background">
        <textarea
          value={form.academic_background}
          onChange={(e) => setForm((f) => ({ ...f, academic_background: e.target.value }))}
          rows={3}
          placeholder="Recent grades, subjects you've struggled with, what you do well in..."
          className="w-full rounded-md border border-input bg-background px-2 py-1.5 text-sm"
        />
      </Section>

      <Section title="Goals">
        <textarea
          value={form.goals}
          onChange={(e) => setForm((f) => ({ ...f, goals: e.target.value }))}
          rows={2}
          placeholder="What do you want to get out of this?"
          className="w-full rounded-md border border-input bg-background px-2 py-1.5 text-sm"
        />
      </Section>

      <Section title="Self reflection">
        <textarea
          value={form.self_reflection}
          onChange={(e) => setForm((f) => ({ ...f, self_reflection: e.target.value }))}
          rows={3}
          placeholder="What gets in your way? When do you study best?"
          className="w-full rounded-md border border-input bg-background px-2 py-1.5 text-sm"
        />
      </Section>

      <Section title="Marksheets (optional)">
        <p className="text-xs text-muted-foreground">
          Upload PDFs or photos of your latest report cards. We OCR them so your counsellor sees the data alongside your answers.
        </p>
        <input
          type="file"
          multiple
          accept="image/*,application/pdf"
          onChange={async (e) => {
            const files = Array.from(e.currentTarget.files ?? []);
            for (const f of files) await uploadMarksheet(f);
            e.currentTarget.value = '';
          }}
          className="text-sm"
        />
        {uploadError && <p className="text-xs text-destructive">{uploadError}</p>}
        {form.marksheet_paths.length > 0 && (
          <ul className="text-xs text-muted-foreground">
            {form.marksheet_paths.map((p) => (
              <li key={p}>✓ {p.split('/').pop()}</li>
            ))}
          </ul>
        )}
      </Section>

      <div className="sticky bottom-2 flex items-center justify-between gap-2 rounded-lg border border-border bg-card p-3 shadow-sm">
        <button
          type="button"
          onClick={() => autosave.mutate()}
          disabled={autosave.isPending}
          className="rounded-md border border-border px-3 py-1.5 text-sm hover:bg-muted disabled:opacity-60"
        >
          {autosave.isPending ? 'Saving…' : 'Save progress'}
        </button>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={logout}
            className="rounded-md border border-border px-3 py-1.5 text-sm hover:bg-muted"
          >
            Sign out
          </button>
          <button
            type="submit"
            disabled={submit.isPending}
            className="rounded-md bg-primary px-4 py-1.5 text-sm text-primary-foreground hover:opacity-90 disabled:opacity-60"
          >
            {submit.isPending ? 'Submitting…' : 'Submit for review'}
          </button>
        </div>
      </div>

      {submit.isError && (
        <p className="text-sm text-destructive">
          Submit failed: {(submit.error as Error).message}
        </p>
      )}
    </form>
  );

  function updateBasic<K extends keyof FormState['basic_info']>(
    key: K,
    value: FormState['basic_info'][K],
  ) {
    setForm((f) => ({ ...f, basic_info: { ...f.basic_info, [key]: value } }));
  }
  function updateParent(idx: number, patch: Partial<FormState['parent_info'][number]>) {
    setForm((f) => ({
      ...f,
      parent_info: f.parent_info.map((p, i) => (i === idx ? { ...p, ...patch } : p)),
    }));
  }
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-2 rounded-lg border border-border bg-card p-4">
      <h2 className="text-sm font-medium uppercase tracking-wide text-muted-foreground">{title}</h2>
      <div className="space-y-2">{children}</div>
    </section>
  );
}

function Field({
  label,
  value,
  onChange,
  required,
  readOnly,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  required?: boolean;
  readOnly?: boolean;
}) {
  return (
    <label className="block text-xs">
      {label}
      {required && <span className="ml-1 text-destructive">*</span>}
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        required={required}
        readOnly={readOnly}
        className={`mt-1 w-full rounded-md border border-input px-2 py-1.5 text-sm ${
          readOnly ? 'bg-muted text-muted-foreground' : 'bg-background'
        }`}
      />
    </label>
  );
}
